import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  createBinaryContentStore,
  parseBinaryContentReference,
  type BinaryContentReference,
} from '../src/functions/d2c/content/binaryStore';
import {
  createTextContentStore,
  TextContentError,
  type TextContentBackend,
  type TextContentKeys,
} from '../src/functions/d2c/content/store';

const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const failure = (code: TextContentError['code']) => (error: unknown) => {
  assert.ok(error instanceof TextContentError);
  assert.equal(error.code, code);
  assert.doesNotMatch(String(error), /PRIVATE/);
  assert.equal(error.cause, undefined);
  return true;
};

/** Real AES/GCM and zlib; only external object transport is replaced with bounded memory I/O. */
function fixture(maxBytes = 8192, concurrency = 2) {
  let keys: TextContentKeys = {
    activeKeyId: 'binary-1',
    keys: { 'binary-1': randomBytes(32).toString('base64') },
  };
  const objects = new Map<string, Buffer>();
  const calls: Array<{
    kind: 'put' | 'get';
    key: string;
    maxBytes?: number;
    signal?: AbortSignal;
  }> = [];
  const backend: TextContentBackend = {
    maxObjectBytes: maxBytes + 36,
    async put({ key, bytes, signal }) {
      assert.equal(objects.has(key), false, 'Objects must never be overwritten');
      calls.push({ kind: 'put', key, signal });
      objects.set(key, Buffer.from(bytes));
      return { provider: 'memory', key };
    },
    async get(locator, { maxBytes: maximum, signal }) {
      calls.push({ kind: 'get', key: String(locator.key), maxBytes: maximum, signal });
      const bytes = objects.get(String(locator.key));
      if (!bytes || bytes.length > maximum) throw new Error('PRIVATE_BACKEND_RESPONSE');
      return Buffer.from(bytes);
    },
  };
  const store = createBinaryContentStore(backend, { maxBytes, concurrency, readKeys: () => keys });
  return {
    backend,
    store,
    objects,
    calls,
    keys: () => keys,
    rotate: (next: TextContentKeys) => {
      keys = next;
    },
  };
}

/** Build an authenticated transport fixture independently, including intentionally hostile gzip. */
function seal(
  f: ReturnType<typeof fixture>,
  base: BinaryContentReference,
  payload: Uint8Array,
  patch: Partial<BinaryContentReference>,
) {
  const reference = { ...base, ...patch, storedSize: payload.length + 36 };
  const iv = randomBytes(12);
  const key = Buffer.from(f.keys().keys[reference.keyId], 'base64');
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(
      Buffer.from(
        JSON.stringify([
          reference.format,
          reference.objectId,
          reference.scope,
          reference.keyId,
          reference.encoding,
          reference.compression,
          reference.size,
          reference.storedSize,
          reference.sha256,
        ]),
      ),
    );
    const bytes = Buffer.concat([cipher.update(payload), cipher.final()]);
    f.objects.set(
      String(reference.locator.key),
      Buffer.concat([Buffer.from('PPBLB01\0'), iv, cipher.getAuthTag(), bytes]),
    );
    return reference;
  } finally {
    key.fill(0);
  }
}

test('arbitrary typed bytes, sliced views, NUL and empty values round-trip without text conversion', async () => {
  const f = fixture();
  const allBytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  const backing = new Uint8Array([9, 0xff, 0xfe, 0x80, 0, 0xc0, 0xaf, 8]);
  for (const value of [new Uint8Array(), allBytes, backing.subarray(1, 7)]) {
    const expected = Buffer.from(value);
    const reference = await f.store.put('checkpoint:session-one', value);
    assert.equal(reference.format, 'pixelprint.blob.v1');
    assert.equal(reference.encoding, 'binary');
    assert.equal(reference.compression, 'none');
    assert.equal(reference.size, expected.length);
    assert.equal(reference.storedSize, expected.length + 36);
    assert.equal(reference.sha256, sha(expected));
    assert.equal(reference.locator.key, `d2c-checkpoint-bodies/${reference.objectId}.bin`);
    assert.equal(f.calls.at(-1)!.kind, 'get');
    assert.equal(f.calls.at(-1)!.maxBytes, reference.storedSize);
    assert.deepEqual(
      Buffer.from(await f.store.read(reference.scope, JSON.parse(JSON.stringify(reference)))),
      expected,
    );
  }
});

test('gzip is used only when smaller; random incompressible bytes retain the original payload size', async () => {
  const f = fixture();
  const compressible = Buffer.alloc(8192, 0xff);
  const compressed = await f.store.put('checkpoint:one', compressible);
  assert.equal(compressed.compression, 'gzip');
  assert.ok(compressed.storedSize < compressed.size + 36);
  assert.deepEqual(Buffer.from(await f.store.read(compressed.scope, compressed)), compressible);
  const random = randomBytes(4096);
  const plain = await f.store.put('checkpoint:one', random);
  assert.equal(plain.compression, 'none');
  assert.equal(plain.storedSize, random.length + 36);
  assert.deepEqual(Buffer.from(await f.store.read(plain.scope, plain)), random);
  assert.equal(f.objects.get(String(plain.locator.key))!.includes(random), false);
});

test('input is copied before compression or queuing, and every write uses a fresh immutable object', async () => {
  const f = fixture(8192, 1);
  const originalPut = f.backend.put;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.backend.put = async (input) => {
    started();
    await gate;
    return originalPut(input);
  };
  const firstBytes = randomBytes(64);
  const expectedFirst = Buffer.from(firstBytes);
  const first = f.store.put('checkpoint:one', firstBytes);
  firstBytes.fill(0);
  await entered;
  const queuedBytes = new Uint8Array([0xff, 0, 0xfe]);
  const queued = f.store.put('checkpoint:one', queuedBytes);
  queuedBytes.fill(1);
  release();
  const [a, b] = await Promise.all([first, queued]);
  assert.deepEqual(Buffer.from(await f.store.read(a.scope, a)), expectedFirst);
  assert.deepEqual(Buffer.from(await f.store.read(b.scope, b)), Buffer.from([0xff, 0, 0xfe]));
  const again = await f.store.put(a.scope, expectedFirst);
  assert.notEqual(again.objectId, a.objectId);
  assert.notDeepEqual(again.locator, a.locator);
  assert.notDeepEqual(
    f.objects.get(String(again.locator.key)),
    f.objects.get(String(a.locator.key)),
  );
  assert.equal(f.objects.size, 3);
});

test('cross-scope reads and text references are rejected before touching transport', async () => {
  const f = fixture();
  const reference = await f.store.put('checkpoint:one', Buffer.from([0xff]));
  const before = f.calls.length;
  await assert.rejects(f.store.read('checkpoint:two', reference), failure('INVALID_REFERENCE'));
  assert.equal(f.calls.length, before);
  assert.throws(
    () =>
      parseBinaryContentReference({
        ...reference,
        format: 'pixelprint.text.v1',
        encoding: 'utf-8',
      }),
    failure('INVALID_REFERENCE'),
  );
  const textStore = createTextContentStore(f.backend, { maxBytes: 8192, readKeys: f.keys });
  const textReference = await textStore.put('checkpoint:one', 'text');
  await assert.rejects(f.store.read('checkpoint:one', textReference), failure('INVALID_REFERENCE'));
  await assert.rejects(textStore.read('checkpoint:one', reference), failure('INVALID_REFERENCE'));
});

test('scope, object identity, key alias, sizes and hash are authenticated, and locators cannot be swapped', async () => {
  const f = fixture();
  const reference = await f.store.put('checkpoint:one', Buffer.alloc(4096, 0x80));
  f.rotate({ ...f.keys(), keys: { ...f.keys().keys, alias: f.keys().keys['binary-1'] } });
  for (const patch of [
    { scope: 'checkpoint:two' },
    { objectId: randomUUID() },
    { keyId: 'alias' },
    { sha256: '0'.repeat(64) },
    { size: reference.size - 1 },
    { storedSize: reference.storedSize + 1 },
  ]) {
    await assert.rejects(
      f.store.read(patch.scope ?? reference.scope, { ...reference, ...patch }),
      failure('INTEGRITY_FAILED'),
    );
  }
  await assert.rejects(
    f.store.read(reference.scope, { ...reference, compression: 'none' }),
    failure('INVALID_REFERENCE'),
  );
  const a = await f.store.put('checkpoint:one', randomBytes(64));
  const b = await f.store.put('checkpoint:one', randomBytes(64));
  await assert.rejects(
    f.store.read(a.scope, { ...a, locator: b.locator }),
    failure('INTEGRITY_FAILED'),
  );
  assert.deepEqual(
    Buffer.from(await f.store.read(reference.scope, reference)),
    Buffer.alloc(4096, 0x80),
  );
});

test('rotation reads old and new key versions; missing or noncanonical key material fails privately', async () => {
  const f = fixture();
  const reference = await f.store.put('checkpoint:one', Buffer.from([0xff, 0xfe]));
  const old = f.keys().keys;
  const next = { 'binary-2': randomBytes(32).toString('base64') };
  f.rotate({ activeKeyId: 'binary-2', keys: { ...old, ...next } });
  assert.deepEqual(
    Buffer.from(await f.store.read(reference.scope, reference)),
    Buffer.from([0xff, 0xfe]),
  );
  assert.equal((await f.store.put('checkpoint:one', Buffer.from([1]))).keyId, 'binary-2');
  f.rotate({ activeKeyId: 'binary-2', keys: next });
  const count = f.calls.length;
  await assert.rejects(f.store.read(reference.scope, reference), failure('INVALID_CONFIG'));
  assert.equal(f.calls.length, count);
  for (const key of [
    'PRIVATE_BAD_KEY',
    randomBytes(31).toString('base64'),
    'A'.repeat(42) + 'B=',
  ]) {
    f.rotate({ activeKeyId: 'bad', keys: { bad: key } });
    await assert.rejects(
      f.store.put('checkpoint:one', Buffer.from([1])),
      failure('INVALID_CONFIG'),
    );
  }
  const broken = createBinaryContentStore(f.backend, {
    maxBytes: 8192,
    readKeys: () => {
      throw new Error('PRIVATE_KEY_PROVIDER');
    },
  });
  await assert.rejects(broken.put('checkpoint:one', Buffer.from([1])), failure('INVALID_CONFIG'));
  await assert.rejects(broken.read(reference.scope, reference), failure('INVALID_CONFIG'));
});

test('reference parsing is strict JSON, detached from input, and never runs getters or proxy get hooks', async () => {
  const f = fixture();
  const reference = await f.store.put('checkpoint:one', Buffer.from([1]));
  const copy = parseBinaryContentReference(reference);
  reference.locator.provider = 'changed';
  assert.equal(copy.locator.provider, 'memory');
  let getterCalls = 0;
  const getter = {
    get key() {
      getterCalls++;
      throw new Error('PRIVATE_GETTER');
    },
  };
  const topGetter = { ...copy };
  Object.defineProperty(topGetter, 'scope', {
    get() {
      getterCalls++;
      return 'checkpoint:one';
    },
    enumerable: true,
  });
  for (const value of [
    null,
    [],
    new Date(),
    topGetter,
    { ...copy, locator: getter },
    { ...copy, locator: Object.create({ inherited: true }) },
    { ...copy, locator: { callback: () => 1 } },
    { ...copy, locator: { a: { b: { c: { d: { e: { f: { g: {} } } } } } } } },
    { ...copy, unknown: true },
    { ...copy, encoding: 'base64' },
    { ...copy, compression: 'br' },
    { ...copy, size: 128 * 1024 * 1024 + 1 },
    { ...copy, storedSize: copy.storedSize + 1 },
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('PRIVATE_PROXY');
        },
      },
    ),
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('PRIVATE_PROXY');
        },
      },
    ),
  ])
    assert.throws(() => parseBinaryContentReference(value), failure('INVALID_REFERENCE'));
  assert.equal(getterCalls, 0);
  const proxy = new Proxy(copy, {
    get() {
      getterCalls++;
      throw new Error('PRIVATE_GET');
    },
  });
  assert.deepEqual(parseBinaryContentReference(proxy), copy);
  assert.equal(getterCalls, 0);
});

test('malformed upload locators are rejected with fixed errors; maximum locator budgets can round-trip', async () => {
  const f = fixture();
  const originalPut = f.backend.put;
  f.backend.put = async (input) => ({
    ...((await originalPut(input)) as object),
    a: 'a'.repeat(4000),
    b: 'b'.repeat(4000),
    c: 'c'.repeat(4000),
    d: 'd'.repeat(4000),
  });
  const reference = await f.store.put('checkpoint:one', Buffer.from([1, 2]));
  assert.deepEqual(
    Buffer.from(await f.store.read(reference.scope, reference)),
    Buffer.from([1, 2]),
  );
  for (const value of [
    'PRIVATE_NOT_A_LOCATOR',
    {
      get key() {
        throw new Error('PRIVATE_GETTER');
      },
    },
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('PRIVATE_PROXY');
        },
      },
    ),
  ]) {
    f.backend.put = async () => value;
    await assert.rejects(
      f.store.put('checkpoint:one', Buffer.from([1])),
      failure('INVALID_REFERENCE'),
    );
  }
});

test('limits reject nonbytes, oversized input, invalid scope, backend capacity and invalid concurrency', async () => {
  const f = fixture(8);
  for (const value of ['YWJj', new Float32Array(1), new ArrayBuffer(1), null, new Uint8Array(9)]) {
    await assert.rejects(
      f.store.put('checkpoint:one', value as Uint8Array),
      failure('INVALID_TEXT'),
    );
  }
  for (const scope of ['', 'bad scope', '../checkpoint', 'a'.repeat(201)])
    await assert.rejects(f.store.put(scope, Buffer.from([1])), failure('INVALID_REFERENCE'));
  assert.equal(f.calls.length, 0);
  for (const maxBytes of [0, NaN, 128 * 1024 * 1024 + 1])
    assert.throws(
      () => createBinaryContentStore(f.backend, { maxBytes, readKeys: f.keys }),
      failure('INVALID_CONFIG'),
    );
  for (const concurrency of [0, 9, 1.5])
    assert.throws(
      () => createBinaryContentStore(f.backend, { maxBytes: 8, concurrency, readKeys: f.keys }),
      failure('INVALID_CONFIG'),
    );
  assert.throws(
    () =>
      createBinaryContentStore(
        { ...f.backend, maxObjectBytes: 43 },
        { maxBytes: 8, readKeys: f.keys },
      ),
    failure('INVALID_CONFIG'),
  );
  const large = fixture(64);
  const reference = await large.store.put('checkpoint:one', Buffer.alloc(64));
  await assert.rejects(f.store.read(reference.scope, reference), failure('INVALID_REFERENCE'));
});

test('authenticated gzip is bounded by original size, rejects bombs/multiple members and corrupt streams', async () => {
  const f = fixture();
  const base = await f.store.put('checkpoint:one', Buffer.from([1]));
  const expected = Buffer.alloc(1024, 0xff);
  const good = seal(f, base, gzipSync(expected), {
    compression: 'gzip',
    size: expected.length,
    sha256: sha(expected),
  });
  assert.deepEqual(Buffer.from(await f.store.read(good.scope, good)), expected);
  const bomb = seal(f, base, gzipSync(Buffer.alloc(64 * 1024)), {
    compression: 'gzip',
    size: 256,
    sha256: sha(Buffer.alloc(256)),
  });
  await assert.rejects(f.store.read(bomb.scope, bomb), failure('INTEGRITY_FAILED'));
  const multiple = seal(f, base, Buffer.concat([gzipSync(expected), gzipSync(expected)]), {
    compression: 'gzip',
    size: expected.length,
    sha256: sha(expected),
  });
  await assert.rejects(f.store.read(multiple.scope, multiple), failure('INTEGRITY_FAILED'));
  const corrupt = seal(f, base, Buffer.from('not gzip'), {
    compression: 'gzip',
    size: 1024,
    sha256: sha(expected),
  });
  await assert.rejects(f.store.read(corrupt.scope, corrupt), failure('INTEGRITY_FAILED'));
});

test('packet corruption, truncated and oversized downloads fail before returning bytes', async () => {
  for (const offset of [0, 8, 20, 36]) {
    const f = fixture();
    const reference = await f.store.put('checkpoint:one', Buffer.from([0xff, 0, 0xfe]));
    f.objects.get(String(reference.locator.key))![offset] ^= 1;
    await assert.rejects(f.store.read(reference.scope, reference), failure('INTEGRITY_FAILED'));
  }
  const f = fixture();
  const reference = await f.store.put('checkpoint:one', Buffer.from([1]));
  for (const length of [reference.storedSize - 1, reference.storedSize + 1]) {
    f.backend.get = async () => new Uint8Array(length);
    await assert.rejects(f.store.read(reference.scope, reference), failure('INTEGRITY_FAILED'));
  }
});

test('transport failures and mutable upload buffers use private fixed classifications and keep objects', async () => {
  const f = fixture();
  const originalPut = f.backend.put;
  f.backend.put = async () => {
    throw new Error('PRIVATE_UPLOAD_RESPONSE');
  };
  await assert.rejects(f.store.put('checkpoint:one', Buffer.from([1])), failure('UPLOAD_FAILED'));
  f.backend.put = async (input) => {
    input.bytes[input.bytes.length - 1] ^= 1;
    return originalPut(input);
  };
  await assert.rejects(
    f.store.put('checkpoint:one', Buffer.from([1])),
    failure('INTEGRITY_FAILED'),
  );
  assert.equal(f.objects.size, 1);
  f.backend.put = originalPut;
  f.backend.get = async () => {
    throw new Error('PRIVATE_DOWNLOAD_RESPONSE');
  };
  await assert.rejects(f.store.put('checkpoint:one', Buffer.from([1])), failure('VERIFY_FAILED'));
  assert.equal(f.objects.size, 2);
  const g = fixture();
  const reference = await g.store.put('checkpoint:one', Buffer.from([1]));
  g.backend.get = async () => {
    throw new Error('PRIVATE_DOWNLOAD_RESPONSE');
  };
  await assert.rejects(g.store.read(reference.scope, reference), failure('DOWNLOAD_FAILED'));
});

test('cancellation before/during compression and transport never returns a reference, and signals/bounds propagate', async () => {
  const f = fixture();
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    f.store.put('checkpoint:one', Buffer.from([1]), { signal: cancelled.signal }),
    { name: 'AbortError' },
  );
  const compressing = new AbortController();
  const pending = f.store.put('checkpoint:one', Buffer.alloc(4096), { signal: compressing.signal });
  compressing.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
  const active = new AbortController();
  const originalPut = f.backend.put;
  f.backend.put = async (input) => {
    await originalPut(input);
    active.abort();
    throw new Error('PRIVATE_ABORT');
  };
  await assert.rejects(f.store.put('checkpoint:one', Buffer.from([1]), { signal: active.signal }), {
    name: 'AbortError',
  });
  assert.equal(f.objects.size, 1);
  f.backend.put = originalPut;
  const signal = new AbortController().signal;
  const reference = await f.store.put('checkpoint:one', Buffer.from([1]), { signal });
  await f.store.read(reference.scope, reference, { signal });
  assert.ok(f.calls.slice(-3).every((call) => call.signal === signal));
  assert.ok(f.calls.slice(-2).every((call) => call.maxBytes === reference.storedSize));
  const readCancelled = new AbortController();
  f.backend.get = async () => {
    readCancelled.abort();
    throw new Error('PRIVATE_ABORT');
  };
  await assert.rejects(f.store.read(reference.scope, reference, { signal: readCancelled.signal }), {
    name: 'AbortError',
  });
});

test('FIFO queue bounds bytes, cancels waiting work without upload, and releases slots after failure', async () => {
  const f = fixture(8, 1);
  const put = f.backend.put;
  let release!: () => void;
  let start!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    start = resolve;
  });
  f.backend.put = async (input) => {
    start();
    await gate;
    return put(input);
  };
  const first = f.store.put('checkpoint:one', new Uint8Array(8));
  await entered;
  const controller = new AbortController();
  const cancelled = f.store.put('checkpoint:one', new Uint8Array(8), { signal: controller.signal });
  const rejection = assert.rejects(cancelled, { name: 'AbortError' });
  controller.abort();
  await rejection;
  const second = f.store.put('checkpoint:one', new Uint8Array(8));
  const third = f.store.put('checkpoint:one', new Uint8Array(8));
  await assert.rejects(f.store.put('checkpoint:one', new Uint8Array(1)), failure('BUSY'));
  release();
  const references = await Promise.all([first, second, third]);
  assert.deepEqual(
    f.calls.filter((call) => call.kind === 'put').map((call) => call.key),
    references.map((ref) => ref.locator.key),
  );
  f.backend.put = async () => {
    throw new Error('PRIVATE_UPLOAD');
  };
  await assert.rejects(f.store.put('checkpoint:one', new Uint8Array(1)), failure('UPLOAD_FAILED'));
  f.backend.put = put;
  const ref = await f.store.put('checkpoint:one', new Uint8Array([0xff]));
  assert.deepEqual(Buffer.from(await f.store.read(ref.scope, ref)), Buffer.from([0xff]));
});

test('zero-byte pending jobs remain bounded by the queue count limit', async () => {
  const f = fixture(8, 1);
  const put = f.backend.put;
  let release!: () => void;
  let start!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    start = resolve;
  });
  f.backend.put = async (input) => {
    start();
    await gate;
    return put(input);
  };
  const first = f.store.put('checkpoint:one', new Uint8Array(1));
  await entered;
  const waiting = Array.from({ length: 64 }, () => f.store.put('checkpoint:one', new Uint8Array()));
  await assert.rejects(f.store.put('checkpoint:one', new Uint8Array()), failure('BUSY'));
  release();
  await Promise.all([first, ...waiting]);
  assert.equal(f.calls.filter((call) => call.kind === 'put').length, 65);
});
