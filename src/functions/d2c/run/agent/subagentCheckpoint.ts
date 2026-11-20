import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  emptyCheckpoint,
  type CheckpointTuple,
  type CheckpointListOptions,
  type Checkpoint,
  type CheckpointMetadata,
  type ChannelVersions,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChildHandoff } from './handoff';
import type { GenerationTools } from '../types';
import { mergeScanReport, ScanReportError } from './scanReport';
import { nativeScanReport } from '../ruleScan/report';

export type AgentCheckpoint = BaseCheckpointSaver & {
  config(namespace?: string, id?: string): RunnableConfig;
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** 图仍使用空 namespace；存储层为每个子任务加前缀，避免被框架误认作父图节点。 */
export class SubagentCheckpoint extends BaseCheckpointSaver implements AgentCheckpoint {
  constructor(
    private readonly parent: AgentCheckpoint,
    private readonly prefix: string,
  ) {
    super(parent.serde);
    if (!prefix || !prefix.endsWith('/')) throw new Error('DEEP_SUBAGENT_CHECKPOINT_SCOPE');
  }
  config(namespace = '', id?: string) {
    return this.parent.config(namespace, id);
  }
  private scoped(config: RunnableConfig): RunnableConfig {
    return {
      ...config,
      configurable: {
        ...config.configurable,
        checkpoint_ns: this.prefix + String(config.configurable?.checkpoint_ns ?? ''),
      },
    };
  }
  private local(config: RunnableConfig): RunnableConfig {
    const ns = String(config.configurable?.checkpoint_ns ?? '');
    if (!ns.startsWith(this.prefix)) throw new Error('DEEP_SUBAGENT_CHECKPOINT_SCOPE');
    return {
      ...config,
      configurable: { ...config.configurable, checkpoint_ns: ns.slice(this.prefix.length) },
    };
  }
  private tuple(value: CheckpointTuple): CheckpointTuple {
    return {
      ...value,
      config: this.local(value.config),
      ...(value.parentConfig ? { parentConfig: this.local(value.parentConfig) } : {}),
    };
  }
  async getTuple(config: RunnableConfig) {
    const value = await this.parent.getTuple(this.scoped(config));
    return value ? this.tuple(value) : undefined;
  }
  async *list(config: RunnableConfig, options?: CheckpointListOptions) {
    for await (const tuple of this.parent.list(this.scoped(config), {
      ...options,
      ...(options?.before ? { before: this.scoped(options.before) } : {}),
    }))
      yield this.tuple(tuple);
  }
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    versions: ChannelVersions,
  ) {
    return this.local(await this.parent.put(this.scoped(config), checkpoint, metadata, versions));
  }
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath?: string,
  ) {
    await this.parent.putWrites(this.scoped(config), writes, taskId, taskPath);
  }
  async deleteThread(): Promise<void> {
    throw new Error('DEEP_SUBAGENT_CHECKPOINT_DELETE_DENIED');
  }
}

type SubagentRecovery = {
  inputChanged: boolean;
  changedPaths: string[];
  missingPaths: string[];
};

type ChildProgress = {
  agentId: string;
  role: string;
  nodeId?: string;
  writePaths: string[];
  taskHash?: string;
  contextHash?: string;
  recovery?: SubagentRecovery;
  files: Record<string, string>;
  partialFiles?: string[];
  result?: string;
  handoff?: ChildHandoff;
  background?: {
    key: string;
    task: string;
    status: 'pending' | 'settled';
    result?: string;
    observed: boolean;
  };
};

/** 显式恢复只允许当前 job 的原身份和原授权，不允许降级成新任务。 */
export class SubagentResumeError extends Error {
  constructor(public readonly reason: 'NOT_FOUND' | 'SCOPE_CHANGED') {
    super(`DEEP_SUBAGENT_RESUME_${reason}`);
    this.name = 'SubagentResumeError';
  }
}

type BackgroundSubagent = {
  agentId: string;
  key: string;
  role: string;
  nodeId?: string;
  writePaths: string[];
  task: string;
  status: 'pending' | 'settled';
  result?: string;
};

const taskText = z
  .string()
  .refine((value) => value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 8000);
/** 工具结果允许包含交接信息；限制字节数，不解析或改写失败及截断的 JSON。 */
const backgroundResult = z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= 256000);
const backgroundSchema = z
  .object({
    key: taskText,
    task: taskText,
    status: z.enum(['pending', 'settled']),
    result: backgroundResult.optional(),
    observed: z.boolean(),
  })
  .strict()
  .refine((value) =>
    value.status === 'settled' ? value.result !== undefined : value.result === undefined,
  );
const childProgressSchema = z
  .object({
    agentId: z.string().uuid(),
    role: z.enum(['design', 'review', 'rule_scan', 'ui']),
    nodeId: z.string().min(1).max(200).optional(),
    writePaths: z.array(z.string().min(1).max(1024)).max(32),
    files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    taskHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    contextHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    recovery: z
      .object({
        inputChanged: z.boolean(),
        changedPaths: z.array(z.string()),
        missingPaths: z.array(z.string()),
      })
      .optional(),
    partialFiles: z.array(z.string()).optional(),
    result: z.string().optional(),
    handoff: z
      .object({
        verifiedTools: z.array(z.object({ tool: z.string() }).passthrough()),
        omitted: z.number(),
      })
      .passthrough()
      .optional(),
    background: backgroundSchema.optional(),
  })
  .passthrough();
const backgroundProgressSchema = childProgressSchema.extend({ background: backgroundSchema });

/** 旧记录无需 contextHash；损坏记录必须阻断恢复，不能被当作新任务覆盖。 */
function readProgress(tuple: CheckpointTuple): ChildProgress {
  const parsed = childProgressSchema.safeParse(tuple.checkpoint.channel_values.progress);
  if (!/^[a-f0-9]{64}$/.test(tuple.checkpoint.id) || !parsed.success)
    throw new Error('DEEP_SUBAGENT_PROGRESS_CORRUPT');
  const state = parsed.data as ChildProgress;
  if (Object.keys(state.files).some((path) => !state.writePaths.includes(path)))
    throw new Error('DEEP_SUBAGENT_PROGRESS_CORRUPT');
  return structuredClone(state);
}
const progressQueues = new WeakMap<AgentCheckpoint, Map<string, Promise<unknown>>>();

/** 同一保存器的同一任务串行提交；失败仅拒绝本次调用，不阻断后续重试。 */
function serializeProgress<T>(
  checkpoint: AgentCheckpoint,
  key: string,
  action: () => Promise<T>,
): Promise<T> {
  let queues = progressQueues.get(checkpoint);
  if (!queues) progressQueues.set(checkpoint, (queues = new Map()));
  const pending = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
  queues.set(key, pending);
  void pending
    .finally(() => {
      if (queues.get(key) === pending) queues.delete(key);
    })
    .catch(() => {});
  return pending;
}

/** 读取实际完整文本摘要；只用于授权子任务已写文件的复核，不把正文加入额外提示。 */
async function fileHash(tools: GenerationTools, path: string) {
  const page = JSON.parse(await tools.read(path, false, 0, Number.MAX_SAFE_INTEGER));
  if (page.ok === false && page.code === 'FILE_NOT_FOUND') return undefined;
  if (page.ok === false || typeof page.content !== 'string' || page.nextOffset !== null)
    throw new Error('DEEP_SUBAGENT_FILE_READ_INVALID');
  return typeof page.sha256 === 'string' && /^[a-f0-9]{64}$/.test(page.sha256)
    ? page.sha256
    : digest(page.content);
}

/** 核对真实文本；合并批次必须再次合并仍逐字节不变，才可认领未知写入。 */
async function verifiedWriteHash(
  tools: GenerationTools,
  path: string,
  content: string,
  merge = false,
) {
  const page = JSON.parse(await tools.read(path, false, 0, Number.MAX_SAFE_INTEGER));
  if (typeof page.content !== 'string' || page.nextOffset !== null) return undefined;
  /** 原生报告由平台补齐程序部分，未知回执按同一纯函数核对实际内容，绝不重放写入。 */
  if (tools.scanRules && path.endsWith('/rule-hits.json')) {
    let report;
    try {
      report = JSON.parse(page.content);
    } catch {
      return undefined;
    }
    if (report?.nativeScan) {
      const current = await tools.scanRules(path, report.context?.rootNodeId);
      try {
        const normalized = nativeScanReport(current, content, page.content);
        return page.content === normalized ? digest(page.content) : undefined;
      } catch (error) {
        if (error instanceof ScanReportError) return undefined;
        throw error;
      }
    }
  }
  if (merge) {
    try {
      content = mergeScanReport(page.content, content);
    } catch {
      return undefined;
    }
  }
  return page.content === content ? digest(page.content) : undefined;
}

/** 业务继续沿用原 job；普通新需求、资源/配置变化或用户手动改源文件创建新 job。 */
export async function createSubagentProgress(
  checkpoint: AgentCheckpoint,
  options: {
    continuation: boolean;
    identity: string;
    messageId: string;
  },
) {
  const pointer = checkpoint.config('__pixelprint_subagent_job');
  const prior = (await checkpoint.getTuple(checkpoint.config('__pixelprint_subagent_job', 'job')))
    ?.checkpoint.channel_values;
  const jobId =
    options.continuation && prior?.identity === options.identity && typeof prior.jobId === 'string'
      ? prior.jobId
      : options.messageId;
  if (prior?.jobId !== jobId || prior.identity !== options.identity) {
    const value = emptyCheckpoint();
    value.id = 'job';
    value.channel_values = { jobId, identity: options.identity };
    await checkpoint.put(pointer, value, { source: 'update', step: 0, parents: {} }, {});
  }
  const ns = `__pixelprint_subagent_progress/${digest(JSON.stringify([jobId, options.identity]))}`;
  /** list 可能包含子 namespace；必须同时精确匹配当前 thread 与 job namespace。 */
  async function findAgent(agentId: string) {
    let found: { key: string; state: ChildProgress } | undefined;
    for await (const tuple of checkpoint.list(checkpoint.config(ns))) {
      if (
        tuple.config.configurable?.checkpoint_ns !== ns ||
        tuple.config.configurable?.thread_id !== checkpoint.config(ns).configurable?.thread_id
      )
        continue;
      const state = readProgress(tuple);
      if (state.agentId !== agentId) continue;
      if (found) throw new Error('DEEP_SUBAGENT_PROGRESS_CORRUPT');
      found = { key: tuple.checkpoint.id, state };
    }
    return found;
  }
  return {
    /** 任务文字允许在纠错时变化；角色、节点、写入授权与真实输入摘要共同决定同一个子任务。 */
    async open(
      task: { role: string; nodeId?: string; writePaths: string[]; description?: string },
      context: string,
      tools: GenerationTools,
      resumeAgentId?: string,
    ) {
      const inputKey = digest(
        JSON.stringify([
          task.role,
          task.nodeId ?? '',
          [...task.writePaths].sort(),
          context,
          ['design', 'review'].includes(task.role) ? digest(task.description ?? '') : '',
        ]),
      );
      const original = resumeAgentId === undefined ? undefined : await findAgent(resumeAgentId);
      if (resumeAgentId !== undefined && !original) throw new SubagentResumeError('NOT_FOUND');
      const key = original?.key ?? inputKey;
      return serializeProgress(checkpoint, `${ns}/${key}`, async () => {
        const config = checkpoint.config(ns);
        const tuple = await checkpoint.getTuple(checkpoint.config(ns, key));
        let state = tuple ? readProgress(tuple) : undefined;
        if (resumeAgentId !== undefined) {
          if (!state || state.agentId !== resumeAgentId) throw new SubagentResumeError('NOT_FOUND');
          if (
            state.role !== task.role ||
            state.nodeId !== task.nodeId ||
            JSON.stringify([...state.writePaths].sort()) !==
              JSON.stringify([...task.writePaths].sort())
          )
            throw new SubagentResumeError('SCOPE_CHANGED');
        }
        const recovery = {
          inputChanged: Boolean(
            state &&
              (state.contextHash !== undefined
                ? state.contextHash !== digest(context)
                : key !== inputKey),
          ),
          changedPaths: [] as string[],
          missingPaths: [] as string[],
        };
        if (state) {
          for (const [path, sha] of Object.entries(state.files)) {
            if (!task.writePaths.includes(path)) {
              state = undefined;
              break;
            }
            const currentHash = await fileHash(tools, path);
            if (currentHash === sha) continue;
            (currentHash === undefined ? recovery.missingPaths : recovery.changedPaths).push(path);
            /** 文件已提交、进度回执未提交时，先核对原图的未知写入，不能误判用户改源后重建子图。 */
            const graph = new SubagentCheckpoint(checkpoint, `${ns}/${state.agentId}/`);
            const messages = (await graph.getTuple(graph.config()))?.checkpoint.channel_values
              .messages as BaseMessage[] | undefined;
            const done = new Set(
              messages?.filter(ToolMessage.isInstance).map((message) => message.tool_call_id),
            );
            let verified: string | undefined;
            for (const message of messages ?? [])
              if (AIMessage.isInstance(message))
                for (const call of message.tool_calls ?? [])
                  if (
                    call.id &&
                    !done.has(call.id) &&
                    call.name === 'write_file' &&
                    call.args.path === path &&
                    typeof call.args.content === 'string'
                  )
                    verified ??= await verifiedWriteHash(
                      tools,
                      path,
                      call.args.content,
                      call.args.merge === true,
                    );
            /** 未知局部编辑保留原图及真实文件基线，不宣称成功、不重放；子Agent须读取核对并重新检查。 */
            const pendingEdit =
              state.role === 'ui' &&
              (messages ?? []).some(
                (message) =>
                  AIMessage.isInstance(message) &&
                  message.tool_calls?.some(
                    (call) =>
                      call.id &&
                      !done.has(call.id) &&
                      call.name === 'edit_file' &&
                      call.args.path === path &&
                      call.args.expectedSha256 === sha &&
                      typeof call.args.oldText === 'string' &&
                      typeof call.args.newText === 'string',
                  ),
              );
            if (!verified && !(pendingEdit && currentHash)) {
              if (resumeAgentId !== undefined) {
                delete state.files[path];
                state.partialFiles = state.partialFiles?.filter((value) => value !== path);
                continue;
              }
              state = undefined;
              break;
            }
            state.files[path] = verified ?? currentHash!;
            delete state.result;
            if (state.role === 'rule_scan')
              state.partialFiles = [...new Set([...(state.partialFiles ?? []), path])];
          }
        }
        /** 差异持续保留到真实执行结算；open/start 后中断也不能丢失子图尚未收到的复核提示。 */
        if (state?.recovery) {
          recovery.inputChanged ||= state.recovery.inputChanged;
          recovery.changedPaths = [
            ...new Set([...state.recovery.changedPaths, ...recovery.changedPaths]),
          ];
          recovery.missingPaths = [
            ...new Set([...state.recovery.missingPaths, ...recovery.missingPaths]),
          ];
        }
        const restored = Boolean(state);
        state ??= {
          agentId: randomUUID(),
          role: task.role,
          nodeId: task.nodeId,
          writePaths: [...task.writePaths],
          files: {},
        };
        const current = state;
        if (recovery.inputChanged || recovery.changedPaths.length || recovery.missingPaths.length)
          delete current.result;
        current.recovery = structuredClone(recovery);
        current.contextHash = digest(context);
        const taskHash = digest(task.description ?? '');
        if (task.role === 'ui' && current.taskHash !== taskHash) delete current.result;
        current.taskHash = taskHash;
        /** 每次修改经原检查点租约事务落库，存储失败不能降级为重新执行。 */
        async function save(next: ChildProgress) {
          const value = emptyCheckpoint();
          value.id = key;
          value.channel_values = { progress: structuredClone(next) };
          await checkpoint.put(config, value, { source: 'update', step: 0, parents: {} }, {});
        }
        await save(current);
        /** 从最新已保存记录复制后修改，避免多个 open 句柄覆盖彼此已提交的字段。 */
        async function update(
          change: (next: ChildProgress) => void | boolean | Promise<void | boolean>,
        ) {
          await serializeProgress(checkpoint, `${ns}/${key}`, async () => {
            const saved = (await checkpoint.getTuple(checkpoint.config(ns, key)))?.checkpoint
              .channel_values.progress as ChildProgress | undefined;
            if (!saved || saved.agentId !== current.agentId)
              throw new Error('DEEP_SUBAGENT_PROGRESS_CHANGED');
            const next = structuredClone(saved);
            if ((await change(next)) === false) return;
            await save(next);
            for (const field of Object.keys(current) as Array<keyof ChildProgress>)
              delete current[field];
            Object.assign(current, next);
          });
        }
        return {
          state: current,
          restored,
          recovery,
          /** 同一用户输入内重派不能重置补交；显式新一轮继续允许重新尝试。 */
          admissionId: options.messageId,
          checkpoint: new SubagentCheckpoint(checkpoint, `${ns}/${current.agentId}/`),
          /** 描述落库后才确认委派；重新开始始终重置为未交付的 pending。 */
          async startBackground(key: string, task: string): Promise<void> {
            if (!taskText.safeParse(key).success || !taskText.safeParse(task).success)
              throw new Error('DEEP_SUBAGENT_BACKGROUND_INVALID');
            await update((next) => {
              next.background = { key, task, status: 'pending', observed: false };
            });
          },
          /** 真实执行结算原始结果（包括失败或不完整 JSON）后清除恢复提示，不影响成功结果缓存。 */
          async settleBackground(result: string): Promise<void> {
            if (!backgroundResult.safeParse(result).success)
              throw new Error('DEEP_SUBAGENT_BACKGROUND_INVALID');
            await update((next) => {
              if (!backgroundSchema.safeParse(next.background).success)
                throw new Error('DEEP_SUBAGENT_BACKGROUND_MISSING');
              next.background = { ...next.background!, status: 'settled', result };
              delete next.recovery;
            });
          },
          /** 主模型已收到结果后标记交付，继续保留后台描述供审计和重派。 */
          async observeBackground(): Promise<void> {
            await update((next) => {
              if (!backgroundSchema.safeParse(next.background).success)
                throw new Error('DEEP_SUBAGENT_BACKGROUND_MISSING');
              next.background!.observed = true;
            });
          },
          async wrote(path: string) {
            if (!task.writePaths.includes(path)) throw new Error('DEEP_SUBAGENT_WRITE_SCOPE');
            await update(async (next) => {
              const sha = await fileHash(tools, path);
              if (!sha) throw new Error('DEEP_SUBAGENT_SAVED_FILE_MISSING');
              next.files[path] = sha;
              delete next.result;
            });
          },
          async reconcile(path: string, content: string, merge = false) {
            if (!task.writePaths.includes(path)) return false;
            let verified = false;
            await update(async (next) => {
              const sha = await verifiedWriteHash(tools, path, content, merge);
              if (!sha) return false;
              next.files[path] = sha;
              if (next.role === 'rule_scan')
                next.partialFiles = [...new Set([...(next.partialFiles ?? []), path])];
              verified = true;
            });
            return verified;
          },
          /** 完成标记与实际文件摘要绑定；未知写入只认部分保存，须在原上下文核对补交。 */
          async markScanFile(path: string, complete: boolean) {
            if (current.role !== 'rule_scan' || !task.writePaths.includes(path))
              throw new Error('DEEP_SUBAGENT_WRITE_SCOPE');
            await update((next) => {
              next.partialFiles = complete
                ? (next.partialFiles ?? []).filter((value) => value !== path)
                : [...new Set([...(next.partialFiles ?? []), path])];
              delete next.result;
            });
          },
          async saveHandoff(handoff: ChildHandoff) {
            const copy = structuredClone(handoff);
            await update((next) => {
              next.handoff = copy;
            });
          },
          async complete(result: string) {
            await update((next) => {
              next.result = result;
            });
          },
        };
      });
    },
    /** 被拒绝的自动恢复在父图保存交付后调用；不创建记录，也不改写原后台结果。 */
    async observeBackground(agentId: string): Promise<void> {
      const found = await findAgent(agentId);
      if (!found) return;
      await serializeProgress(checkpoint, `${ns}/${found.key}`, async () => {
        const tuple = await checkpoint.getTuple(checkpoint.config(ns, found.key));
        if (!tuple) return;
        const state = readProgress(tuple);
        if (state.agentId !== agentId) throw new Error('DEEP_SUBAGENT_PROGRESS_CHANGED');
        if (!state.background || state.background.observed) return;
        state.background.observed = true;
        const value = emptyCheckpoint();
        value.id = found.key;
        value.channel_values = { progress: state };
        await checkpoint.put(
          checkpoint.config(ns),
          value,
          { source: 'update', step: 0, parents: {} },
          {},
        );
      });
    },
    /** 只投影当前 job 精确 namespace 内有效且尚未交付的后台描述，不读取子图或其他作用域。 */
    async background(): Promise<BackgroundSubagent[]> {
      const rows: BackgroundSubagent[] = [];
      for await (const tuple of checkpoint.list(checkpoint.config(ns))) {
        if (
          tuple.config.configurable?.checkpoint_ns !== ns ||
          tuple.config.configurable?.thread_id !== checkpoint.config(ns).configurable?.thread_id
        )
          continue;
        const progress = tuple.checkpoint.channel_values.progress;
        /** 旧任务未委派后台工作可跳过；已保存的后台描述损坏必须阻断恢复，不能丢失待交付任务。 */
        if (!progress || typeof progress !== 'object' || !Object.hasOwn(progress, 'background'))
          continue;
        const parsed = backgroundProgressSchema.safeParse(progress);
        if (!/^[a-f0-9]{64}$/.test(tuple.checkpoint.id) || !parsed.success)
          throw new Error('DEEP_SUBAGENT_BACKGROUND_CORRUPT');
        if (parsed.data.background.observed) continue;
        const { agentId, role, nodeId, writePaths, background } = parsed.data;
        rows.push({
          agentId,
          role,
          ...(nodeId !== undefined ? { nodeId } : {}),
          writePaths,
          key: background.key,
          task: background.task,
          status: background.status,
          ...(background.result !== undefined ? { result: background.result } : {}),
        });
      }
      return rows;
    },
    /** 仅列出实际保存的子任务状态，引导主 Agent 接续已有区块，不重做整套扫描。 */
    async overview(tools?: GenerationTools) {
      const rows: string[] = [];
      for await (const tuple of checkpoint.list(checkpoint.config(ns), { limit: 64 })) {
        const state = tuple.checkpoint.channel_values.progress as ChildProgress | undefined;
        let unchanged = true;
        if (state && tools)
          for (const [path, sha] of Object.entries(state.files))
            if ((await fileHash(tools, path)) !== sha) {
              unchanged = false;
              break;
            }
        if (state)
          rows.push(
            JSON.stringify({
              agentId: state.agentId,
              reportedProgress:
                state.result && unchanged ? undefined : state.handoff?.reportedProgress,
              contextPath: state.handoff?.contextPath,
              role: state.role,
              nodeId: state.nodeId,
              writePaths: state.writePaths,
              status: state.result && unchanged ? 'completed' : 'unfinished',
            }),
          );
      }
      return rows.length
        ? `已保存的子任务进度：\n${rows.join('\n')}\n优先继续未完成任务；已完成报告先复用。重新委派同范围会恢复原子会话，不代表必须重扫。`
        : '';
    },
  };
}
export type SubagentProgress = Awaited<ReturnType<typeof createSubagentProgress>>;

/** 已完成工具结果保留；未知结果补齐但不重放，交由子 Agent 先核对现有文件。 */
export function settleSubagentMessages(
  messages: BaseMessage[],
  recovered = new Set<string>(),
): BaseMessage[] {
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (AIMessage.isInstance(message))
      for (const call of message.tool_calls ?? []) if (call.id) pending.set(call.id, call.name);
    if (ToolMessage.isInstance(message)) pending.delete(message.tool_call_id);
  }
  return [
    ...messages,
    ...[...pending].map(
      ([id, name]) =>
        new ToolMessage({
          tool_call_id: id,
          name,
          content: JSON.stringify({
            success: recovered.has(id),
            outcome: recovered.has(id) ? 'verified_saved' : 'unknown',
            message: recovered.has(id)
              ? '已核对稳定文件与原写入内容一致，复用已保存结果，没有重复写入。'
              : '暂停时工具结果未完整保存。先读取现有文件核对，不得直接重放写入或把未知结果当作失败。',
          }),
        }),
    ),
  ];
}

/** 未知写入先核对完整内容或幂等合并结果，不执行写入；扫描仍须补齐最终交付标记。 */
export async function recoverSubagentMessages(
  messages: BaseMessage[],
  verify?: (path: string, content: string, merge?: boolean) => Promise<boolean>,
) {
  const done = new Set(
    messages.filter(ToolMessage.isInstance).map((message) => message.tool_call_id),
  );
  const recovered = new Set<string>();
  for (const message of messages)
    if (AIMessage.isInstance(message))
      for (const call of message.tool_calls ?? []) {
        if (
          call.id &&
          !done.has(call.id) &&
          call.name === 'write_file' &&
          typeof call.args.path === 'string' &&
          typeof call.args.content === 'string' &&
          (await verify?.(call.args.path, call.args.content, call.args.merge === true))
        )
          recovered.add(call.id);
      }
  return settleSubagentMessages(messages, recovered);
}
