import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const temporary = await mkdtemp(path.resolve('test/.storage-test-'));
const configFile = path.join(temporary, 'project.config.json');
const sample = JSON.parse(await readFile('project.config.example.json', 'utf8'));
sample.auth = {
  sessionSecret: 'storage-test-secret-'.repeat(3),
  sessionTtlSeconds: 3600,
  users: [{ id: 'storage-test', name: 'Storage test', passwordHash: 'scrypt$test' }],
};
sample.storage = {
  driver: 'local',
  directory: path.join(temporary, 'files'),
  publicUrl: 'http://localhost:3000/files/',
  bucket: 'test',
  region: 'us-east-1',
  endpoint: '',
  accessKeyId: '',
  secretAccessKey: '',
  forcePathStyle: true,
};
const previousConfig = process.env.PIXELPRINT_CONFIG;
process.env.PIXELPRINT_CONFIG = configFile;
await writeFile(configFile, JSON.stringify(sample));
const { projectConfig } = await import('../src/config/project');
const { createStorageFileClient, StorageError } = await import('../src/hooks/tools/storage');
const local = { ...projectConfig.storage };
const runtime = () => ({ d2c: { storage: { enabled: true }, limits: { uploadBytes: 1024 } } });
const input = {
  fileName: 'nested/example.txt',
  content: Buffer.from('original'),
  contentType: 'text/plain',
};

/** 所有故障断言检查固定分类，防止不存在、权限与内容冲突混淆。 */
function reason(expected: string) {
  return (error: unknown) => error instanceof StorageError && error.reason === expected;
}

after(async () => {
  Object.assign(projectConfig.storage, local);
  if (previousConfig === undefined) delete process.env.PIXELPRINT_CONFIG;
  else process.env.PIXELPRINT_CONFIG = previousConfig;
  await rm(temporary, { recursive: true, force: true });
});

test('local: stable keys reuse equal bytes, reject conflict, and suffix different bytes', async () => {
  const storage = createStorageFileClient(runtime, 'ignored-legacy-environment');
  const first = await storage.uploadFile(input);
  assert.equal(first.provider, 'local');
  assert.equal(first.url, 'http://localhost:3000/files/nested/example.txt');
  assert.equal('environment' in first, false);
  assert.deepEqual(await storage.downloadFile(first), input.content);
  assert.deepEqual(await storage.uploadFile(input), first);
  await assert.rejects(
    storage.uploadFile({ ...input, content: Buffer.from('different') }),
    reason('CONFLICT'),
  );
  const second = await storage.uploadFile({
    ...input,
    content: Buffer.from('different'),
    renameOnConflict: true,
  });
  assert.equal(second.fileName, 'nested/example_2.txt');
  assert.deepEqual(await storage.downloadFile(first), input.content);
  assert.equal(
    (
      await storage.uploadFile({
        ...input,
        content: Buffer.from('different'),
        renameOnConflict: true,
      })
    ).fileName,
    second.fileName,
  );
});

test('local: concurrent writers never overwrite an existing stable key', async () => {
  const storage = createStorageFileClient(runtime);
  const results = await Promise.allSettled(
    ['one', 'two'].map((value) =>
      storage.uploadFile({
        ...input,
        fileName: 'race.txt',
        content: Buffer.from(value),
      }),
    ),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(
    results.filter((result) => result.status === 'rejected' && reason('CONFLICT')(result.reason))
      .length,
    1,
  );
});

test('local: rejects arbitrary URLs, traversal, symlinks, corruption, and oversize content', async () => {
  const storage = createStorageFileClient(runtime);
  const object = await storage.uploadFile({ ...input, fileName: 'integrity.txt' });
  await assert.rejects(storage.downloadFile(object.url), reason('INVALID_INPUT'));
  await assert.rejects(
    storage.downloadFile({ ...object, url: 'http://example.com/file' }),
    reason('INVALID_INPUT'),
  );
  await assert.rejects(
    storage.downloadFile({ ...object, provider: 's3' }),
    reason('INVALID_INPUT'),
  );
  for (const fileName of ['../escape', '/absolute', 'a/%2e%2e/b', 'a\\b', 'a/./b', 'a//b'])
    await assert.rejects(storage.uploadFile({ ...input, fileName }), reason('INVALID_INPUT'));
  await symlink(path.dirname(local.directory), path.join(local.directory, 'escape'));
  await assert.rejects(
    storage.uploadFile({ ...input, fileName: 'escape/secret' }),
    reason('INVALID_INPUT'),
  );
  await symlink(path.join(local.directory, 'integrity.txt'), path.join(local.directory, 'alias'));
  await assert.rejects(
    storage.uploadFile({ ...input, fileName: 'alias' }),
    reason('INVALID_INPUT'),
  );
  await writeFile(path.join(local.directory, object.fileName), 'tampered');
  await assert.rejects(storage.downloadFile(object), reason('INTEGRITY'));
  await assert.rejects(
    storage.uploadFile({ ...input, content: Buffer.alloc(1025) }),
    (error: unknown) => error instanceof StorageError && error.statusCode === 413,
  );
});

test('local: cancellation and config failures retain their actual categories', async () => {
  const storage = createStorageFileClient(runtime);
  await assert.rejects(
    storage.uploadFile({ ...input, signal: AbortSignal.abort() }),
    reason('ABORTED'),
  );
  await assert.rejects(
    createStorageFileClient(() => ({})).uploadFile(input),
    reason('INVALID_CONFIG'),
  );
});

test('s3: conditional create, digest reuse, rename, bounded download and real error classes', async () => {
  Object.assign(projectConfig.storage, {
    driver: 's3',
    publicUrl: 'https://cdn.example.com/assets/',
  });
  const objects = new Map<string, Buffer>();
  let nextError: unknown;
  let simulateRace = false;
  const original = S3Client.prototype.send;
  S3Client.prototype.send = (async (command: GetObjectCommand | PutObjectCommand) => {
    if (nextError) {
      const error = nextError;
      nextError = undefined;
      throw error;
    }
    const key = command.input.Key!;
    if (command instanceof GetObjectCommand) {
      const bytes = objects.get(key);
      if (!bytes) throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } };
      return {
        ContentLength: bytes.length,
        Body: (async function* () {
          yield bytes;
        })(),
      };
    }
    assert.equal(command.input.IfNoneMatch, '*');
    if (simulateRace) {
      objects.set(key, Buffer.from('racer'));
      simulateRace = false;
    }
    if (objects.has(key)) throw { $metadata: { httpStatusCode: 412 } };
    objects.set(key, Buffer.from(command.input.Body as Uint8Array));
    return {};
  }) as typeof S3Client.prototype.send;
  try {
    const storage = createStorageFileClient(runtime);
    const first = await storage.uploadFile(input);
    assert.equal(first.url, 'https://cdn.example.com/assets/nested/example.txt');
    assert.equal(first.provider, 's3');
    assert.deepEqual(await storage.downloadFile(first), input.content);
    assert.deepEqual(await storage.uploadFile(input), first);
    await assert.rejects(
      storage.uploadFile({ ...input, content: Buffer.from('different') }),
      reason('CONFLICT'),
    );
    assert.equal(
      (
        await storage.uploadFile({
          ...input,
          content: Buffer.from('different'),
          renameOnConflict: true,
        })
      ).fileName,
      'nested/example_2.txt',
    );
    simulateRace = true;
    assert.equal(
      (await storage.uploadFile({ ...input, fileName: 'race.txt', renameOnConflict: true }))
        .fileName,
      'race_2.txt',
    );
    nextError = { $metadata: { httpStatusCode: 403 } };
    await assert.rejects(storage.uploadFile(input), reason('ACCESS_DENIED'));
    nextError = { $metadata: { httpStatusCode: 500 } };
    await assert.rejects(storage.uploadFile(input), reason('UNAVAILABLE'));
    nextError = { name: 'TimeoutError' };
    await assert.rejects(storage.uploadFile(input), reason('TIMEOUT'));
    objects.set(first.fileName, Buffer.alloc(1025));
    await assert.rejects(storage.downloadFile(first), reason('INTEGRITY'));
    objects.delete(first.fileName);
    await assert.rejects(storage.downloadFile(first), reason('NOT_FOUND'));
  } finally {
    S3Client.prototype.send = original;
    Object.assign(projectConfig.storage, local);
  }
});

test('multipart route: requires authentication, limits bytes, rejects legacy token route', async () => {
  const { default: Fastify } = await import('fastify');
  const { default: uploadRoutes } = await import('../src/functions/d2c/upload');
  const app = Fastify();
  let signedIn = false;
  app.decorate('runtimeConfig', { get: runtime });
  app.decorateRequest('getUser', async () => (signedIn ? { userId: 'test-user' } : null));
  await app.register(uploadRoutes, { prefix: '/api/d2c' });
  /** 直接构造标准 multipart，覆盖服务端真实解析契约。 */
  function multipart(bytes: string, mimeType = 'text/plain') {
    return Buffer.from(
      `--storage-test\r\nContent-Disposition: form-data; name="file"; filename="example.txt"\r\nContent-Type: ${mimeType}\r\n\r\n${bytes}\r\n--storage-test--\r\n`,
    );
  }
  const headers = { 'content-type': 'multipart/form-data; boundary=storage-test' };
  try {
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/d2c/upload',
          headers,
          payload: multipart('hello'),
        })
      ).statusCode,
      401,
    );
    signedIn = true;
    const response = await app.inject({
      method: 'POST',
      url: '/api/d2c/upload',
      headers,
      payload: multipart('hello'),
    });
    assert.equal(response.statusCode, 200);
    const object = response.json().data;
    assert.equal(object.provider, 'local');
    assert.match(object.url, /^http:\/\/localhost:3000\/files\/uploads\//);
    assert.equal((await createStorageFileClient(runtime).downloadFile(object)).toString(), 'hello');
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/d2c/upload',
          headers,
          payload: multipart('a'.repeat(1025)),
        })
      ).statusCode,
      413,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/d2c/upload',
          headers,
          payload: multipart('<script/>', 'text/html'),
        })
      ).statusCode,
      415,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/d2c/upload',
          headers: { ...headers, origin: 'https://untrusted.example' },
          payload: multipart('hello'),
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/d2c/upload/image/token' })).statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});
