import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  createBinaryTextBackend,
  type BinaryTextClient,
} from '../src/functions/d2c/content/backend';
import { createTextContentStore, TextContentError } from '../src/functions/d2c/content/store';

/** 全部使用内存客户端，不加载部署配置或访问真实存储。 */
function fixture() {
  let object: Uint8Array = new Uint8Array();
  const calls: Array<{ kind: string; value: unknown }> = [];
  const client: BinaryTextClient = {
    async uploadFile(input) {
      calls.push({ kind: 'put', value: input });
      object = Uint8Array.from(input.content);
      return { provider: 'memory', size: object.length, key: input.fileName };
    },
    async downloadFile(locator, options) {
      calls.push({ kind: 'get', value: { locator, options } });
      return Uint8Array.from(object);
    },
  };
  return { client, calls, backend: createBinaryTextBackend(client, 128) };
}

/** 固定错误类型和代码，异常正文不进入断言结果。 */
function failed(code: TextContentError['code']) {
  return (error: unknown) => error instanceof TextContentError && error.code === code;
}

test('通用后端传递密文、普通文件MIME和下载限额，正文工厂执行上传后回读', async () => {
  const f = fixture();
  const key = randomBytes(32).toString('base64');
  const store = createTextContentStore(f.backend, {
    maxBytes: 92,
    readKeys: () => ({ activeKeyId: 'test', keys: { test: key } }),
  });
  const controller = new AbortController();
  const ref = await store.put('session:test', 'private source', { signal: controller.signal });
  assert.equal(ref.storedSize, ref.size + 36);
  const upload = f.calls[0].value as Parameters<BinaryTextClient['uploadFile']>[0];
  assert.equal(upload.contentType, 'application/octet-stream');
  assert.equal(upload.fileName, 'd2c-bodies/' + ref.objectId + '.bin');
  assert.equal(upload.signal, controller.signal);
  assert.equal(Buffer.from(upload.content).includes(Buffer.from('private source')), false);
  const readback = f.calls[1].value as {
    locator: unknown;
    options: { maxBytes: number; signal: AbortSignal };
  };
  assert.deepEqual(readback.locator, ref.locator);
  assert.equal(readback.options.maxBytes, ref.storedSize);
  assert.equal(readback.options.signal, controller.signal);
  assert.equal(await store.read('session:test', ref), 'private source');
  assert.throws(
    () =>
      createTextContentStore(f.backend, {
        maxBytes: 93,
        readKeys: () => ({ activeKeyId: '', keys: {} }),
      }),
    failed('INVALID_CONFIG'),
  );
});

test('声明大小和后端传输上限在调用客户端前检查，兼容临界大小', async () => {
  const f = fixture();
  for (const limit of [0, -1, NaN, Infinity, 1.5])
    assert.throws(() => createBinaryTextBackend(f.client, limit), failed('INVALID_CONFIG'));
  for (const size of [undefined, 0, -1, NaN, 1.5, 129])
    await assert.rejects(f.backend.get({ size }, { maxBytes: 128 }), failed('INVALID_REFERENCE'));
  await assert.rejects(f.backend.get({ size: 9 }, { maxBytes: 8 }), failed('INVALID_REFERENCE'));
  for (const maxBytes of [0, -1, NaN, 1.5])
    await assert.rejects(f.backend.get({ size: 1 }, { maxBytes }), failed('INVALID_REFERENCE'));
  await assert.rejects(
    f.backend.put({ key: 'test.bin', bytes: new Uint8Array(129) }),
    failed('INVALID_TEXT'),
  );
  assert.equal(f.calls.length, 0);
  const locator = (await f.backend.put({ key: 'test.bin', bytes: new Uint8Array(128) })) as Record<
    string,
    unknown
  >;
  assert.equal((await f.backend.get(locator, { maxBytes: 256 })).length, 128);
  const download = f.calls.at(-1)!.value as { options: { maxBytes: number } };
  assert.equal(download.options.maxBytes, 128);
});

test('取消在请求前及客户端完成后生效，上游异常只返回固定错误', async () => {
  const f = fixture();
  const aborted = AbortSignal.abort(new Error('PRIVATE_ABORT'));
  await assert.rejects(f.backend.put({ key: 'x.bin', bytes: new Uint8Array(1), signal: aborted }), {
    name: 'AbortError',
  });
  await assert.rejects(f.backend.get({ size: 1 }, { maxBytes: 1, signal: aborted }), {
    name: 'AbortError',
  });
  assert.equal(f.calls.length, 0);
  f.client.uploadFile = async () => {
    throw new Error('PRIVATE_UPLOAD');
  };
  await assert.rejects(
    f.backend.put({ key: 'x.bin', bytes: new Uint8Array(1) }),
    failed('UPLOAD_FAILED'),
  );
  f.client.downloadFile = async () => {
    throw new Error('PRIVATE_DOWNLOAD');
  };
  await assert.rejects(f.backend.get({ size: 1 }, { maxBytes: 1 }), failed('DOWNLOAD_FAILED'));
  f.client.downloadFile = async () => {
    const error = new TextContentError('INTEGRITY_FAILED');
    error.message = 'PRIVATE_UPSTREAM';
    throw error;
  };
  await assert.rejects(f.backend.get({ size: 1 }, { maxBytes: 1 }), failed('DOWNLOAD_FAILED'));
  f.client.downloadFile = async () => new Uint8Array(2);
  await assert.rejects(f.backend.get({ size: 1 }, { maxBytes: 1 }), failed('INTEGRITY_FAILED'));
  const controller = new AbortController();
  f.client.downloadFile = async (_locator, options) => {
    assert.equal(options?.signal, controller.signal);
    controller.abort();
    return new Uint8Array(1);
  };
  await assert.rejects(f.backend.get({ size: 1 }, { maxBytes: 1, signal: controller.signal }), {
    name: 'AbortError',
  });
});
