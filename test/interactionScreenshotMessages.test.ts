import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { ToolMessage } from '@langchain/core/messages';
import { messageFixture } from './helpers/messages';
import { createRunLeases } from '../src/functions/d2c/run/leases';
import { createRunScreenshotWriter } from '../src/functions/d2c/run/screenshots';
import { resolveAttachmentImages } from '../src/functions/d2c/session/attachments';
import { prepareImageMessages } from '../src/functions/d2c/run/agent/images';
import type { AttachmentBinary } from '../src/functions/d2c/session/attachments';

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
async function fixture() {
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

test('同一预览不同动作的图片独立保存，覆盖说明区分内部滚动和定点截图', async () => {
  const f = await fixture();
  const coverage = {
    mode: 'page' as const,
    reason: 'nested_scroll' as const,
    documentHeight: 900,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    viewportHeight: 900 as const,
    nestedScroll: true,
  };
  const a = await f.writer({
    ...f.value,
    inspectionKey: 'plan-a',
    capture: { ...f.value.capture, truncated: true, coverage },
  });
  const b = await f.writer({
    ...f.value,
    inspectionKey: 'plan-b',
    capture: { ...f.value.capture, truncated: true, coverage: { ...coverage, mode: 'focused' } },
  });
  assert.notEqual(a.imageRef, b.imageRef);
  assert.equal(f.uploads(), 2);
  const texts = f.tables.D2cTimeline.map((row) => String(row.displayPayload?.text ?? '')).join(
    '\n',
  );
  assert.match(texts, /内部滚动区域/);
  assert.match(texts, /仅展示目标区域/);
  assert.doesNotMatch(texts, /截图已达到高度上限/);
});
