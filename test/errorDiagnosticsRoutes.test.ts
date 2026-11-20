import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sessionRoutes from '../src/functions/d2c/session';
import { messageFixture } from './helpers/messages';

test('错误诊断接口只读、禁止缓存，校验过滤参数且每次重新验证会话权限', async () => {
  const f = await messageFixture();
  await f.messages.enqueue('employee-a', f.id, { clientRequestId: randomUUID(), content: 'hello' });
  let eid = 'employee-a';
  const app = Fastify();
  app.decorateRequest(
    'getUser',
    async () => ({ userId: eid }) as Awaited<ReturnType<FastifyRequest['getUser']>>,
  );
  app.decorate('mysql', f.mysql);
  app.decorate('runtimeConfig', {
    get: <T>() => f.runtime as unknown as T,
  } as unknown as FastifyInstance['runtimeConfig']);
  app.register(sessionRoutes, {
    prefix: '/api/d2c',
    worker: false,
    messageService: f.messages,
    sessionService: f.sessions,
  });
  try {
    const url = `/api/d2c/sessions/${f.id}/errors`;
    const state = JSON.stringify(f.tables);
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.json().data.total, 0);
    assert.equal(JSON.stringify(f.tables), state);
    for (const query of [
      '?pageSize=101',
      '?before=-1',
      '?snapshotSeq=x',
      '?category=bad',
      '?scope=other',
      '?snapshotToken=bad',
      '?token=private',
    ])
      assert.equal((await app.inject({ method: 'GET', url: url + query })).statusCode, 422, query);
    eid = 'employee-b';
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url })).statusCode, 404);
  } finally {
    await app.close();
  }
});
