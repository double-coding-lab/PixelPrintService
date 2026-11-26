import './helpers/projectFixture';
import { deflateSync } from 'node:zlib';
import { createRunScreenshotWriter } from '../src/functions/d2c/run/screenshots';
import type { AttachmentBinary } from '../src/functions/d2c/session/attachments';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { AIMessage } from '@langchain/core/messages';
import { FakeToolCallingModel } from 'langchain';
import { executeGenerationRun } from '../src/functions/d2c/run/execute';
import { createRunLeases, type RunLease } from '../src/functions/d2c/run/leases';
import { readTemplateResources } from '../src/functions/d2c/workspace/resources';
import { messageFixture } from './helpers/messages';
import { enableCheckpointStorage } from './helpers/checkpointStorage';

const bundleTask = (async () => {
  const platformSkills = await fs.mkdtemp(path.join(os.tmpdir(), 'deadlock-platform-skills-'));
  try {
    return await readTemplateResources(
      path.resolve('pixelprint'),
      await fs.realpath(platformSkills),
    );
  } finally {
    await fs.rm(platformSkills, { recursive: true, force: true });
  }
})();

/** 仅使用离线数据库、固定本地资源及确定性模型，不访问模型、Figma 或对象存储。 */
async function executionFixture(t: TestContext) {
  const f = await messageFixture();
  enableCheckpointStorage(f.mysql);
  const bundle = await bundleTask;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lease-lifecycle-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  f.runtime.d2c.execution.workRoot = root;
  f.runtime.modelConfigs[0].contextBudgetTokens = 256000;
  f.tables.D2cWorkspaceRevision[0].bundleHash = bundle.hash;
  const queued = await f.messages.enqueue('employee-a', f.id, {
    clientRequestId: 'lifecycle',
    content: '验证租约生命周期',
  });
  /** 入队按正式约束校验，测试执行时再缩短调度间隔并注入可推进时钟。 */
  f.runtime.d2c.execution.leaseMs = 3000;
  f.runtime.d2c.execution.heartbeatMs = 10;
  const clock = { time: 1700000000000 };
  const leases = createRunLeases(f.mysql, { leaseMs: 3000, now: async () => clock.time });
  const lease = (await leases.claim(queued.runId, 'offline-worker'))!;
  const model = new FakeToolCallingModel();
  let modelCalls = 0;
  model.bindTools = () => model;
  model._generate = async () => {
    modelCalls++;
    const message = new AIMessage('离线验证完成');
    return { generations: [{ text: message.text, message }] };
  };
  const controller = new AbortController();
  const input: Parameters<typeof executeGenerationRun>[0] = {
    mysql: f.mysql,
    leases,
    lease,
    config: f.runtime,
    store: { load: async () => bundle },
    binary: {
      uploadFile: async () => assert.fail('不应上传'),
      downloadFile: async () => assert.fail('不应下载'),
    },
    proxyUrl: 'http://unused.internal',
    signal: controller.signal,
    notify: () => {},
    testModel: model,
  };
  /** 每步推进模拟数据库时间，并等待真实周期心跳确认，以免依赖机器执行速度。 */
  async function slowRead() {
    for (let step = 0; step < 4; step++) {
      clock.time += 1000;
      for (let attempt = 0; f.tables.D2cRun[0].heartbeatAt.getTime() < clock.time; attempt++) {
        assert.ok(attempt < 100, '准备阶段没有周期续租');
        await pause(5);
      }
    }
  }
  return {
    ...f,
    root,
    bundle,
    clock,
    leases,
    lease,
    input,
    controller,
    slowRead,
    modelCalls: () => modelCalls,
  };
}

/** 生成有真实 CRC 和压缩像素的离线 PNG，无用户截图和外部服务。 */
function png(width = 1, height = 1) {
  /** PNG 块包含类型、载荷和 CRC32。 */
  function chunk(type: string, content: Buffer) {
    const result = Buffer.alloc(content.length + 12);
    result.writeUInt32BE(content.length);
    result.write(type, 4);
    content.copy(result, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, result.length - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(5))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 离线对象存储只保存真实 PNG；领取与截图消息均经过正式租约事务。 */
async function screenshotFixture() {
  const f = await messageFixture();
  const queued = await f.messages.enqueue('employee-a', f.id, {
    clientRequestId: 'screenshot',
    content: '调整页面',
  });
  const leases = createRunLeases(f.mysql, { leaseMs: 60000, now: async () => 1700000000000 });
  const lease = (await leases.claim(queued.runId, 'worker-a'))!;
  let uploads = 0;
  const objects = new Map<string, Buffer>();
  const binary = {
    uploadFile: async (value) => {
      uploads++;
      objects.set(value.fileName, Buffer.from(value.content));
      return { fileName: value.fileName };
    },
    downloadFile: async (locator) => objects.get((locator as { fileName: string }).fileName)!,
  } as AttachmentBinary;
  const hints: number[] = [];
  const writer = createRunScreenshotWriter({
    mysql: f.mysql,
    leases,
    lease,
    binary,
    userId: 'employee-a',
    uploadBytes: 1000000,
    assertLease: async () => {
      const current = await leases.heartbeat(lease);
      if (!current || current.stopRequested || current.cancelRequested) throw new Error('stopped');
    },
    notify: (_id, seq) => hints.push(seq),
  });
  const value = {
    previewId: 'preview-one',
    fileRevision: 3,
    entryPath: 'pages/page/index.tsx',
    capture: {
      image: png(),
      mimeType: 'image/png' as const,
      width: 1,
      height: 1,
      errors: [],
      missingAssets: [],
      truncated: false,
    },
  };
  return { ...f, leases, lease, binary, writer, value, hints, uploads: () => uploads };
}

test('模型返回后检查点写入死锁只重试事务，不重新调用模型或结束轮次', async (t) => {
  const f = await executionFixture(t);
  const table = f.mysql.models.D2cAgentCheckpoint;
  const original = table.create.bind(table);
  let injected = false;
  t.mock.method(table, 'create', async (...args: any[]) => {
    const result = await original(...args);
    if (f.modelCalls() > 0 && !injected) {
      injected = true;
      throw Object.assign(new Error('offline deadlock'), {
        original: { code: 'ER_LOCK_DEADLOCK' },
      });
    }
    return result;
  });
  await executeGenerationRun(f.input);
  assert.equal(injected, true);
  assert.equal(f.modelCalls(), 1);
  assert.equal(f.tables.D2cRun[0].status, 'succeeded');
});
test('运行截图附件事务遇死锁不重传图片、不重复消息和实时通知', async (t) => {
  const f = await screenshotFixture();
  const table = f.mysql.models.D2cMessageAttachment;
  const original = table.create.bind(table);
  let attempts = 0;
  t.mock.method(table, 'create', async (...args: any[]) => {
    const result = await original(...args);
    if (++attempts === 1)
      throw Object.assign(new Error('offline deadlock'), {
        original: { code: 'ER_LOCK_DEADLOCK' },
      });
    return result;
  });
  await f.writer(f.value);
  assert.equal(attempts, 2);
  assert.equal(f.uploads(), 1);
  assert.equal(f.hints.length, 1);
  assert.equal(f.tables.D2cMessageAttachment.length, 1);
});
