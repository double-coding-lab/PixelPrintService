import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { StorageFileClient, StorageFileObject } from '../src/hooks/tools/storage';
import { createPreviewCache } from '../src/functions/d2c/preview/cache';
import { createImageVariants, withImageVariants } from '../src/functions/d2c/images/variants';
import {
  createRedisImageVariantStore,
  variantId,
  type ImageVariantStore,
  type VariantClaim,
  type VariantJob,
  type VariantResult,
} from '../src/functions/d2c/images/variantStore';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const originalBytes = Buffer.from('small original image fixture');
const webpBytes = Buffer.from('small fake WebP output');
type UploadInput = Parameters<StorageFileClient['uploadFile']>[0];

/** Real-looking locators; binary content is deliberately tiny and never sent to a network. */
function locator(fileName: string, content: Buffer, mimeType = 'image/png'): StorageFileObject {
  return {
    provider: 'local',
    fileName,
    url: `https://images.example.test/${fileName}`,
    sha256: sha(content),
    size: content.length,
    mimeType,
  };
}

/** In-memory contract double: dedupe, lease ownership, completion and a three-failure limit. */
class MemoryStore implements ImageVariantStore {
  jobs = new Map<string, VariantJob>();
  ready = new Map<string, VariantResult>();
  locks = new Map<string, string>();
  originals = new Map<string, StorageFileObject>();
  remembered: Array<{ id: string; source: StorageFileObject }> = [];
  enqueues: Array<{ id: string; job: VariantJob }> = [];
  completed: VariantClaim[] = [];
  retried: VariantClaim[] = [];
  discarded: VariantClaim[] = [];

  async enqueue(id: string, job: VariantJob) {
    this.enqueues.push({ id, job: structuredClone(job) });
    const hit = this.ready.get(id);
    if (hit?.sourceSha === job.source.sha256) return;
    this.ready.delete(id);
    const existing = this.jobs.get(id);
    if (!existing) this.jobs.set(id, structuredClone(job));
    else if (job.required) existing.required = true;
  }

  async claim(token: string): Promise<VariantClaim | null> {
    for (const [id, job] of this.jobs) {
      if (this.locks.has(id)) continue;
      this.locks.set(id, token);
      return { id, token, job: structuredClone(job) };
    }
    return null;
  }

  async complete(claim: VariantClaim, result: VariantResult) {
    assert.equal(this.locks.get(claim.id), claim.token);
    this.completed.push(structuredClone(claim));
    this.ready.set(claim.id, structuredClone(result));
    this.jobs.delete(claim.id);
    this.locks.delete(claim.id);
  }

  async retry(claim: VariantClaim) {
    assert.equal(this.locks.get(claim.id), claim.token);
    this.retried.push(structuredClone(claim));
    this.locks.delete(claim.id);
    const job = { ...claim.job, attempts: claim.job.attempts + 1 };
    if (job.attempts >= 3) this.jobs.delete(claim.id);
    else this.jobs.set(claim.id, structuredClone(job));
  }

  async get(ids: string[]) {
    return ids.map((id) => this.ready.get(id) ?? null);
  }

  async discard(claim: VariantClaim) {
    assert.equal(this.locks.get(claim.id), claim.token);
    this.discarded.push(structuredClone(claim));
    this.jobs.delete(claim.id);
    this.locks.delete(claim.id);
  }

  async remember(id: string, source: StorageFileObject) {
    this.remembered.push({ id, source: structuredClone(source) });
    this.originals.set(id, structuredClone(source));
  }

  async sources(ids: string[]) {
    return ids.map((id) => this.originals.get(id) ?? null);
  }

  async invalidate(id: string) {
    this.ready.delete(id);
  }
}

/** Drain both upload-wrapper and store-enqueue setImmediate callbacks, without wall-clock sleeps. */
async function flush() {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A permanently pending store must never make the original upload hang the test. */
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Original upload was blocked')), 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Isolated disk cache and raw binary client; no Fastify, Redis, Pillow or external services. */
async function fixture(t: TestContext, enabled?: () => boolean) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'image-variants-test-'));
  const cache = createPreviewCache(root, { requireIndex: false, maxBytes: 65536 });
  const store = new MemoryStore();
  const source = locator('folder/original.png', originalBytes);
  // Returned URLs may differ from the requested name; callers must trust the actual receipt.
  const derivative = locator('uploaded/actual-thumbnail.webp', webpBytes, 'image/webp');
  const uploads: UploadInput[] = [];
  const downloads: Array<{ value: unknown; maxBytes?: number }> = [];
  const phases: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const behavior = {
    convertFailures: 0,
    uploadFailures: 0,
    badReceipt: false,
    downloadBytes: Buffer.from(originalBytes),
    conversions: 0,
  };
  const binary: StorageFileClient = {
    async uploadFile(input) {
      uploads.push(input);
      if (input.contentType !== 'image/webp') return source;
      if (behavior.uploadFailures-- > 0) throw new Error('derivative upload unavailable');
      return behavior.badReceipt ? { ...derivative, sha256: '0'.repeat(64) } : derivative;
    },
    async downloadFile(value, options) {
      downloads.push({ value, maxBytes: options?.maxBytes });
      return Buffer.from(behavior.downloadBytes);
    },
  };
  const convert = async (content: Buffer) => {
    behavior.conversions++;
    assert.deepEqual(content, originalBytes);
    if (behavior.convertFailures-- > 0) throw new Error('conversion unavailable');
    return Buffer.from(webpBytes);
  };
  const variants = createImageVariants({
    store,
    binary,
    cache,
    convert,
    autoStart: false,
    enabled,
    report: (phase) => phases.push(phase),
  });
  const wrapped = withImageVariants(binary, () => variants);
  const input: UploadInput = {
    content: Buffer.from(originalBytes),
    fileName: source.fileName,
    contentType: 'image/png',
  };
  t.after(async () => {
    try {
      await variants.stop();
      await flush();
      assert.deepEqual(unhandled, [], 'background failure leaked an unhandled rejection');
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await rm(root, { recursive: true, force: true });
    }
  });
  return {
    root,
    cache,
    store,
    source,
    derivative,
    binary,
    uploads,
    downloads,
    behavior,
    phases,
    convert,
    variants,
    wrapped,
    input,
  };
}

for (const mode of ['pending', 'rejects'] as const) {
  test(`original upload returns unchanged when store enqueue ${mode}`, async (t) => {
    const f = await fixture(t);
    let called = 0;
    f.store.enqueue = async () => {
      called++;
      if (mode === 'rejects') throw new Error('queue unavailable');
      await new Promise<void>(() => {}); // Intentionally never resolved, even during cleanup.
    };
    const result = await bounded(f.wrapped.uploadFile(f.input));
    assert.strictEqual(result, f.source);
    assert.strictEqual(f.uploads[0], f.input);
    await flush();
    assert.equal(called, 1);
    assert.deepEqual(f.input.content, originalBytes);
    assert.deepEqual(f.source, locator('folder/original.png', originalBytes));
    assert.equal(f.uploads.length, 1);
    assert.equal(f.behavior.conversions, 0);
    assert.deepEqual(f.phases, mode === 'rejects' ? ['enqueue'] : []);
  });
}

test('wrapper isolates synchronous enqueue/getter failures and delegates downloads', async (t) => {
  const f = await fixture(t);
  for (const getVariants of [
    () => {
      throw new Error('unavailable variants');
    },
    () => ({
      enqueue() {
        throw new Error('enqueue throws');
      },
    }),
  ]) {
    const wrapped = withImageVariants(f.binary, getVariants);
    assert.strictEqual(await bounded(wrapped.uploadFile(f.input)), f.source);
    await flush();
    assert.deepEqual(
      await wrapped.downloadFile(f.source, { maxBytes: f.source.size }),
      originalBytes,
    );
  }
  assert.equal(f.downloads.length, 2);
});

test('runOnce uploads the suffixed WebP once, indexes the receipt and caches successful bytes', async (t) => {
  const f = await fixture(t);
  assert.strictEqual(await bounded(f.wrapped.uploadFile(f.input)), f.source);
  await flush();
  assert.equal(f.store.jobs.size, 1);
  assert.equal(f.uploads.length, 1, 'autoStart:false must not process the queued job');
  assert.equal(f.downloads.length, 0);
  await f.variants.runOnce();
  assert.equal(f.uploads.length, 2);
  assert.equal(f.uploads[1].fileName, `${f.input.fileName}_.webp`);
  assert.equal(f.uploads[1].contentType, 'image/webp');
  assert.equal(f.uploads[1].renameOnConflict, true);
  assert.deepEqual(f.uploads[1].content, webpBytes);
  assert.equal(f.downloads[0].maxBytes, f.source.size);
  assert.equal(f.store.completed.length, 1);
  assert.deepEqual(await f.store.get([variantId(f.source.url)]), [
    {
      sourceSha: f.source.sha256,
      locator: f.derivative,
    },
  ]);
  assert.deepEqual(await f.variants.find(f.source), f.derivative);
  assert.deepEqual(
    await f.variants.preferredUrls([f.source.url, 'https://images.example.test/missing.png']),
    new Map([[f.source.url, f.derivative.url]]),
  );
  assert.deepEqual(await f.variants.read(f.derivative), webpBytes);
  assert.equal(f.downloads.length, 1, 'uploaded derivative should already be in the disk cache');
  await flush();
  await f.variants.runOnce();
  assert.equal(
    f.store.enqueues.length,
    1,
    'raw derivative upload must not recursively enqueue itself',
  );
  assert.equal(f.store.jobs.size, 0);
  assert.equal(f.uploads.length, 2);
  assert.deepEqual(f.input.content, originalBytes);
});

test('disabled ordinary upload still registers the original locator without converting or uploading a derivative', async (t) => {
  const f = await fixture(t, () => false);
  const result = await bounded(f.wrapped.uploadFile(f.input));
  assert.strictEqual(result, f.source);
  await flush();
  const id = variantId(f.source.url);
  assert.deepEqual(await f.store.sources([id, variantId('unknown')]), [f.source, null]);
  assert.deepEqual(f.store.remembered, [{ id, source: f.source }]);
  assert.equal(f.store.enqueues.length, 0);
  assert.equal(f.store.jobs.size, 0);
  await f.variants.runOnce();
  assert.equal(f.uploads.length, 1);
  assert.equal(f.downloads.length, 0);
  assert.equal(f.behavior.conversions, 0);
  assert.equal(f.store.ready.size, 0);
  assert.deepEqual(f.input.content, originalBytes);
});

for (const mode of ['pending', 'rejects'] as const) {
  test(`original metadata registration ${mode} never blocks or rejects an ordinary upload`, async (t) => {
    const f = await fixture(t, () => false);
    let called = 0;
    f.store.remember = async () => {
      called++;
      if (mode === 'rejects') throw new Error('source metadata unavailable');
      await new Promise<void>(() => {});
    };
    assert.strictEqual(await bounded(f.wrapped.uploadFile(f.input)), f.source);
    await flush();
    assert.equal(called, 1);
    assert.equal(f.uploads.length, 1);
    assert.equal(f.behavior.conversions, 0);
    assert.equal(f.store.jobs.size, 0);
    assert.deepEqual(f.input.content, originalBytes);
  });
}

for (const entry of ['manager enqueue', 'upload marker'] as const) {
  test(`required cover via ${entry} bypasses the disabled ordinary-image switch`, async (t) => {
    const f = await fixture(t, () => false);
    if (entry === 'upload marker') f.input.webpRequired = true;
    assert.strictEqual(await bounded(f.wrapped.uploadFile(f.input)), f.source);
    await flush();
    if (entry === 'manager enqueue') f.variants.enqueue(f.source, f.source.fileName, true);
    await flush();
    const job = f.store.jobs.get(variantId(f.source.url));
    assert.equal(job?.required, true);
    await f.variants.runOnce();
    assert.equal(f.uploads.length, 2);
    assert.equal(f.uploads[1].fileName, `${f.source.fileName}_.webp`);
    assert.deepEqual(f.uploads[1].content, webpBytes);
    assert.equal(f.store.discarded.length, 0);
    assert.deepEqual(await f.variants.find(f.source), f.derivative);
    assert.deepEqual(f.input.content, originalBytes);
  });
}

for (const required of [false, undefined]) {
  test(`turning the switch off discards an already queued optional job (required=${required})`, async (t) => {
    let enabled = true;
    const f = await fixture(t, () => enabled);
    assert.strictEqual(await bounded(f.wrapped.uploadFile(f.input)), f.source);
    await flush();
    const id = variantId(f.source.url);
    assert.equal(f.store.jobs.size, 1);
    const job = f.store.jobs.get(id)!;
    if (required === undefined) delete job.required;
    else job.required = false;
    enabled = false;
    await f.variants.runOnce();
    assert.equal(f.store.discarded.length, 1);
    assert.equal(f.store.discarded[0].id, id);
    assert.equal(f.store.jobs.size, 0);
    assert.equal(f.store.locks.size, 0);
    assert.equal(f.store.ready.size, 0);
    assert.equal(f.store.retried.length, 0);
    assert.equal(f.downloads.length, 0);
    assert.equal(f.behavior.conversions, 0);
    assert.equal(f.uploads.length, 1);
    assert.deepEqual(await f.store.sources([id]), [f.source]);
  });
}

test('preferredUrls forces a missing cover from remembered metadata across manager instances even when disabled', async (t) => {
  const f = await fixture(t, () => false);
  await f.wrapped.uploadFile(f.input);
  await flush();
  assert.equal(f.store.jobs.size, 0);
  const next = createImageVariants({
    store: f.store,
    binary: f.binary,
    cache: f.cache,
    convert: f.convert,
    enabled: () => false,
    autoStart: false,
  });
  t.after(() => next.stop());
  assert.deepEqual(
    await next.preferredUrls([f.source.url, 'https://images.example.test/unknown.png']),
    new Map(),
  );
  await flush();
  const id = variantId(f.source.url);
  assert.equal(f.store.jobs.size, 1);
  assert.equal(f.store.jobs.get(id)?.required, true);
  assert.deepEqual(f.store.jobs.get(id)?.source, f.source);
  await next.runOnce();
  assert.deepEqual(
    await next.preferredUrls([f.source.url]),
    new Map([[f.source.url, f.derivative.url]]),
  );
  assert.equal(f.uploads.length, 2);
  assert.equal(f.behavior.conversions, 1);
  assert.deepEqual(f.input.content, originalBytes);
});

for (const stage of ['convert', 'upload', 'receipt'] as const) {
  test(`${stage} failure is contained, publishes no derivative, and retries without changing original`, async (t) => {
    const f = await fixture(t);
    f.behavior.convertFailures = stage === 'convert' ? 1 : 0;
    f.behavior.uploadFailures = stage === 'upload' ? 1 : 0;
    f.behavior.badReceipt = stage === 'receipt';
    const original = await bounded(f.wrapped.uploadFile(f.input));
    await flush();
    await f.variants.runOnce();
    assert.strictEqual(original, f.source);
    assert.deepEqual(f.input.content, originalBytes);
    assert.deepEqual(original, locator('folder/original.png', originalBytes));
    assert.equal(f.store.ready.size, 0);
    assert.equal(f.store.completed.length, 0);
    assert.equal(await f.cache.has(sha(`${f.derivative.url}\n${f.derivative.sha256}`)), false);
    assert.deepEqual(await f.variants.preferredUrls([f.source.url]), new Map());
    assert.equal(f.store.retried.length, 1);
    assert.equal(f.store.jobs.get(variantId(f.source.url))?.attempts, 1);
    f.behavior.badReceipt = false;
    await f.variants.runOnce();
    assert.deepEqual(await f.variants.find(f.source), f.derivative);
    assert.equal(f.store.completed.length, 1);
    assert.equal(f.store.completed[0].job.attempts, 1);
    assert.equal(f.downloads.length, 1, 'retry should reuse the downloaded original');
    assert.equal(f.behavior.conversions, 2);
    assert.equal(f.store.jobs.size, 0);
    assert.deepEqual(f.input.content, originalBytes);
    assert.strictEqual(original, f.source);
    assert.deepEqual(f.phases, ['generate']);
  });
}

test('disk cache survives a new variants instance and deduplicates concurrent reads', async (t) => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.variants.read(f.source), f.variants.read(f.source)]);
  assert.deepEqual(first, originalBytes);
  assert.deepEqual(second, originalBytes);
  assert.equal(f.downloads.length, 1);
  const next = createImageVariants({
    store: f.store,
    binary: f.binary,
    cache: createPreviewCache(f.root, { requireIndex: false, maxBytes: 65536 }),
    convert: f.convert,
    autoStart: false,
  });
  t.after(() => next.stop());
  assert.deepEqual(await next.read(f.source), originalBytes);
  assert.equal(f.downloads.length, 1, 'a fresh instance must reuse disk bytes, not download again');
});

test('find rejects a stale derivative when source SHA changes, and invalid hits never become preferred', async (t) => {
  const f = await fixture(t);
  const id = variantId(f.source.url);
  f.store.ready.set(id, { sourceSha: f.source.sha256, locator: f.derivative });
  assert.deepEqual(await f.variants.find(f.source), f.derivative);
  const changed = { ...f.source, sha256: sha('different source') };
  assert.equal(await f.variants.find(changed), null);
  await flush();
  assert.equal(f.store.enqueues.at(-1)?.job.source.sha256, changed.sha256);
  // Recovery must be automatic: no explicit invalidate call from the application or test.
  assert.equal(f.store.ready.has(id), false);
  assert.equal(f.store.jobs.get(id)?.source.sha256, changed.sha256);
  assert.deepEqual(await f.variants.preferredUrls([changed.url]), new Map());
  for (const hit of [
    { sourceSha: 'invalid', locator: f.derivative },
    { sourceSha: f.source.sha256, locator: { ...f.derivative, mimeType: 'image/png' } },
    {
      sourceSha: f.source.sha256,
      locator: { ...f.derivative, url: 'https://user:pass@images.example.test/x' },
    },
  ]) {
    f.store.ready.set(id, hit);
    assert.deepEqual(await f.variants.preferredUrls([f.source.url]), new Map());
  }
});

test('read rejects incorrect source SHA and never caches unverified download bytes', async (t) => {
  const f = await fixture(t);
  f.behavior.downloadBytes = Buffer.alloc(originalBytes.length, 120);
  await assert.rejects(f.variants.read(f.source), /IMAGE_VARIANT_CONTENT/);
  assert.equal(await f.cache.has(sha(`${f.source.url}\n${f.source.sha256}`)), false);
  f.behavior.downloadBytes = Buffer.from(originalBytes);
  assert.deepEqual(await f.variants.read(f.source), originalBytes);
  assert.equal(f.downloads.length, 2);
});

test('stale ready index automatically regenerates a derivative without an explicit invalidate', async (t) => {
  const f = await fixture(t);
  const id = variantId(f.source.url);
  f.store.ready.set(id, { sourceSha: sha('previous image content'), locator: f.derivative });
  assert.equal(await f.variants.find(f.source), null);
  await flush();
  assert.equal(f.store.ready.has(id), false);
  assert.deepEqual(f.store.jobs.get(id)?.source, f.source);
  await f.variants.runOnce();
  assert.equal(f.store.completed.length, 1);
  assert.equal(f.store.ready.get(id)?.sourceSha, f.source.sha256);
  assert.deepEqual(await f.variants.find(f.source), f.derivative);
  assert.deepEqual(
    await f.variants.preferredUrls([f.source.url]),
    new Map([[f.source.url, f.derivative.url]]),
  );
});

test('preferredUrls rejects and regenerates a stale cover using the remembered source SHA', async (t) => {
  const f = await fixture(t, () => false);
  const original = await bounded(f.wrapped.uploadFile(f.input));
  await flush();
  const id = variantId(f.source.url);
  f.store.ready.set(id, { sourceSha: sha('previous cover bytes'), locator: f.derivative });
  assert.deepEqual(await f.variants.preferredUrls([f.source.url]), new Map());
  await flush();
  assert.equal(f.store.ready.has(id), false);
  assert.equal(f.store.jobs.get(id)?.source.sha256, f.source.sha256);
  assert.equal(f.store.jobs.get(id)?.required, true);
  await f.variants.runOnce();
  assert.deepEqual(
    await f.variants.preferredUrls([f.source.url]),
    new Map([[f.source.url, f.derivative.url]]),
  );
  assert.equal(f.store.ready.get(id)?.sourceSha, f.source.sha256);
  assert.strictEqual(original, f.source);
  assert.deepEqual(f.input.content, originalBytes);
});

test('lookup and retry-store outages are contained without publishing a false success', async (t) => {
  const f = await fixture(t);
  f.store.get = async () => {
    throw new Error('lookup unavailable');
  };
  assert.equal(await f.variants.find(f.source), null);
  assert.deepEqual(await f.variants.preferredUrls([f.source.url]), new Map());
  await flush();
  f.behavior.convertFailures = 1;
  f.store.retry = async () => {
    throw new Error('retry unavailable');
  };
  await f.variants.runOnce();
  assert.equal(f.store.completed.length, 0);
  assert.equal(f.store.ready.size, 0);
  assert.deepEqual(f.phases, ['lookup', 'lookup', 'generate', 'queue']);
});

test('variant IDs are stable strategy-scoped hashes, not reconstructed derivative URLs', () => {
  const url = 'https://images.example.test/original.png';
  assert.equal(variantId(url), sha(`webp-320-q80-v1\n${url}`));
  assert.match(variantId(url), /^[a-f0-9]{64}$/);
  assert.notEqual(variantId(`${url}.other`), variantId(url));
});

test('Redis store adapter preserves queue payloads, lease tokens, ordered misses and invalidation', async () => {
  const calls: Array<{ key: string; args: string[] }> = [];
  let response: unknown = 1;
  const store = createRedisImageVariantStore(async (key, args) => {
    calls.push({ key, args });
    return response;
  });
  const source = locator('original.png', originalBytes);
  const id = variantId(source.url);
  const job: VariantJob = { source, fileName: source.fileName, attempts: 0 };
  const result: VariantResult = {
    sourceSha: source.sha256,
    locator: locator('original.png_.webp', webpBytes, 'image/webp'),
  };
  await store.enqueue(id, job);
  assert.equal(calls.at(-1)?.args[0], 'EVAL');
  assert.deepEqual(JSON.parse(calls.at(-1)!.args.at(-3)!), job);
  assert.equal(calls.at(-1)!.args.at(-2), source.sha256);
  assert.equal(calls.at(-1)!.args.at(-1), '0');
  await store.enqueue(id, { ...job, required: true });
  assert.equal(calls.at(-1)!.args.at(-1), '1');
  assert.equal(JSON.parse(calls.at(-1)!.args.at(-3)!).required, true);
  await store.remember(id, source);
  assert.equal(calls.at(-1)!.args[0], 'SET');
  assert.equal(calls.at(-1)!.args[1], `pixelprint:{image-webp-v1}:source:${id}`);
  assert.deepEqual(JSON.parse(calls.at(-1)!.args[2]), source);
  response = [JSON.stringify(source), null, '{invalid json'];
  assert.deepEqual(await store.sources([id, variantId('missing'), variantId('corrupt')]), [
    source,
    null,
    null,
  ]);
  const sourceCalls = calls.length;
  assert.deepEqual(await store.sources([]), []);
  assert.equal(calls.length, sourceCalls);
  response = [id, JSON.stringify(job)];
  const claim = await store.claim('test-lease-token');
  assert.deepEqual(claim, { id, token: 'test-lease-token', job });
  assert.ok(claim);
  await store.complete(claim, result);
  assert.equal(calls.at(-1)?.args.at(-2), claim.token);
  assert.deepEqual(JSON.parse(calls.at(-1)!.args.at(-1)!), result);
  await store.retry(claim);
  const retry = calls.at(-1)!.args;
  assert.equal(retry.at(-3), claim.token);
  assert.deepEqual(JSON.parse(retry.at(-2)!), { ...job, attempts: 1 });
  assert.equal(retry.at(-1), '1');
  assert.equal(job.attempts, 0, 'retry serialization must not mutate the original claim');
  await store.discard(claim);
  assert.equal(calls.at(-1)!.args[0], 'EVAL');
  assert.deepEqual(calls.at(-1)!.args.slice(-2), [id, claim.token]);
  response = [JSON.stringify(result), null, '{invalid json'];
  assert.deepEqual(await store.get([id, variantId('missing'), variantId('corrupt')]), [
    result,
    null,
    null,
  ]);
  const count = calls.length;
  assert.deepEqual(await store.get([]), []);
  assert.equal(calls.length, count);
  await store.invalidate(id);
  assert.deepEqual(calls.at(-1)?.args, ['DEL', `pixelprint:{image-webp-v1}:ready:${id}`]);
  for (const { key } of calls) assert.equal(key, 'pixelprint:{image-webp-v1}:queue');
  await assert.rejects(store.enqueue('../bad-key', job), /IMAGE_VARIANT_KEY/);
  response = ['../bad-key', JSON.stringify(job)];
  await assert.rejects(store.claim('token'), /IMAGE_VARIANT_KEY/);
  response = null;
  assert.equal(await store.claim('token'), null);
});

test('现有派生批量只读绑定各原图摘要，不排队、不转换、不上传，查询故障保持原图', async (t) => {
  const f = await fixture(t, () => false);
  f.store.ready.set(variantId(f.source.url), { sourceSha: f.source.sha256, locator: f.derivative });
  const sources = Array.from({ length: 201 }, (_, i) => ({
    url: f.source.url,
    sha256: i === 1 ? '0'.repeat(64) : f.source.sha256,
  }));
  const sizes: number[] = [];
  const get = f.store.get.bind(f.store);
  f.store.get = async (ids) => {
    sizes.push(ids.length);
    return get(ids);
  };
  const hits = await f.variants.existing(sources);
  assert.deepEqual(sizes, [100, 100, 1]);
  assert.equal(hits[0]?.url, f.derivative.url);
  assert.equal(hits[1], null);
  assert.equal(hits[200]?.sha256, f.derivative.sha256);
  await flush();
  assert.equal(f.store.enqueues.length, 0);
  assert.equal(f.store.remembered.length, 0);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.downloads.length, 0);
  f.store.ready.set(variantId(f.source.url), {
    sourceSha: f.source.sha256,
    locator: { ...f.derivative, url: 'javascript:alert(1)' },
  });
  assert.deepEqual(await f.variants.existing([sources[0]]), [null]);
  f.store.get = async () => {
    throw new Error('offline');
  };
  assert.deepEqual(await f.variants.existing([sources[0]]), [null]);
  assert.equal(f.store.enqueues.length, 0);
});

test('派生只读索引超时不阻塞原文件列表，也不发起生成', async (t) => {
  const f = await fixture(t);
  f.store.get = async () => new Promise(() => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lookup = f.variants.existing([{ url: f.source.url, sha256: f.source.sha256 }]);
  t.mock.timers.tick(1000);
  assert.deepEqual(await lookup, [null]);
  t.mock.timers.reset();
  assert.equal(f.store.enqueues.length, 0);
  assert.equal(f.uploads.length, 0);
});

test('社区版只读派生目录兼容本地HTTP与S3回执，不触发补生成', async (t) => {
  const f = await fixture(t);
  for (const provider of ['local', 's3'] as const) {
    const image = {
      ...f.derivative,
      provider,
      url:
        provider === 'local'
          ? 'http://127.0.0.1:8080/storage/ready.webp'
          : 'https://cdn.example.test/ready.webp',
    };
    f.store.ready.set(variantId(f.source.url), { sourceSha: f.source.sha256, locator: image });
    assert.equal((await f.variants.existing([f.source]))[0]?.url, image.url);
  }
  assert.equal(f.store.enqueues.length, 0);
  assert.equal(f.uploads.length, 0);
});
