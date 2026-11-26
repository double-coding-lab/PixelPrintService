import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { createBinaryContentStore } from '../src/functions/d2c/content/binaryStore';
import {
  createCheckpointContentStore,
  parseCheckpointContentReference,
  checkpointMaximumBytes,
} from '../src/functions/d2c/content/checkpointStore';
import { TextContentError, type TextContentKeys } from '../src/functions/d2c/content/store';

function fixture(physical = 1048576, maxBytes = 4 * 1048576) {
  let cap = physical;
  let failureAt = 0;
  let puts = 0;
  let onPut = () => {};
  let keys: TextContentKeys = {
    activeKeyId: 'old',
    keys: { old: randomBytes(32).toString('base64') },
  };
  const objects = new Map<string, Buffer>();
  const sizes: number[] = [];
  const backend = {
    maxObjectBytes: physical,
    async put(input: { key: string; bytes: Uint8Array; signal?: AbortSignal }) {
      assert.ok(input.bytes.length <= cap, '每个实际上传包遵守单文件上限');
      if (++puts === failureAt) throw new Error('PRIVATE_UPLOAD_FAILURE');
      assert.equal(objects.has(input.key), false);
      objects.set(input.key, Buffer.from(input.bytes));
      sizes.push(input.bytes.length);
      onPut();
      return { provider: 'memory', key: input.key, size: input.bytes.length };
    },
    async get(locator: Record<string, unknown>, input: { maxBytes: number; signal?: AbortSignal }) {
      if (input.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      const bytes = objects.get(String(locator.key));
      if (!bytes || bytes.length > input.maxBytes) throw new Error('PRIVATE_MISSING_OBJECT');
      return Buffer.from(bytes);
    },
  };
  const options = { maxBytes, maxObjectBytes: () => cap, readKeys: () => keys };
  const store = createCheckpointContentStore(backend, options);
  const legacy = createBinaryContentStore(backend, {
    maxBytes: Math.min(maxBytes, physical - 36),
    readKeys: () => keys,
  });
  return {
    store,
    legacy,
    backend,
    objects,
    sizes,
    options,
    setCap: (n: number) => {
      cap = n;
    },
    failPut: (n: number) => {
      failureAt = n;
    },
    onPut: (f: () => void) => {
      onPut = f;
    },
    rotate: () => {
      keys = {
        activeKeyId: 'next' + Object.keys(keys.keys).length,
        keys: {
          ...keys.keys,
          ['next' + Object.keys(keys.keys).length]: randomBytes(32).toString('base64'),
        },
      };
    },
  };
}
const fails = (code: string) => (e: unknown) => e instanceof TextContentError && e.code === code;

test('52MiB typed checkpoint uses bounded files and a small database reference, never a giant inline payload', async () => {
  const f = fixture(30000000, checkpointMaximumBytes);
  const original = randomBytes(52 * 1048576);
  const reference = await f.store.put('checkpoint:real-large', original);
  assert.equal(reference.format, 'pixelprint.checkpoint.v2');
  assert.equal(f.objects.size, 3, '两块正文和一份清单');
  assert.ok(Buffer.byteLength(JSON.stringify(reference)) < 3000);
  assert.ok(f.sizes.every((n) => n <= 30000000));
  assert.deepEqual(Buffer.from(await f.store.read(reference.scope, reference)), original);
  assert.equal(reference.sha256, createHash('sha256').update(original).digest('hex'));
});

test('zero/small payloads and historical v1 objects roundtrip; lowering write cap and rotating keys keeps existing reads valid', async () => {
  const f = fixture();
  for (const value of [Buffer.alloc(0), randomBytes(19000)]) {
    const old = await f.legacy.put('checkpoint:old', value);
    assert.deepEqual(Buffer.from(await f.store.read(old.scope, old)), value);
    const current = await f.store.put('checkpoint:new', value);
    assert.equal(current.format, 'pixelprint.blob.v1');
    f.rotate();
    f.setCap(65536);
    assert.deepEqual(Buffer.from(await f.store.read(current.scope, current)), value);
  }
  const bytes = randomBytes(250000);
  const multi = await f.store.put('checkpoint:multi', bytes);
  f.setCap(4096);
  assert.deepEqual(Buffer.from(await f.store.read(multi.scope, multi)), bytes);
});

test('multipart manifest binds parent scope, total size, hash, order and every piece identity', async () => {
  const f = fixture(262144);
  const bytes = randomBytes(600000);
  const ref = await f.store.put('checkpoint:bound', bytes);
  assert.equal(ref.format, 'pixelprint.checkpoint.v2');
  if (ref.format !== 'pixelprint.checkpoint.v2') return;
  const original = JSON.parse(
    Buffer.from(await f.legacy.read(ref.manifest.scope, ref.manifest)).toString(),
  );
  await assert.rejects(f.store.read('checkpoint:foreign', ref), fails('INVALID_REFERENCE'));
  for (const change of [
    'scope',
    'size',
    'sha256',
    'order',
    'duplicate',
    'missing',
    'part-size',
  ] as const) {
    const manifest = structuredClone(original);
    if (change === 'scope') manifest.scope = 'checkpoint:foreign';
    if (change === 'size') manifest.size++;
    if (change === 'sha256') manifest.sha256 = '0'.repeat(64);
    if (change === 'order') manifest.parts.reverse();
    if (change === 'duplicate') manifest.parts[1] = manifest.parts[0];
    if (change === 'missing') manifest.parts.pop();
    if (change === 'part-size') manifest.parts[0].size--;
    const bad = {
      ...ref,
      manifest: await f.legacy.put(ref.manifest.scope, Buffer.from(JSON.stringify(manifest))),
    };
    await assert.rejects(f.store.read(ref.scope, bad), (e) => e instanceof TextContentError);
  }
  const badHeader = { ...ref, size: ref.size + 1 };
  await assert.rejects(f.store.read(ref.scope, badHeader), fails('INTEGRITY_FAILED'));
  const manifest = structuredClone(original);
  const key = manifest.parts[0].locator.key;
  const saved = f.objects.get(key)!;
  saved[saved.length - 1] ^= 1;
  await assert.rejects(f.store.read(ref.scope, ref), fails('INTEGRITY_FAILED'));
  f.objects.delete(key);
  await assert.rejects(f.store.read(ref.scope, ref), fails('DOWNLOAD_FAILED'));
});

test('part/manifest failures and cancellation return no commit reference and preserve existing objects', async () => {
  for (const index of [1, 2, 4]) {
    const f = fixture(262144);
    f.failPut(index);
    await assert.rejects(
      f.store.put('checkpoint:failure', randomBytes(600000)),
      fails('UPLOAD_FAILED'),
    );
    assert.ok(f.objects.size < 4);
  }
  const f = fixture(262144);
  const controller = new AbortController();
  f.onPut(() => controller.abort());
  await assert.rejects(
    f.store.put('checkpoint:cancel', randomBytes(600000), { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(f.objects.size, 1);
  await assert.rejects(
    f.store.put('checkpoint:cancel', Buffer.alloc(1), { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(f.objects.size, 1);
});

test('logical limits, invalid chunk caps, unsafe references and mutable caller bytes never bypass validation', async () => {
  const f = fixture();
  f.setCap(36);
  await assert.rejects(f.store.put('checkpoint:limit', Buffer.alloc(10)), fails('INVALID_CONFIG'));
  f.setCap(1048576);
  await assert.rejects(
    f.store.put('checkpoint:limit', Buffer.alloc(f.options.maxBytes + 1)),
    fails('INVALID_TEXT'),
  );
  assert.equal(f.objects.size, 0);
  let called = false;
  const hostile = {
    get format() {
      called = true;
      throw new Error('PRIVATE_GETTER');
    },
  };
  assert.throws(() => parseCheckpointContentReference(hostile), fails('INVALID_REFERENCE'));
  assert.equal(called, false);
  const mutable = randomBytes(1100000);
  const expected = Buffer.from(mutable);
  const pending = f.store.put('checkpoint:owned', mutable);
  mutable.fill(0);
  const reference = await pending;
  assert.deepEqual(Buffer.from(await f.store.read(reference.scope, reference)), expected);
});
