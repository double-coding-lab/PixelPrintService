import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Sequelize } from 'sequelize';
import credentialRoutes from '../src/functions/d2c/credential';
import { createModelCredentialService } from '../src/functions/d2c/credential/model';
import { decryptSecret } from '../src/hooks/tools/secrets';
import { executeGenerationRun } from '../src/functions/d2c/run/execute';
import { createRunLeases } from '../src/functions/d2c/run/leases';
import { createRunPersistence } from '../src/functions/d2c/run/persistence';
import { parseD2cRuntimeConfig } from '../src/config/d2c';
import { readTemplateResources } from '../src/functions/d2c/workspace/resources';
import { initD2cSession } from '../src/models/D2cSession';
import { initD2cCredential } from '../src/models/D2cCredential';
import { messageFixture } from './helpers/messages';

const keys = {
  activeKeyId: 'offline-model-key',
  keys: { 'offline-model-key': 'offline-model-encryption-material' },
};
const personal = 'sk-personal-only-employee-a';

/** 凭据写入替身独立于会话事务；读取仍使用原测试库的 where/attributes 投影。 */
async function fixture() {
  const f = await messageFixture();
  Object.assign(f.runtime.d2c, { secrets: keys });
  const model = f.mysql.models.D2cCredential as any;
  model.unscoped = () => model;
  model.max = async (_field: string, { where }: any) =>
    Math.max(
      0,
      ...f.tables.D2cCredential.filter(
        (row) => row.ownerUserId === where.ownerUserId && row.kind === where.kind,
      ).map((row) => row.revision),
    );
  model.create = async (values: any) => {
    const row = { ...values, updatedAt: new Date() };
    f.tables.D2cCredential.push(row);
    return row;
  };
  const service = createModelCredentialService(
    f.mysql,
    () => keys,
    () => f.runtime.modelConfigs,
  );
  return { ...f, service };
}

async function bind(f: Awaited<ReturnType<typeof fixture>>, token = personal) {
  const saved = await f.service.save('employee-a', token);
  f.tables.D2cSession[0].modelCredentialId = saved.credentialId;
  return saved;
}

test('个人修订加密存储、元数据安全、多用户隔离和 AAD 类型绑定', async () => {
  const f = await fixture();
  assert.deepEqual(await f.service.getStatus('employee-a'), {
    configured: false,
    modelName: 'internal-model',
  });
  const first = await f.service.save('employee-a', personal);
  const second = await f.service.save('employee-a', 'sk-revision-two');
  const other = await f.service.save('employee-b', 'sk-employee-b');
  assert.equal((await f.service.getStatus('employee-a')).credentialId, second.credentialId);
  assert.equal((await f.service.getStatus('employee-b')).credentialId, other.credentialId);
  assert.equal(await f.service.getToken('employee-a', first.credentialId), personal);
  await assert.rejects(f.service.getToken('employee-b', first.credentialId));
  assert.doesNotMatch(
    JSON.stringify(f.tables.D2cCredential),
    /sk-personal|sk-revision|sk-employee/,
  );
  const status = await f.service.getStatus('employee-a');
  assert.deepEqual(Object.keys(status).sort(), ['configured', 'credentialId', 'modelName']);
  assert.doesNotMatch(JSON.stringify(status), /ciphertext|authTag|iv|keyId|MODEL_BASE_URL|sk-/);
  const row = f.tables.D2cCredential[0];
  await assert.rejects(
    decryptSecret(
      row,
      { ownerUserId: 'employee-a', credentialId: first.credentialId, kind: 'figma' },
      keys,
    ),
  );
  const current = f.runtime.modelConfigs[0];
  current.MODEL_BASE_URL = 'http://changed.invalid/v1';
  assert.equal((await f.service.getStatus('employee-a')).configured, false);
  await assert.rejects(f.service.getToken('employee-a', first.credentialId));
});

test('入队冻结本人 ID 且不复制全局 Key；后续保存不会替换已绑定修订', async () => {
  const f = await fixture();
  const saved = await bind(f);
  await f.service.save('employee-a', 'sk-new-revision');
  const queued = await f.messages.enqueue('employee-a', f.id, {
    clientRequestId: 'personal',
    content: '只讨论，不要生成',
  });
  const run = f.tables.D2cRun[0];
  assert.equal(run.modelSnapshot.modelCredentialId, saved.credentialId);
  assert.equal(run.requestedUserId, 'employee-a');
  assert.doesNotMatch(
    JSON.stringify(run.modelSnapshot),
    /sk-|test-model-key|MODEL_API_KEY|ciphertext/,
  );
  const leases = createRunLeases(f.mysql, { leaseMs: 60000, now: async () => Date.now() });
  const lease = (await leases.claim(queued.runId, 'model-worker'))!;
  const persistence = createRunPersistence(f.mysql, leases, lease, {
    limits: f.runtime.d2c.limits,
    notify() {},
    redact: (value) => value,
  });
  const loaded = await persistence.load();
  assert.equal(loaded.ownerUserId, 'employee-a');
  assert.equal(loaded.model.modelCredentialId, saved.credentialId);
  delete run.modelSnapshot.modelCredentialId;
  await assert.rejects(persistence.load(), /绑定不一致/);
});

test('入队拒绝他人、撤销、类型不符及缺失修订，不允许平台回退', async () => {
  for (const mutation of ['other', 'revoked', 'missing', 'kind', 'ciphertext']) {
    const f = await fixture();
    await bind(f);
    const row = f.tables.D2cCredential[0];
    if (mutation === 'other') row.ownerUserId = 'employee-b';
    if (mutation === 'revoked') row.status = 'revoked';
    if (mutation === 'missing') f.tables.D2cCredential.splice(0);
    if (mutation === 'kind') row.kind = 'figma';
    if (mutation === 'ciphertext') row.ciphertext = 'invalid';
    await assert.rejects(
      f.messages.enqueue('employee-a', f.id, { clientRequestId: mutation, content: '讨论' }),
      /模型|Token/,
    );
    assert.equal(f.tables.D2cRun.length, 0);
  }
  const f = await fixture();
  await bind(f);
  await assert.rejects(
    f.messages.enqueue('employee-a', f.id, { clientRequestId: 'leaked', content: personal }),
    /密钥/,
  );
});

test('凭据路由只接受 Token；拒绝自定 URL、模型和他人 ID；鉴权、同源与 no-store', async () => {
  const f = await fixture();
  let userId = 'employee-a';
  const app = Fastify();
  app.decorateRequest(
    'getUser',
    async () => ({ userId }) as Awaited<ReturnType<FastifyRequest['getUser']>>,
  );
  app.decorate('mysql', f.mysql);
  app.decorate('runtimeConfig', {
    get: <T>() => f.runtime as unknown as T,
  } as FastifyInstance['runtimeConfig']);
  app.register(credentialRoutes, { prefix: '/api/d2c' });
  try {
    const url = '/api/d2c/credentials/model';
    const headers = { 'x-requested-with': 'PixelPrint' };
    assert.equal(
      (await app.inject({ method: 'POST', url, payload: { token: personal } })).statusCode,
      403,
    );
    for (const extra of [
      { endpoint: 'http://169.254.169.254/' },
      { MODEL_BASE_URL: 'http://127.0.0.1' },
      { model: 'other' },
      { ownerUserId: 'employee-b' },
      { credentialId: 'other' },
    ]) {
      assert.equal(
        (await app.inject({ method: 'POST', url, headers, payload: { token: personal, ...extra } }))
          .statusCode,
        422,
      );
    }
    const saved = await app.inject({ method: 'POST', url, headers, payload: { token: personal } });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.headers['cache-control'], 'no-store');
    assert.equal(saved.json().data.modelName, 'internal-model');
    assert.doesNotMatch(saved.body, /sk-|ciphertext|authTag|keyId|MODEL_BASE_URL/);
    userId = 'employee-b';
    assert.equal(
      (await app.inject(url + '/status?ownerUserId=employee-a')).json().data.configured,
      false,
    );
    userId = '';
    assert.equal((await app.inject(url + '/status')).statusCode, 401);
  } finally {
    await app.close();
  }
});

/** 本地 HTTP 模型记录实际 Authorization；返回流中故意回显密钥以验证稳定历史脱敏。 */
async function executionFixture(t: TestContext) {
  const f = await fixture();
  const headers: string[] = [];
  const server = createServer((request, response) => {
    headers.push(request.headers.authorization ?? '');
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      'data: ' +
        JSON.stringify({
          id: 'offline',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: `讨论完成 ${personal} ${f.runtime.modelConfigs[0].MODEL_API_KEY}`,
              },
              finish_reason: null,
            },
          ],
        }) +
        '\n\ndata: ' +
        JSON.stringify({
          id: 'offline',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  f.runtime.modelConfigs[0].MODEL_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  f.runtime.modelConfigs[0].contextBudgetTokens = 256000;
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'personal-model-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = await readTemplateResources(path.resolve('pixelprint'), root);
  f.runtime.d2c.execution.workRoot = root;
  f.tables.D2cWorkspaceRevision[0].bundleHash = bundle.hash;
  await bind(f);
  const queued = await f.messages.enqueue('employee-a', f.id, {
    clientRequestId: 'execute',
    content: '只讨论，不要生成代码',
  });
  const leases = createRunLeases(f.mysql, { leaseMs: 60000, now: async () => Date.now() });
  const lease = (await leases.claim(queued.runId, 'worker'))!;
  return {
    ...f,
    headers,
    input: {
      mysql: f.mysql,
      leases,
      lease,
      config: parseD2cRuntimeConfig(f.runtime),
      store: { load: async () => bundle },
      binary: {
        uploadFile: async () => assert.fail('unexpected upload'),
        downloadFile: async () => assert.fail('unexpected download'),
      },
      proxyUrl: '',
      signal: new AbortController().signal,
      notify() {},
    },
  };
}

test('真实主模型 HTTP 收到固定个人 Key，输出/历史/增量文本脱敏且不出现全局 Key', async (t) => {
  const f = await executionFixture(t);
  await f.service.save('employee-a', 'sk-new-not-bound');
  await executeGenerationRun(f.input);
  assert.ok(f.headers.length > 0);
  assert.ok(f.headers.every((value) => value === `Bearer ${personal}`));
  assert.equal(f.tables.D2cRun[0].status, 'succeeded');
  const stored = JSON.stringify({ timeline: f.tables.D2cTimeline, run: f.tables.D2cRun });
  assert.doesNotMatch(stored, /sk-personal|test-model-key-not-for-production|sk-new-not-bound/);
  assert.match(stored, /REDACTED/);
});

test('入队后凭据失效或归属改变时执行不请求平台模型', async (t) => {
  for (const mutation of ['revoked', 'owner', 'missing', 'corrupt', 'default']) {
    await t.test(mutation, async (t) => {
      const f = await executionFixture(t);
      const row = f.tables.D2cCredential[0];
      if (mutation === 'revoked') row.status = 'revoked';
      if (mutation === 'owner') row.ownerUserId = 'employee-b';
      if (mutation === 'missing') f.tables.D2cCredential.splice(0);
      if (mutation === 'corrupt') row.authTag = 'invalid';
      if (mutation === 'default') f.input.config.modelConfigs[0].MODEL_NAME = 'other-model';
      await assert.rejects(executeGenerationRun(f.input));
      assert.deepEqual(f.headers, []);
    });
  }
});

test('新建模型及公开 DDL 包含可空列和 model kind；前端密码仅内存', async () => {
  const db = new Sequelize('offline', 'offline', '', { dialect: 'mysql', logging: false });
  const session = initD2cSession(db);
  const credential = initD2cCredential(db);
  assert.equal(session.getAttributes().modelCredentialId.allowNull, true);
  assert.deepEqual((credential.getAttributes().kind.type as any).values, ['figma', 'model']);
  const sql = await readFile('docs/sql/personal-model-credentials-migration.sql', 'utf8');
  assert.match(sql, /ADD COLUMN `modelCredentialId` VARCHAR\(64\) NULL DEFAULT NULL/);
  assert.match(sql, /ENUM\('figma','model'\)/);
  const ui = await readFile('web/src/workspace/ModelCredentialSettings.tsx', 'utf8');
  assert.match(ui, /type="password"/);
  assert.doesNotMatch(ui, /localStorage|sessionStorage/);
});
