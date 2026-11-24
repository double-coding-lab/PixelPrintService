import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import sharingRoutes from '../src/functions/d2c/sharing/routes';
import type { createSharingService } from '../src/functions/d2c/sharing/service';
import type { createSavedWorkService } from '../src/functions/d2c/savedWork/service';
import type { EditService } from '../src/functions/d2c/edit/service';
import { SessionError } from '../src/functions/d2c/session/access';

/** 测试只注入服务契约，不访问数据库、Redis 或对象存储。 */
async function fixture(eid = 'viewer') {
  const calls: unknown[][] = [];
  const app = Fastify();
  app.decorateRequest('getUser', async function () {
    return (eid ? { userId: eid, name: eid } : undefined) as unknown as Awaited<
      ReturnType<FastifyRequest['getUser']>
    >;
  });
  const sharing = {
    status: async (...args: unknown[]) => {
      calls.push(['status', ...args]);
      return { public: false, shareId: null, canManage: false };
    },
    set: async () => {
      throw new SessionError(403, 'SHARE_CREATOR_REQUIRED', '仅创建者可公开');
    },
    list: async (...args: unknown[]) => {
      calls.push(['list', ...args]);
      return { items: [], total: 0, page: 1, pageSize: 12 };
    },
    get: async () => {
      throw new SessionError(404, 'SHARE_NOT_FOUND', '公开会话不存在');
    },
    timeline: async (...args: unknown[]) => {
      calls.push(['timeline', ...args]);
      return { entries: [], hasMore: false, nextSeq: 0 };
    },
  } as unknown as ReturnType<typeof createSharingService>;
  const works = {
    remove: async (...args: unknown[]) => {
      calls.push(['remove-work', ...args]);
      return { workId: args[1], deleted: true };
    },

    save: async (...args: unknown[]) => {
      calls.push(['save', ...args]);
      return { workId: 'work-own', revision: 8 };
    },
    list: async (...args: unknown[]) => {
      calls.push(['works', ...args]);
      return { items: [], total: 0 };
    },
  } as unknown as ReturnType<typeof createSavedWorkService>;
  const editor = {
    advanceBaseline: async (...args: unknown[]) => {
      calls.push(['baseline', ...args]);
    },
    exportSnapshot: async (...args: unknown[]) => {
      calls.push(['snapshot', ...args]);
      return { baseFileRevision: 7, revision: 2 };
    },
  } as unknown as EditService;
  app.register(sharingRoutes, {
    prefix: '/api/d2c',
    sharing: async () => sharing,
    works: async () => works,
    plazaEditor: async () => editor,
    workEditor: async () => editor,
  });
  await app.ready();
  return { app, calls };
}
const headers = { 'x-requested-with': 'PixelPrint' };

test('删除个人作品要求登录、同源及明确修订，不接受归属或额外字段', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const request = {
    method: 'DELETE' as const,
    url: '/api/d2c/my-works/work-own',
    payload: { expectedRevision: 8 },
  };
  assert.equal((await f.app.inject(request)).statusCode, 403);
  assert.equal(
    (await f.app.inject({ ...request, headers: { ...headers, origin: 'https://foreign.test' } }))
      .statusCode,
    403,
  );
  for (const payload of [
    {},
    { expectedRevision: 0 },
    { expectedRevision: '8' },
    { expectedRevision: 8, ownerEid: 'someone' },
    { expectedRevision: 4294967295 },
  ]) {
    assert.equal((await f.app.inject({ ...request, headers, payload })).statusCode, 422);
  }
  assert.deepEqual(f.calls, []);
  const result = await f.app.inject({ ...request, headers });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json().data, { workId: 'work-own', deleted: true });
  assert.deepEqual(f.calls, [['remove-work', 'viewer', 'work-own', 8]]);
  const anonymous = await fixture('');
  t.after(() => anonymous.app.close());
  assert.equal((await anonymous.app.inject({ ...request, headers })).statusCode, 401);
  assert.deepEqual(anonymous.calls, []);
});

test('公开读取仍需登录；写入要求同源标记且保留服务权限状态', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  assert.equal((await f.app.inject('/api/d2c/plaza/sessions')).statusCode, 200);
  assert.deepEqual(f.calls[0], ['list', 'viewer', 1, 12, 'all']);
  const denied = await f.app.inject({
    method: 'PUT',
    url: '/api/d2c/sessions/source/sharing',
    payload: { public: true },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().data.reason, 'CROSS_SITE_REQUEST');
  const noncreator = await f.app.inject({
    method: 'PUT',
    url: '/api/d2c/sessions/source/sharing',
    headers,
    payload: { public: true },
  });
  assert.equal(noncreator.statusCode, 403);
  assert.equal(noncreator.json().data.reason, 'SHARE_CREATOR_REQUIRED');
  const missing = await f.app.inject('/api/d2c/plaza/sessions/missing');
  assert.equal(missing.statusCode, 404);
  const unauthenticated = await fixture('');
  t.after(() => unauthenticated.app.close());
  assert.equal((await unauthenticated.app.inject('/api/d2c/plaza/sessions')).statusCode, 401);
});

test('保存个人作品使用服务端副本及原修订，不接收客户端归属或文件', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const saved = await f.app.inject({
    method: 'POST',
    url: '/api/d2c/my-works/work-own/edit/draft/save',
    headers,
    payload: { baseRevision: 2, name: '我的修改' },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(f.calls[0], ['snapshot', 'viewer', 'work-own', 'draft', 2]);
  assert.deepEqual(f.calls[1], [
    'save',
    'viewer',
    {
      draft: { baseFileRevision: 7, revision: 2 },
      name: '我的修改',
      workId: 'work-own',
      expectedRevision: 7,
    },
  ]);
  const forged = await f.app.inject({
    method: 'POST',
    url: '/api/d2c/plaza/sessions/source/edit/draft/save',
    headers,
    payload: { baseRevision: 2, ownerEid: 'someone', files: [] },
  });
  assert.equal(forged.statusCode, 422);
  assert.deepEqual(f.calls[2], ['baseline', 'viewer', 'work-own', 'draft', 2, 8]);
  assert.equal(f.calls.length, 3);
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/d2c/plaza/sessions/source/edit/draft/apply',
        headers,
        payload: { baseRevision: 2 },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/d2c/my-works/work-own/edit/draft/apply',
        headers,
        payload: { baseRevision: 2 },
      })
    ).statusCode,
    404,
  );
});

test('分页与子 Agent 游标有界，响应不缓存', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  assert.equal((await f.app.inject('/api/d2c/plaza/sessions?pageSize=1000')).statusCode, 422);
  const page = await f.app.inject('/api/d2c/plaza/sessions/source/timeline?beforeSeq=0&limit=500');
  assert.equal(page.statusCode, 200);
  assert.equal(page.headers['cache-control'], 'private, no-store');
  assert.deepEqual(f.calls[0], ['timeline', 'viewer', 'source', 0, 500, 0]);
});

test('广场 scope 传给服务且非法值返回422；撤回只沿既有PUT并保留403', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  for (const scope of ['mine', 'all']) {
    const result = await f.app.inject(`/api/d2c/plaza/sessions?page=2&pageSize=3&scope=${scope}`);
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['cache-control'], 'private, no-store');
  }
  assert.deepEqual(f.calls, [
    ['list', 'viewer', 2, 3, 'mine'],
    ['list', 'viewer', 2, 3, 'all'],
  ]);
  for (const scope of ['', 'other', 'MINE', 'mine&scope=all'])
    assert.equal((await f.app.inject(`/api/d2c/plaza/sessions?scope=${scope}`)).statusCode, 422);
  assert.equal(f.calls.length, 2);
  const result = await f.app.inject({
    method: 'PUT',
    url: '/api/d2c/sessions/source/sharing',
    headers,
    payload: { public: false },
  });
  assert.equal(result.statusCode, 403);
  assert.equal(result.json().data.reason, 'SHARE_CREATOR_REQUIRED');
  assert.equal(
    (await f.app.inject({ method: 'DELETE', url: '/api/d2c/plaza/sessions/source' })).statusCode,
    404,
  );
});

/** Fork API 契约单独注入，保留既有路由用例及 fixture。 */
async function forkRouteFixture(userId = 'viewer') {
  const app = Fastify();
  const calls: unknown[][] = [];
  let failure: SessionError | undefined;
  app.decorateRequest('getUser', async function () {
    return (userId ? { userId, name: '登录用户' } : undefined) as unknown as Awaited<
      ReturnType<FastifyRequest['getUser']>
    >;
  });
  app.register(sharingRoutes, {
    prefix: '/api/d2c',
    sharing: async () =>
      ({
        async fork(...args: unknown[]) {
          calls.push(args);
          if (failure) throw failure;
          return { workspaceId: 'own-workspace', sessionId: 'new-session', activeRunId: null };
        },
      }) as unknown as ReturnType<typeof createSharingService>,
  });
  await app.ready();
  return {
    app,
    calls,
    fail: (error: SessionError) => {
      failure = error;
    },
  };
}

const forkRequest = {
  method: 'POST' as const,
  url: '/api/d2c/plaza/sessions/11111111-1111-4111-8111-111111111111/forks',
  payload: {
    workspaceId: 'own-workspace',
    credentialId: 'own-figma',
    clientRequestId: '22222222-2222-4222-8222-222222222222',
  },
};

test('Fork API requires login and same origin before invoking the service', async (t) => {
  const f = await forkRouteFixture();
  t.after(() => f.app.close());
  for (const request of [
    forkRequest,
    { ...forkRequest, headers: { ...headers, origin: 'https://foreign.test' } },
  ]) {
    const response = await f.app.inject(request);
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().data.reason, 'CROSS_SITE_REQUEST');
  }
  assert.deepEqual(f.calls, []);
  const anonymous = await forkRouteFixture('');
  t.after(() => anonymous.app.close());
  const denied = await anonymous.app.inject({ ...forkRequest, headers });
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.json().data.reason, 'LOGIN_REQUIRED');
  assert.deepEqual(anonymous.calls, []);
});

test('Fork API accepts only target credential/UUID/name and derives actor from login', async (t) => {
  const f = await forkRouteFixture();
  t.after(() => f.app.close());
  for (const payload of [
    {},
    { ...forkRequest.payload, clientRequestId: 'invalid' },
    { ...forkRequest.payload, workspaceId: '../someone' },
    { ...forkRequest.payload, credentialId: '' },
    { ...forkRequest.payload, name: '  ' },
    { ...forkRequest.payload, name: 'a'.repeat(201) },
    ...[
      'ownerEid',
      'ownerUserId',
      'userId',
      'creatorName',
      'figmaToken',
      'files',
      'sdkItem',
      'modelCredentialId',
    ].map((key) => ({ ...forkRequest.payload, [key]: 'forged' })),
  ]) {
    const response = await f.app.inject({ ...forkRequest, headers, payload });
    assert.equal(response.statusCode, 422, response.body);
  }
  assert.deepEqual(f.calls, []);
  const response = await f.app.inject({
    ...forkRequest,
    headers,
    payload: { ...forkRequest.payload, name: '  我的分支  ' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.deepEqual(response.json().data, {
    workspaceId: 'own-workspace',
    sessionId: 'new-session',
    activeRunId: null,
  });
  assert.deepEqual(f.calls, [
    [
      'viewer',
      '11111111-1111-4111-8111-111111111111',
      { ...forkRequest.payload, name: '我的分支' },
    ],
  ]);
  const withoutName = await f.app.inject({ ...forkRequest, headers });
  assert.equal(withoutName.statusCode, 200, withoutName.body);
  assert.deepEqual(f.calls[1], [
    'viewer',
    '11111111-1111-4111-8111-111111111111',
    forkRequest.payload,
  ]);
});

test('Fork API preserves permission, withdrawn-source and revision-conflict service errors', async (t) => {
  const f = await forkRouteFixture();
  t.after(() => f.app.close());
  for (const [status, reason] of [
    [403, 'PERSONAL_WORKSPACE_REQUIRED'],
    [422, 'CREDENTIAL_UNAVAILABLE'],
    [422, 'MODEL_CREDENTIAL_UNAVAILABLE'],
    [503, 'MODEL_CREDENTIAL_UNAVAILABLE'],
    [404, 'SHARE_NOT_FOUND'],
    [409, 'SOURCE_CHANGED'],
  ] as const) {
    f.fail(new SessionError(status, reason, '操作不可用'));
    const response = await f.app.inject({ ...forkRequest, headers });
    assert.equal(response.statusCode, status, response.body);
    assert.equal(response.json().data.reason, reason);
    assert.equal(response.headers['cache-control'], 'private, no-store');
  }
  assert.equal(f.calls.length, 6);
});
