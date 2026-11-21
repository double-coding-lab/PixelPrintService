import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createBinaryTextBackend } from '../src/functions/d2c/content/backend';
import { createTextContentStore } from '../src/functions/d2c/content/store';

/** 仅加载公开示例生成的临时测试配置，不读取真实配置或访问S3。 */
const temporary = await mkdtemp(path.join(tmpdir(), 'pixelprint-download-'));
const sample = JSON.parse(await readFile('project.config.example.json', 'utf8'));
sample.auth = {
  sessionSecret: 'offline-download-'.repeat(3),
  sessionTtlSeconds: 3600,
  users: [{ id: 'offline', name: 'Offline', passwordHash: 'scrypt$offline' }],
};
sample.storage = {
  driver: 'local',
  directory: path.join(temporary, 'files'),
  publicUrl: 'http://localhost:3000/files/',
  bucket: 'offline',
  region: 'us-east-1',
  endpoint: '',
  accessKeyId: '',
  secretAccessKey: '',
  forcePathStyle: true,
};
const filename = path.join(temporary, 'config.json');
await writeFile(filename, JSON.stringify(sample));
const previous = process.env.PIXELPRINT_CONFIG;
process.env.PIXELPRINT_CONFIG = filename;
const { projectConfig } = await import('../src/config/project');
const { createStorageFileClient, StorageError } = await import('../src/hooks/tools/storage');
const localSettings = { ...projectConfig.storage };
const runtime = () => ({ d2c: { storage: { enabled: true }, limits: { uploadBytes: 200_000 } } });
const content = Buffer.from('ciphertext');

/** 故障只核对安全分类，不记录存储响应或调用方取消原因。 */
function reason(expected: string) {
  return (error: unknown) => error instanceof StorageError && error.reason === expected;
}

after(async () => {
  Object.assign(projectConfig.storage, localSettings);
  if (previous === undefined) delete process.env.PIXELPRINT_CONFIG;
  else process.env.PIXELPRINT_CONFIG = previous;
  await rm(temporary, { recursive: true, force: true });
});

test('local:兼容旧下载签名，限额、取消与正文适配器可离线往返', async () => {
  const client = createStorageFileClient(runtime);
  const locator = await client.uploadFile({
    content,
    fileName: 'body.bin',
    contentType: 'application/octet-stream',
  });
  assert.deepEqual(await client.downloadFile(locator), content);
  assert.deepEqual(await client.downloadFile(locator, { maxBytes: content.length }), content);
  await assert.rejects(client.downloadFile(locator, { maxBytes: 3 }), reason('INTEGRITY'));
  for (const maxBytes of [0, -1, NaN, 1.5])
    await assert.rejects(client.downloadFile(locator, { maxBytes }), reason('INVALID_INPUT'));
  await assert.rejects(
    client.downloadFile(locator, { signal: AbortSignal.abort(new Error('PRIVATE_ABORT')) }),
    reason('ABORTED'),
  );
  const key = randomBytes(32).toString('base64');
  const store = createTextContentStore(createBinaryTextBackend(client, 200_000), {
    maxBytes: 199_964,
    readKeys: () => ({ activeKeyId: 'offline', keys: { offline: key } }),
  });
  const ref = await store.put('session:offline', 'private source');
  assert.equal(await store.read('session:offline', ref), 'private source');
  const packet = await readFile(path.join(localSettings.directory, String(ref.locator.fileName)));
  assert.equal(packet.includes(Buffer.from('private source')), false);
});

test('local:分块读取期间取消，不继续读取后续块且释放文件句柄', async (t) => {
  const client = createStorageFileClient(runtime);
  const data = Buffer.alloc(140_000, 1);
  const locator = await client.uploadFile({
    content: data,
    fileName: 'large.bin',
    contentType: 'application/octet-stream',
  });
  const probe = await open(path.join(localSettings.directory, locator.fileName));
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const read = prototype.read;
  const controller = new AbortController();
  let reads = 0;
  let opened: { fd: number } | undefined;
  t.mock.method(prototype, 'read', async function (this: { fd: number }, ...args: unknown[]) {
    opened = this;
    reads++;
    const result = await Reflect.apply(read, this, args);
    controller.abort();
    return result;
  });
  await assert.rejects(
    client.downloadFile(locator, { signal: controller.signal }),
    reason('ABORTED'),
  );
  assert.equal(reads, 1);
  assert.equal(opened?.fd, -1);
});

test('S3:在请求和响应流中传递取消，阻塞响应体也会销毁', { timeout: 3000 }, async (t) => {
  Object.assign(projectConfig.storage, { driver: 's3' });
  t.after(() => Object.assign(projectConfig.storage, localSettings));
  const client = createStorageFileClient(runtime);
  const locator = {
    provider: 's3',
    fileName: 'body.bin',
    url: localSettings.publicUrl + 'body.bin',
    size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    mimeType: 'application/octet-stream',
  };
  let requestSignal: AbortSignal | undefined;
  const controller = new AbortController();
  t.mock.method(
    S3Client.prototype,
    'send',
    async (_command: unknown, options: { abortSignal: AbortSignal }) => {
      requestSignal = options.abortSignal;
      return new Promise((_resolve, reject) => {
        options.abortSignal.addEventListener(
          'abort',
          () => reject(new DOMException('', 'AbortError')),
          { once: true },
        );
      });
    },
  );
  const pending = client.downloadFile(locator, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, reason('ABORTED'));
  assert.equal(requestSignal?.aborted, true);
  t.mock.restoreAll();
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const body = new Readable({
    read() {
      started();
    },
  });
  t.mock.method(
    S3Client.prototype,
    'send',
    async (_command: unknown, options: { abortSignal: AbortSignal }) => {
      requestSignal = options.abortSignal;
      return { Body: body, ContentLength: content.length };
    },
  );
  const stop = new AbortController();
  const reading = client.downloadFile(locator, { signal: stop.signal });
  await waiting;
  stop.abort(new Error('PRIVATE_ABORT'));
  await assert.rejects(reading, reason('ABORTED'));
  assert.equal(body.destroyed, true);
  assert.equal(getEventListeners(requestSignal!, 'abort').length, 0);
});

test('S3:调用方和声明大小都约束实际流，缺失ContentLength也不能绕过', async (t) => {
  Object.assign(projectConfig.storage, { driver: 's3' });
  t.after(() => Object.assign(projectConfig.storage, localSettings));
  const client = createStorageFileClient(runtime);
  const locator = {
    provider: 's3',
    fileName: 'body.bin',
    url: localSettings.publicUrl + 'body.bin',
    size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    mimeType: 'application/octet-stream',
  };
  let bytes = content;
  let length: number | undefined = content.length;
  let body: Readable;
  let requestSignal: AbortSignal | undefined;
  t.mock.method(
    S3Client.prototype,
    'send',
    async (command: unknown, options: { abortSignal: AbortSignal }) => {
      assert.ok(command instanceof GetObjectCommand);
      assert.equal(options.abortSignal.aborted, false);
      requestSignal = options.abortSignal;
      body = Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]);
      return { Body: body, ContentLength: length };
    },
  );
  assert.deepEqual(await client.downloadFile(locator), content);
  await assert.rejects(client.downloadFile(locator, { maxBytes: 3 }), reason('INTEGRITY'));
  assert.equal(body!.destroyed, true);
  length = undefined;
  await assert.rejects(client.downloadFile(locator, { maxBytes: 3 }), reason('INTEGRITY'));
  bytes = Buffer.alloc(content.length + 1);
  await assert.rejects(client.downloadFile(locator), reason('INTEGRITY'));
  bytes = Buffer.alloc(content.length);
  await assert.rejects(client.downloadFile(locator), reason('INTEGRITY'));
  assert.equal(body!.destroyed, true);
  assert.equal(getEventListeners(requestSignal!, 'abort').length, 0);
  await assert.rejects(
    client.downloadFile({ ...locator, url: 'https://example.com/private' }),
    reason('INVALID_INPUT'),
  );
  await assert.rejects(
    createStorageFileClient(() => ({ d2c: { limits: { uploadBytes: 3 } } })).downloadFile(locator),
    reason('INVALID_INPUT'),
  );
});
