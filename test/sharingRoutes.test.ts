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
  assert.deepEqual(f.calls[0], ['list', 'viewer', 1, 12]);
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
