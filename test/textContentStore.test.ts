import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  createTextContentStore,
  TextContentError,
  type TextContentBackend,
  type TextContentKeys,
} from '../src/functions/d2c/content/store';

/** 密钥随机生成且不出现在断言输出中，后端仅内存字节替身，不连接真实对象存储。 */
function fixture(maxBytes = 8192, concurrency = 2) {
  let config: TextContentKeys = {
    activeKeyId: 'key-1',
    keys: { 'key-1': randomBytes(32).toString('base64') },
  };
  const objects = new Map<string, Buffer>();
  const calls: Array<{ kind: 'put' | 'get'; key: string; maxBytes?: number }> = [];
  const backend: TextContentBackend = {
    maxObjectBytes: maxBytes + 36,
    async put({ key, bytes }) {
      calls.push({ kind: 'put', key });
      assert.equal(objects.has(key), false);
      objects.set(key, Buffer.from(bytes));
      return { provider: 'memory', key };
    },
    async get(locator, { maxBytes: maximum }) {
      calls.push({ kind: 'get', key: String(locator.key), maxBytes: maximum });
      const value = objects.get(String(locator.key));
      if (!value || value.length > maximum) throw new Error('PRIVATE_STORAGE_FAILURE');
      return Buffer.from(value);
    },
  };
  const store = createTextContentStore(backend, { maxBytes, concurrency, readKeys: () => config });
  return {
    backend,
    store,
    objects,
    calls,
    rotate: (value: TextContentKeys) => {
      config = value;
    },
    keys: () => config,
  };
}

const failed = (code: TextContentError['code']) => (error: unknown) =>
  error instanceof TextContentError && error.code === code;

test('空文本、BOM、中文和换行原样往返；只上传密文，准备引用前核验上传对象', async () => {
  const f = fixture();
  for (const text of ['', '\uFEFF中文\nline\r\n<source>']) {
    const ref = await f.store.put('session:one', text);
    assert.equal(ref.size, Buffer.byteLength(text));
    assert.equal(ref.storedSize, ref.size + 36);
    assert.equal(ref.format, 'pixelprint.text.v1');
    assert.equal(ref.encoding, 'utf-8');
    const last = f.calls.at(-1)!;
    assert.equal(last.kind, 'get');
    assert.equal(last.maxBytes, ref.storedSize);
    const raw = f.objects.get(String(ref.locator.key))!;
    if (text) assert.equal(raw.includes(Buffer.from(text)), false);
    assert.equal(await f.store.read('session:one', JSON.parse(JSON.stringify(ref))), text);
  }
});

test('同文重新写入产生独立对象，冻结的旧引用继续读取旧内容', async () => {
  const f = fixture();
  const first = await f.store.put('session:one', 'old');
  const again = await f.store.put('session:one', 'old');
  const current = await f.store.put('session:one', 'new');
  assert.notEqual(first.objectId, again.objectId);
  assert.notDeepEqual(first.locator, current.locator);
  assert.notDeepEqual([...f.objects.values()][0], [...f.objects.values()][1]);
  assert.equal(await f.store.read('session:one', first), 'old');
  assert.equal(await f.store.read('session:one', current), 'new');
});

test('密钥轮换保留旧读取能力；缺失历史密钥在访问存储前失败', async () => {
  const f = fixture();
  const ref = await f.store.put('session:one', 'old key body');
  const oldKeys = f.keys().keys;
  const newKeys = { 'key-2': randomBytes(32).toString('base64') };
  f.rotate({ activeKeyId: 'key-2', keys: { ...oldKeys, ...newKeys } });
  assert.equal(await f.store.read('session:one', ref), 'old key body');
  assert.equal((await f.store.put('session:one', 'new key body')).keyId, 'key-2');
  f.rotate({ activeKeyId: 'key-2', keys: newKeys });
  const count = f.calls.length;
  await assert.rejects(f.store.read('session:one', ref), failed('INVALID_CONFIG'));
  assert.equal(f.calls.length, count);
});

test('跨范围和篡改身份、大小、摘要、密文均明确失败，不返回部分或过期正文', async () => {
  const f = fixture();
  const ref = await f.store.put('session:one', 'source');
  const before = f.calls.length;
  await assert.rejects(f.store.read('session:other', ref), failed('INVALID_REFERENCE'));
  assert.equal(f.calls.length, before);
  for (const patch of [
    { sha256: 'a'.repeat(64) },
    { objectId: '00000000-0000-4000-8000-000000000000' },
    { scope: 'session:other' },
  ])
    await assert.rejects(
      f.store.read(patch.scope ?? 'session:one', { ...ref, ...patch }),
      failed('INTEGRITY_FAILED'),
    );
  await assert.rejects(
    f.store.read('session:one', { ...ref, storedSize: 0 }),
    failed('INVALID_REFERENCE'),
  );
  const packet = f.objects.get(String(ref.locator.key))!;
  packet[packet.length - 1] ^= 1;
  await assert.rejects(f.store.read('session:one', ref), failed('INTEGRITY_FAILED'));
  packet[0] ^= 1;
  await assert.rejects(f.store.read('session:one', ref), failed('INTEGRITY_FAILED'));
});

test('无效UTF-8、超限文本和超出底层单对象上限均在上传前拒绝', async () => {
  const f = fixture(8);
  for (const text of ['\ud800', '九个中文字超过8字节'])
    await assert.rejects(f.store.put('session:one', text), failed('INVALID_TEXT'));
  assert.equal(f.calls.length, 0);
  assert.throws(
    () =>
      createTextContentStore(
        { ...f.backend, maxObjectBytes: 40 },
        { maxBytes: 8, readKeys: f.keys },
      ),
    failed('INVALID_CONFIG'),
  );
  f.rotate({ activeKeyId: 'wrong-key', keys: { 'wrong-key': 'PRIVATE_NOT_A_KEY' } });
  await assert.rejects(f.store.put('session:one', 'okay'), failed('INVALID_CONFIG'));
});

test('存储失败、上传后损坏与下载超限不产生可提交引用，不泄漏上游异常正文', async () => {
  const f = fixture();
  f.backend.put = async () => {
    throw new Error('PRIVATE_STORAGE_BODY');
  };
  await assert.rejects(
    f.store.put('session:one', 'body'),
    (e: unknown) => failed('UPLOAD_FAILED')(e) && !String(e).includes('PRIVATE'),
  );
  const corrupt = fixture();
  corrupt.backend.get = async () => new Uint8Array([1]);
  await assert.rejects(corrupt.store.put('session:one', 'body'), failed('INTEGRITY_FAILED'));
  const unavailable = fixture();
  unavailable.backend.get = async () => {
    throw new Error('PRIVATE_DOWNLOAD');
  };
  await assert.rejects(unavailable.store.put('session:one', 'body'), failed('VERIFY_FAILED'));
  const large = fixture();
  const ref = await large.store.put('session:one', 'body');
  large.backend.get = async () => new Uint8Array(ref.storedSize + 1);
  await assert.rejects(large.store.read('session:one', ref), failed('INTEGRITY_FAILED'));
});

test('引用与定位拒绝getter、函数、原型和过深JSON，getter不会被执行', async () => {
  const f = fixture();
  const ref = await f.store.put('session:one', 'body');
  let reads = 0;
  const dangerous = {
    get key() {
      reads++;
      return 'ignored';
    },
  };
  await assert.rejects(
    f.store.read('session:one', { ...ref, locator: dangerous }),
    failed('INVALID_REFERENCE'),
  );
  assert.equal(reads, 0);
  for (const locator of [
    Object.create({ inherited: true }),
    { value: () => null },
    { a: { b: { c: { d: { e: { f: { g: {} } } } } } } },
  ])
    await assert.rejects(
      f.store.read('session:one', { ...ref, locator }),
      failed('INVALID_REFERENCE'),
    );
  f.backend.put = async () => 'not-a-locator';
  await assert.rejects(f.store.put('session:one', 'body'), failed('INVALID_REFERENCE'));
});

test('并发有界且排队取消不上传；取消和上游故障都释放槽位', async () => {
  const f = fixture(16, 1);
  const original = f.backend.put;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.backend.put = async (input) => {
    await gate;
    return original(input);
  };
  const first = f.store.put('session:one', 'first');
  const controller = new AbortController();
  const pending = f.store.put('session:one', 'cancelled', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  const next = f.store.put('session:one', 'next');
  release();
  await Promise.all([first, next]);
  assert.equal(f.calls.filter((c) => c.kind === 'put').length, 2);
  f.backend.put = async () => {
    throw new Error('private');
  };
  await assert.rejects(f.store.put('session:one', 'failed'), failed('UPLOAD_FAILED'));
  f.backend.put = original;
  assert.equal(
    await f.store.read('session:one', await f.store.put('session:one', 'after')),
    'after',
  );
});

test('等待队列同时限制字节与数量，取消等待后允许后续请求', async () => {
  const f = fixture(8, 1);
  const original = f.backend.put;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.backend.put = async (input) => {
    await gate;
    return original(input);
  };
  const first = f.store.put('session:one', '12345678');
  const pending = [f.store.put('session:one', '12345678'), f.store.put('session:one', '12345678')];
  await assert.rejects(f.store.put('session:one', 'x'), failed('BUSY'));
  release();
  await Promise.all([first, ...pending]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.store.put('session:one', 'x', { signal: controller.signal }), {
    name: 'AbortError',
  });
});

test('定位预算在写入和完整引用读取间保持一致，边界大小定位能够往返', async () => {
  const f = fixture();
  const original = f.backend.put;
  f.backend.put = async (input) => ({
    ...((await original(input)) as Record<string, unknown>),
    a: 'a'.repeat(4000),
    b: 'b'.repeat(4000),
    c: 'c'.repeat(4000),
    d: 'd'.repeat(4000),
  });
  const ref = await f.store.put('session:one', 'body');
  assert.equal(await f.store.read('session:one', ref), 'body');
  const wide = fixture();
  const savedPut = wide.backend.put;
  wide.backend.put = async (input) => ({
    ...((await savedPut(input)) as Record<string, unknown>),
    ...Object.fromEntries(Array.from({ length: 120 }, (_, i) => ['v' + i, i])),
  });
  const manyKeys = await wide.store.put('session:one', 'many');
  assert.equal(await wide.store.read('session:one', manyKeys), 'many');
});

test('后端修改上传Buffer不能改变核验基准，损坏对象不产生引用', async () => {
  const f = fixture();
  const original = f.backend.put;
  f.backend.put = async (input) => {
    input.bytes[input.bytes.length - 1] ^= 1;
    return original(input);
  };
  await assert.rejects(f.store.put('session:one', 'body'), failed('INTEGRITY_FAILED'));
});

test('Proxy反射异常转换为固定错误，序列化不执行Proxy的get或toJSON', async () => {
  const f = fixture();
  const ref = await f.store.put('session:one', 'body');
  const trapped = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error('PRIVATE_PROXY_BODY');
      },
    },
  );
  await assert.rejects(
    f.store.read('session:one', { ...ref, locator: trapped }),
    (error: unknown) => failed('INVALID_REFERENCE')(error) && !String(error).includes('PRIVATE'),
  );
  f.backend.put = async () => trapped;
  await assert.rejects(f.store.put('session:one', 'body'), failed('INVALID_REFERENCE'));
  const valid = fixture();
  const original = valid.backend.put;
  let gets = 0;
  valid.backend.put = async (input) =>
    new Proxy((await original(input)) as Record<string, unknown>, {
      get(_target, name) {
        if (name === 'then') return undefined;
        gets++;
        throw new Error('PRIVATE_GET');
      },
    });
  const safe = await valid.store.put('session:one', 'body');
  assert.equal(await valid.store.read('session:one', safe), 'body');
  assert.equal(gets, 0);
});
