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
import { createSessionService } from '../src/functions/d2c/session/service';
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

test('GitHub 与访客身份必须绑定本人模型凭据，不能消耗平台模型 Key', async () => {
  for (const userId of ['github-123456', 'guest-123e4567-e89b-42d3-a456-426614174000']) {
    const f = await fixture();
    f.tables.D2cWorkspace[0].createdUserId = userId;
    f.tables.D2cSession[0].createdUserId = userId;
    await assert.rejects(
      f.messages.enqueue(userId, f.id, {
        clientRequestId: 'external-missing',
        content: '开始生成',
      }),
      (error: any) => error.reason === 'MODEL_CREDENTIAL_UNAVAILABLE',
    );
    assert.equal(f.tables.D2cRun.length, 0);
    const saved = await f.service.save(userId, personal, {
      baseUrl: 'https://personal.example.test/v1',
      modelName: 'personal-model',
    });
    const queued = await f.messages.enqueue(userId, f.id, {
      clientRequestId: 'external-personal',
      content: '使用我自己的模型',
    });
    const run = f.tables.D2cRun.find((row) => row.runId === queued.runId)!;
    assert.equal(run.requestedUserId, userId);
    assert.equal(run.modelSnapshot.modelCredentialId, saved.credentialId);
    assert.equal(run.modelSnapshot.MODEL_BASE_URL, 'https://personal.example.test/v1');
    assert.doesNotMatch(JSON.stringify(run), /sk-personal|test-model-key/);
  }
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
async function executionFixture(t: TestContext, independent = false) {
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
  if (independent) {
    await f.service.save('employee-a', personal, {
      baseUrl: f.runtime.modelConfigs[0].MODEL_BASE_URL,
      modelName: 'personal-model',
    });
    // 公共默认地址与个人端点完全不同；空闲会话首条消息自动绑定当前个人修订。
    f.runtime.modelConfigs[0].MODEL_BASE_URL = 'http://unused.invalid/v1';
    f.runtime.modelConfigs[0].MODEL_NAME = 'unrelated-global-model';
  } else await bind(f);
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

test('个人地址、模型与Key整体加密，独立于全局默认模型并固定旧修订', async () => {
  const f = await fixture();
  const connection = {
    baseUrl: 'https://models.example.test/custom/v1/',
    modelName: 'qwen:personal',
  };
  const saved = await f.service.save('employee-a', personal, connection);
  assert.equal(saved.baseUrl, 'https://models.example.test/custom/v1');
  const snapshot = { MODEL_BASE_URL: saved.baseUrl!, MODEL_NAME: connection.modelName };
  assert.deepEqual(await f.service.getConnection('employee-a', saved.credentialId), snapshot);
  f.runtime.modelConfigs[0].MODEL_BASE_URL = 'https://changed.invalid/v1';
  assert.equal((await f.service.getStatus('employee-a')).configured, true);
  assert.equal(await f.service.getToken('employee-a', saved.credentialId, snapshot), personal);
  await assert.rejects(
    f.service.getToken('employee-a', saved.credentialId, {
      ...snapshot,
      MODEL_NAME: 'wrong-model',
    }),
  );
  await assert.rejects(f.service.getConnection('employee-b', saved.credentialId));
  assert.doesNotMatch(
    JSON.stringify(f.tables.D2cCredential),
    /models\.example\.test|qwen:personal|sk-personal/,
  );
  const session = await createSessionService(f.mysql).create('employee-a', 'workspace-a', {
    target: 'h5',
  });
  const stored = f.tables.D2cSession.find((row) => row.sessionId === session.sessionId)!;
  assert.equal(stored.modelCredentialId, saved.credentialId);
  const later = await f.service.save('employee-a', 'sk-later-only', {
    ...connection,
    modelName: 'later-model',
  });
  assert.notEqual(later.credentialId, saved.credentialId);
  const q = await f.messages.enqueue('employee-a', session.sessionId!, {
    clientRequestId: 'bound-model',
    content: '讨论布局',
  });
  const run = f.tables.D2cRun.find((row) => row.runId === q.runId)!;
  assert.equal(run.modelSnapshot.MODEL_NAME, connection.modelName);
  assert.equal(run.modelSnapshot.MODEL_BASE_URL, snapshot.MODEL_BASE_URL);
  assert.equal(run.modelSnapshot.modelCredentialId, saved.credentialId);
});

test('完整个人连接路由接受合法地址，拒绝查询密钥、用户信息、片段、协议与不完整字段', async () => {
  const f = await fixture();
  const app = Fastify();
  app.decorateRequest(
    'getUser',
    async () => ({ userId: 'employee-a' }) as Awaited<ReturnType<FastifyRequest['getUser']>>,
  );
  app.decorate('mysql', f.mysql);
  app.decorate('runtimeConfig', {
    get: <T>() => f.runtime as unknown as T,
  } as FastifyInstance['runtimeConfig']);
  app.register(credentialRoutes, { prefix: '/api/d2c' });
  try {
    const url = '/api/d2c/credentials/model',
      headers = { 'x-requested-with': 'PixelPrint' };
    for (const baseUrl of [
      'file:///etc/passwd',
      'ftp://example.test/v1',
      'https://name:password@example.test/v1',
      'https://example.test/v1?key=secret',
      'https://example.test/v1#secret',
    ]) {
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            headers,
            payload: { token: personal, baseUrl, modelName: 'model' },
          })
        ).statusCode,
        422,
      );
    }
    for (const extra of [{ baseUrl: 'https://models.example.test/v1' }, { modelName: 'model' }])
      assert.equal(
        (await app.inject({ method: 'POST', url, headers, payload: { token: personal, ...extra } }))
          .statusCode,
        422,
      );
    const saved = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: {
        token: personal,
        baseUrl: 'https://models.example.test/v1',
        modelName: 'my-model',
      },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().data.baseUrl, 'https://models.example.test/v1');
    assert.equal(saved.json().data.modelName, 'my-model');
    assert.doesNotMatch(saved.body, /sk-personal|ciphertext|authTag/);
  } finally {
    await app.close();
  }
});

test('不同于全局模型的个人连接实际发出请求，首条消息固定个人ID且不发送全局Key', async (t) => {
  const f = await executionFixture(t, true);
  assert.equal(f.tables.D2cRun[0].modelSnapshot.MODEL_NAME, 'personal-model');
  assert.ok(f.tables.D2cRun[0].modelSnapshot.modelCredentialId);
  await executeGenerationRun(f.input);
  assert.ok(f.headers.length > 0);
  assert.ok(f.headers.every((value) => value === `Bearer ${personal}`));
  assert.equal(f.tables.D2cRun[0].status, 'succeeded');
  assert.doesNotMatch(JSON.stringify(f.tables.D2cTimeline), /sk-personal|test-model-key/);
});
