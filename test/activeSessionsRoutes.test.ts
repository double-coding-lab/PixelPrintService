import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sessionRoutes from '../src/functions/d2c/session';
import { messageFixture } from './helpers/messages';

/** 使用社区版账号身份与既有离线业务替身，不读取部署配置或启动执行消费者。 */
test('活动会话入口使用当前账号权限、只读分页和禁缓存，不返回私有快照', async () => {
  const f = await messageFixture();
  f.tables.D2cSession[0].activeRunId = 'run-shortcut';
  f.tables.D2cRun.push({
    id: '1',
    runId: 'run-shortcut',
    sessionId: f.id,
    status: 'running',
    updatedAt: new Date(),
    configSnapshot: { secret: 'PRIVATE_SHORTCUT_CONFIG' },
  });
  let userId = 'employee-a';
  const app = Fastify();
  app.decorateRequest(
    'getUser',
    async () => ({ userId }) as Awaited<ReturnType<FastifyRequest['getUser']>>,
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
    const before = JSON.stringify(f.tables);
    const response = await app.inject('/api/d2c/sessions/active');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.json().total, 1);
    assert.equal(response.json().rows[0].sessionId, f.id);
    assert.doesNotMatch(response.body, /PRIVATE_SHORTCUT_CONFIG|configSnapshot/);
    assert.equal(JSON.stringify(f.tables), before);
    for (const query of ['?pageSize=51', '?page=0', '?page=NaN'])
      assert.equal((await app.inject('/api/d2c/sessions/active' + query)).statusCode, 422);
    userId = 'employee-b';
    const other = await app.inject('/api/d2c/sessions/active?userId=employee-a');
    assert.equal(other.statusCode, 200);
    assert.equal(other.json().total, 0);
    userId = '';
    assert.equal((await app.inject('/api/d2c/sessions/active')).statusCode, 401);
  } finally {
    await app.close();
  }
});
