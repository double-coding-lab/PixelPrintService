import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import {
  resolveAttachmentImages,
  type AttachmentBinary,
} from '../src/functions/d2c/session/attachments';
import { messageFixture } from './helpers/messages';

/** 真实 PNG 数据和 CRC；测试不访问网络或持久对象存储。 */
function png() {
  const chunk = (type: string, body: Buffer) => {
    const result = Buffer.alloc(body.length + 12);
    result.writeUInt32BE(body.length);
    result.write(type, 4);
    body.copy(result, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, result.length - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(5))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 验证正式 resolver 的重复下载优化、当前版本/权限重验、错误传播及 Run 隔离。 */
test('run attachment cache revalidates the row and never masks errors on a changed version', async () => {
  const f = await messageFixture();
  const data = png();
  const attachmentId = 'image-cache-test';
  const row: Record<string, any> = {
    attachmentId,
    sessionId: f.id,
    userId: 'employee-a',
    messageId: 'sent',
    expiresAt: null,
    sha256: createHash('sha256').update(data).digest('hex'),
    size: data.length,
    mimeType: 'image/png',
    width: 1,
    height: 1,
    objectLocator: { version: 1 },
  };
  let reads = 0;
  let downloads = 0;
  let unavailable = false;
  Object.assign(f.mysql.models, {
    D2cMessageAttachment: {
      findOne: async () => {
        reads++;
        return row;
      },
    },
  });
  const binary: AttachmentBinary = {
    uploadFile: async () => {
      throw new Error('unexpected upload');
    },
    downloadFile: async () => {
      downloads++;
      if (unavailable) throw new Error('private upstream');
      return Buffer.from(data);
    },
  };
  const ref = `attachment://${attachmentId}`;
  const resolver = resolveAttachmentImages(f.mysql, binary, 'employee-a', f.id);
  const first = (await resolver(ref))!;
  first.data.fill(0);
  assert.deepEqual((await resolver(ref))!.data, data);
  assert.equal(downloads, 1);
  assert.equal(reads, 2);
  // Same digest with a changed storage input must invalidate.
  row.objectLocator = { version: 2 };
  await resolver(ref);
  assert.equal(downloads, 2);
  row.sha256 = 'f'.repeat(64);
  await assert.rejects(resolver(ref), { reason: 'ATTACHMENT_CORRUPT' });
  assert.equal(downloads, 3);
  unavailable = true;
  await assert.rejects(resolver(ref), { reason: 'ATTACHMENT_STORAGE_UNAVAILABLE' });
  unavailable = false;
  row.sha256 = createHash('sha256').update(data).digest('hex');
  // Separate Run resolver cannot reuse the previous Run cache.
  await resolveAttachmentImages(f.mysql, binary, 'employee-a', f.id)(ref);
  assert.equal(downloads, 5);
  row.expiresAt = new Date(0);
  await assert.rejects(resolver(ref), { reason: 'ATTACHMENT_NOT_FOUND' });
  row.expiresAt = null;
  await assert.rejects(resolveAttachmentImages(f.mysql, binary, 'employee-b', f.id)(ref), {
    reason: 'WORKSPACE_NOT_FOUND',
  });
});
