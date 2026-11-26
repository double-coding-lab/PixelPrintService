import { consumeRunGuidance } from '../session/queue';
import { createRunScreenshotWriter } from './screenshots';
import { createPreviewInspection } from '../preview/inspection';
import type { PreviewService } from '../preview/service';
import { resolveAttachmentImages } from '../session/attachments';
import { redactPartialText } from './agent/textStream';
import { toolIssue, ToolIssue } from './toolFeedback';
import { assetUrl } from '../utils/assetUrls';
import { isImageFileName } from '../utils/imageObjectName';
import { createImageDirectories, imageDirectoriesPath } from './imageDirectories';
import type { WorkspaceConfigs } from '../utils/config';
import { randomUUID } from 'node:crypto';
import type { D2cRuntimeConfig } from '@/config/d2c';
import type { StorageFileClient } from '@/hooks/tools/storage';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Sequelize } from 'sequelize';
import { createModelCredentialService } from '../credential/model';
import { isExternalUserId } from '@/common/userIdentity';
import { createFigmaCredentialService } from '../credential/service';
import { SessionError } from '../session/access';
import type { ResourceBundleStore } from '../workspace/resources';
import { runDeepGeneration } from './agent/run';
import { createRunCheckpointSaver } from './agent/checkpoint';
import {
  executionError,
  RunExecutionError,
  StorageOperationError,
  type FailureCode,
  type FailureStage,
} from './errors';
import { createGenerationInstructions } from './instructions';
import { createRunLeases, type RunLease } from './leases';
import { createRunPersistence } from './persistence';
import { createGenerationTools } from './tools';
import { restoreExecutionWorkspace } from './workspace';

/**
 * 执行一个已领取轮次：读取固定输入、恢复临时工作区、运行 SDK，再保存校验并结算。
 * 生命周期由 Worker、续租和本轮超时控制，浏览器断线不影响后台执行。
 *
 * @param input 已领取租约及数据库、固定资源、二进制存储等运行依赖。
 * @returns 成功结算后完成；失败向 Worker 抛出，由 Worker 尝试结算失败或中断。
 */
export async function executeGenerationRun(input: {
  mysql: Sequelize;
  preview?: PreviewService;
  leases: ReturnType<typeof createRunLeases>;
  lease: RunLease;
  config: D2cRuntimeConfig;
  store: Pick<ResourceBundleStore, 'load'>;
  binary: StorageFileClient;
  proxyUrl: string;
  signal: AbortSignal;
  notify: (id: string, seq: number) => void;
  testModel?: BaseChatModel;
  testToken?: () => Promise<string>;
}) {
  const { config, leases, lease } = input;
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  /** 只添加可信分类，底层异常和已有类型上下文通过 cause 保留在内存。 */
  async function boundary<T>(
    code: FailureCode,
    stage: FailureStage,
    action: () => Promise<T>,
    storage?: { operation: 'upload' | 'write_binary' | 'write_text'; path: string; bytes: number },
  ) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ToolIssue) throw error;
      if (error instanceof SessionError && error.reason === 'LEASE_LOST')
        throw executionError(error, 'LEASE_LOST', { stage: 'worker' });
      if (error instanceof SessionError && error.reason === 'STOP_PENDING')
        throw executionError(error, 'WORKER_INTERRUPTED', { stage: 'worker' });
      const cause = storage
        ? new StorageOperationError(storage.operation, redact(storage.path), storage.bytes, error)
        : error;
      throw executionError(cause, code, { stage });
    }
  }
  const secrets = new Set([
    ...config.modelConfigs.map((model) => model.MODEL_API_KEY),
    ...Object.values(config.d2c.contentStorage?.encryption?.keys ?? {}),
    ...Object.values(config.d2c.checkpointStorage?.encryption?.keys ?? {}),
  ]);
  /** 仅在当前轮次保留临时明文，用于阻止凭据进入文件、历史和页面。 */
  function redact(value: string) {
    let safe = value;
    for (const secret of secrets)
      if (secret) {
        for (const form of new Set([
          secret,
          JSON.stringify(secret).slice(1, -1),
          encodeURIComponent(secret),
        ]))
          safe = safe.split(form).join('[REDACTED]');
      }
    return safe;
  }
  let leaseCheck: Promise<void> | undefined;
  /** 副作用与周期心跳共享在途检查，避免并行子任务排入重复的租约事务。 */
  async function assertLease() {
    if (signal.aborted)
      throw executionError(signal.reason, 'WORKER_INTERRUPTED', { stage: 'worker' });
    leaseCheck ??= (async () => {
      try {
        const state = await leases.heartbeat(lease);
        if (!state) throw new RunExecutionError('LEASE_LOST', { stage: 'worker' });
        if (state.stopRequested || state.cancelRequested)
          throw new RunExecutionError('WORKER_INTERRUPTED', { stage: 'worker' });
      } catch (error) {
        const failure = executionError(error, 'LEASE_LOST', { stage: 'worker' });
        controller.abort(failure);
        throw failure;
      }
    })().finally(() => {
      leaseCheck = undefined;
    });
    await leaseCheck;
    if (signal.aborted)
      throw executionError(signal.reason, 'WORKER_INTERRUPTED', { stage: 'worker' });
  }
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTask: Promise<void> = Promise.resolve();
  let heartbeatStopped = false;
  /** 从准备阶段开始串行续租；停机或失联中止 SDK 与实际脚本子进程。 */
  function schedule() {
    if (heartbeatStopped || signal.aborted) return;
    heartbeat = setTimeout(() => {
      heartbeatTask = assertLease()
        .then(schedule)
        .catch((error) => {
          controller.abort(executionError(error, 'LEASE_LOST', { stage: 'worker' }));
        });
    }, config.d2c.execution.heartbeatMs);
  }
  /** 释放 owner 前停止调度并等待在途检查，避免正常交接被心跳误判为失租。 */
  async function stopHeartbeat() {
    heartbeatStopped = true;
    clearTimeout(heartbeat);
    await heartbeatTask;
  }
  const persistence = createRunPersistence(input.mysql, leases, lease, {
    signal: controller.signal,
    limits: config.d2c.limits,
    notify: input.notify,
    redact,
  });
  /** 准备期间的资源加载及单文件下载同样需要周期续租；失败不能遗留计时器。 */
  async function prepare() {
    /** 准备：从租约事务取得一致快照，再用模型地址和名称匹配当前配置中的密钥。 */
    const snapshot = await boundary('PREPARATION_FAILED', 'prepare', () => persistence.load());
    if (isExternalUserId(snapshot.ownerUserId) && !snapshot.model.modelCredentialId)
      throw new RunExecutionError('CREDENTIAL_UNAVAILABLE', { stage: 'prepare' });
    const selected = config.modelConfigs.find(
      (model) =>
        model.MODEL_BASE_URL === snapshot.model.MODEL_BASE_URL &&
        model.MODEL_NAME === snapshot.model.MODEL_NAME,
    );
    if (!snapshot.model.modelCredentialId && !selected)
      throw new RunExecutionError('MODEL_UNAVAILABLE', { stage: 'prepare' });
    // 个人绑定只使用本轮发起人的固定 Token 修订，任何失败都不能借用平台 Key。
    const modelApiKey = snapshot.model.modelCredentialId
      ? await boundary('CREDENTIAL_UNAVAILABLE', 'prepare', () =>
          createModelCredentialService(
            input.mysql,
            () => config.d2c.secrets,
            () => config.modelConfigs,
          ).getToken(snapshot.ownerUserId, snapshot.model.modelCredentialId!, snapshot.model),
        )
      : selected!.MODEL_API_KEY;
    secrets.add(modelApiKey);
    const target = snapshot.configSnapshot.target;
    if (target !== 'h5' && target !== 'rn')
      throw new RunExecutionError('PREPARATION_FAILED', { stage: 'prepare' });
    const credentials = input.testToken
      ? undefined
      : createFigmaCredentialService(input.mysql, () => config.d2c.secrets);
    /** 仅在 Figma 工具边界解密固定凭据，不传给 SDK 或整份进程环境。 */
    async function token() {
      if (!snapshot.credentialId)
        throw new RunExecutionError('CREDENTIAL_UNAVAILABLE', { stage: 'tool' });
      const value = await boundary('CREDENTIAL_UNAVAILABLE', 'tool', () =>
        input.testToken
          ? input.testToken()
          : credentials!.getToken(snapshot.ownerUserId, snapshot.credentialId!),
      );
      secrets.add(value);
      return value;
    }
    /** 外部资源与稳定文件恢复到私有临时目录；恢复函数负责自身失败时的目录清理。 */
    const restored = await boundary('RESOURCE_RESTORE_FAILED', 'prepare', () =>
      restoreExecutionWorkspace({
        workRoot: config.d2c.execution.workRoot,
        resourceRevisionId: snapshot.resourceRevisionId,
        bundleHash: snapshot.bundleHash,
        bundleObject: snapshot.bundleObject,
        configSnapshot: snapshot.configSnapshot as Parameters<
          typeof restoreExecutionWorkspace
        >[0]['configSnapshot'],
        files: snapshot.files,
        limits: config.d2c.limits,
        store: input.store,
        readBinary: (file) =>
          boundary('STORAGE_FAILED', 'storage', () =>
            input.binary.downloadFile(file.objectLocator),
          ),
        assertLease,
        signal,
      }),
    );
    return { snapshot, selected, modelApiKey, target: target as 'h5' | 'rn', token, restored };
  }
  schedule();
  const { snapshot, selected, modelApiKey, target, token, restored } = await prepare().catch(
    async (error) => {
      const failure = executionError(
        signal.aborted ? signal.reason : error,
        signal.aborted ? 'WORKER_INTERRUPTED' : 'PREPARATION_FAILED',
        { stage: signal.aborted ? 'worker' : 'prepare' },
      );
      controller.abort(failure);
      await stopHeartbeat();
      throw failure;
    },
  );
  const assetUrls: Record<string, string> = {};
  for (const file of snapshot.files) {
    if (file.kind !== 'asset' || !file.objectLocator) continue;
    const url = assetUrl(file.objectLocator);
    if (url) assetUrls[file.path] = url;
  }
  const saveScreenshot = createRunScreenshotWriter({
    mysql: input.mysql,
    leases,
    lease,
    binary: input.binary,
    userId: snapshot.ownerUserId,
    uploadBytes: config.d2c.limits.uploadBytes,
    assertLease,
    notify: input.notify,
  });
  const preview = input.preview
    ? createPreviewInspection({
        service: input.preview,
        userId: snapshot.ownerUserId,
        sessionId: lease.sessionId,
        signal,
        assertLease,
        saveCapture: (value) => boundary('STORAGE_FAILED', 'storage', () => saveScreenshot(value)),
      })
    : undefined;
  const resolveAttachment = resolveAttachmentImages(
    input.mysql,
    input.binary,
    snapshot.ownerUserId,
    lease.sessionId,
  );
  let changed = false;
  let failed = false;
  try {
    /** 执行时限仍从恢复完成后计算；准备和执行共用同一周期心跳。 */
    const activeStarted = Date.now();
    timeout = setTimeout(
      () => controller.abort(new RunExecutionError('RUN_TIMEOUT', { stage: 'worker' })),
      Math.max(1, snapshot.model.runTimeoutMs - (snapshot.interaction?.activeMs ?? 0)),
    );
    const imageDirectories = await boundary('STORAGE_FAILED', 'storage', async () =>
      createImageDirectories({
        files: snapshot.files,
        assetsDir: (snapshot.configSnapshot.config as WorkspaceConfigs['h5' | 'rn']).images
          .assetsDir,
        save: (content) =>
          boundary('STORAGE_FAILED', 'storage', () =>
            persistence.write(imageDirectoriesPath, content, 'internal'),
          ),
      }),
    );
    const runtime = await boundary('PREPARATION_FAILED', 'prepare', () =>
      createGenerationTools({
        restored,
        savedFiles: snapshot.files,
        reusableLegacyManifests: snapshot.reusableLegacyManifests,
        assetUrls: () => ({ ...assetUrls }),
        figmaUrl: snapshot.figmaUrl,
        target,
        proxyUrl: input.proxyUrl,
        allowedHosts: config.d2c.network.allowedExternalHosts,
        textFileBytes: config.d2c.limits.textFileBytes,
        uploadBytes: config.d2c.limits.uploadBytes,
        signal,
        progress: (entry) => persistence.recordProgress(entry),
        onFigmaRoot: (name) => persistence.nameFromFigma(name),
        token,
        redact,
        assertLease,
        save: async (relative, content, internal) => {
          await boundary(
            'STORAGE_FAILED',
            'storage',
            () => persistence.write(relative, content, internal ? 'internal' : 'source'),
            { operation: 'write_text', path: relative, bytes: Buffer.byteLength(content) },
          );
          changed ||= !internal;
          if (!internal) preview?.changed();
        },
        saveBinary: async (relative, content) => {
          /** 上传在数据库事务外完成，前后核对租约；上传成功不代表文件定位已提交。 */
          if (!content.length || content.length > config.d2c.limits.uploadBytes)
            throw new RunExecutionError('VALIDATION_FAILED', { stage: 'validation' });
          await assertLease();
          const fileName = isImageFileName(relative)
            ? await imageDirectories.name(relative)
            : `d2c/${lease.sessionId}/${relative.split('/').pop()}`;
          const locator = await boundary(
            'STORAGE_FAILED',
            'storage',
            () =>
              input.binary.uploadFile({
                content,
                fileName,
                renameOnConflict: true,
                contentType: 'application/octet-stream',
                signal,
              }),
            { operation: 'upload', path: relative, bytes: content.length },
          );
          await assertLease();
          await boundary(
            'STORAGE_FAILED',
            'storage',
            () => persistence.writeBinary(relative, content, locator),
            { operation: 'write_binary', path: relative, bytes: content.length },
          );
          const url = assetUrl(locator);
          if (url) assetUrls[relative] = url;
          preview?.changed();
        },
        remove: async (relative) => {
          await boundary('STORAGE_FAILED', 'storage', async () => {
            try {
              await persistence.remove(relative);
            } catch (error) {
              if (
                error instanceof SessionError &&
                (error.reason === 'FILE_NOT_FOUND' || error.reason === 'FILE_DELETE_NOT_ALLOWED')
              )
                throw toolIssue(
                  error.reason,
                  'VALIDATION_FAILED',
                  { stage: 'tool', tool: 'delete_file' },
                  { path: relative },
                );
              throw error;
            }
          });
          changed = true;
          preview?.changed();
        },
      }),
    );
    /** SDK 只取得工具接口；稳定历史写入由 persistence 处理，Token 留在可信工具边界。 */
    const result = await runDeepGeneration({
      inspectDelivery: (required) =>
        boundary('STORAGE_FAILED', 'storage', () => runtime.delivery(required)),
      readGuidance: (applied) =>
        boundary('STORAGE_FAILED', 'storage', () =>
          consumeRunGuidance(input.mysql, leases, lease, applied, input.notify),
        ),
      onModelActivity: (entry) =>
        boundary('STORAGE_FAILED', 'storage', () => persistence.recordModelActivity(entry)),
      onText: (entry) => boundary('STORAGE_FAILED', 'storage', () => persistence.recordText(entry)),
      sanitizePartialText: (text) => redactPartialText(text, secrets, redact),
      recordSubagent: (entry) => persistence.recordSubagent(entry),
      model: {
        baseURL: snapshot.model.MODEL_BASE_URL,
        name: snapshot.model.MODEL_NAME,
        apiKey: modelApiKey,
        contextBudgetTokens: snapshot.model.contextBudgetTokens,
        requestTimeoutMs: snapshot.model.requestTimeoutMs,
        ...(snapshot.model.reasoningPolicy !== undefined
          ? { reasoningPolicy: snapshot.model.reasoningPolicy }
          : {}),
      },
      reasoningContext: {
        hasSourceFiles: snapshot.files.some((file) => file.kind === 'source'),
        hasDesign: Boolean(snapshot.figmaUrl),
      },
      history: snapshot.history,
      userDecisions: redact(snapshot.userDecisions),
      resume: snapshot.interaction
        ? {
            interruptId: snapshot.interaction.interruptId,
            checkpointId: snapshot.interaction.checkpointId,
            answer:
              snapshot.interaction.answer! +
              (snapshot.sourceChangedByUser
                ? '\n[平台通知] 用户已通过在线编辑更新当前工作区源码。继续前必须重新读取相关文件，保留手动修改，不得沿用旧文件内容直接覆盖。'
                : ''),
          }
        : undefined,
      priorUsage: snapshot.priorUsage,
      ...(snapshot.sourceChangedByUser
        ? { continueWork: false }
        : snapshot.resumeFromRunId
          ? { continueWork: true }
          : {}),
      subagentIdentity: JSON.stringify([
        snapshot.bundleHash,
        snapshot.configSnapshot.hash,
        snapshot.figmaUrl,
      ]),
      instructions:
        createGenerationInstructions(target, snapshot.figmaUrl) +
        `\n${runtime.tools.outputPlan ?? ''}` +
        (snapshot.userDecisions ? `\n${redact(snapshot.userDecisions)}` : '') +
        (snapshot.sourceChangedByUser
          ? '\n[平台通知] 用户已通过在线编辑更新当前工作区源码。继续前重新读取相关文件，保留用户修改。'
          : ''),
      maxTurns: snapshot.model.maxTurns,
      signal,
      tools: { ...runtime.tools, ...(preview ? { preview: preview.tools } : {}) },
      resolveImage: async (ref) =>
        (await runtime.resolveImage(ref)) ??
        (await preview?.resolveImage(ref)) ??
        boundary('STORAGE_FAILED', 'storage', () => resolveAttachment(ref)),
      record: (entry) => boundary('STORAGE_FAILED', 'storage', () => persistence.record(entry)),
      assertLease,
      testModel: input.testModel,
      message: snapshot.message,
      redact,
      checkpoint: createRunCheckpointSaver(input.mysql, leases, lease, signal),
      resources: { bundle: restored.bundle, bundleHash: restored.bundle.hash, target },
    });
    if (result.waiting) {
      await boundary('STORAGE_FAILED', 'storage', () => persistence.complete(result.usage));
      await assertLease();
      const waiting = {
        ...result.waiting,
        kind: undefined,
        questionId: randomUUID(),
        state: 'waiting' as const,
        activeMs: (snapshot.interaction?.activeMs ?? 0) + Date.now() - activeStarted,
      };
      await stopHeartbeat();
      if (signal.aborted)
        throw executionError(signal.reason, 'WORKER_INTERRUPTED', { stage: 'worker' });
      if (!(await leases.waitForInput(lease, waiting)))
        throw new RunExecutionError('WORKER_INTERRUPTED', { stage: 'worker' });
      return;
    }
    /** 执行结果与代码检查分开保存；规则违规不代表工具或持久化执行失败。 */
    const validation = await boundary('VALIDATION_FAILED', 'validation', () =>
      runtime.validation(),
    );
    await boundary('STORAGE_FAILED', 'storage', () =>
      persistence.complete(
        result.usage,
        changed || runtime.validationRequested() || validation.status === 'passed'
          ? validation
          : undefined,
      ),
    );
    /** 成功结算前再次续租并检查停止标记；保存过文件或校验结果不等于轮次已成功。 */
    await assertLease();
    await stopHeartbeat();
    if (signal.aborted)
      throw executionError(signal.reason, 'WORKER_INTERRUPTED', { stage: 'worker' });
    if (!(await boundary('STORAGE_FAILED', 'storage', () => leases.settle(lease, 'succeeded'))))
      throw new RunExecutionError('LEASE_LOST', { stage: 'worker' });
  } catch (error) {
    failed = true;
    throw executionError(
      signal.aborted && !(error instanceof RunExecutionError) ? signal.reason : error,
      'EXECUTION_FAILED',
      { stage: 'worker' },
    );
  } finally {
    /** 无论成功失败均停止心跳，等待在途续租后释放本轮临时目录。 */
    controller.abort();
    clearTimeout(timeout);
    await stopHeartbeat();
    await preview?.close();
    try {
      await boundary('RESOURCE_RESTORE_FAILED', 'prepare', () => restored.dispose());
    } catch (error) {
      if (!failed) throw error;
    }
  }
}
