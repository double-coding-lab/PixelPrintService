import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import workspaceRoutes from '../src/functions/d2c/workspace';
import type { WorkspaceService } from '../src/functions/d2c/workspace/service';
import { PUBLIC_TEAM_ID } from '../src/shared/publicTeam';

/** 使用真实HTTP解析，服务替身只记录已认证身份与归属，不读取或上传资源。 */
test('创建工作区默认公开团队，显式null仍为个人，其他团队选择原样传递', async () => {
  const app = Fastify();
  const calls: unknown[][] = [];
  app.decorateRequest(
    'getUser',
    async () =>
      ({ userId: 'employee-a' }) as unknown as Awaited<ReturnType<FastifyRequest['getUser']>>,
  );
  const workspaceService = {
    async create(...args: unknown[]) {
      calls.push(args);
      return { workspaceId: 'new-workspace' };
    },
  } as unknown as WorkspaceService;
  await app.register(workspaceRoutes, {
    prefix: '/api/d2c',
    workspaceService,
    templateRoot: '/unused',
  });
  await app.ready();
  try {
    for (const body of [
      { name: '公开项目' },
      { name: '个人项目', teamId: null },
      { name: '指定团队', teamId: 'regular-team' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/d2c/workspaces',
        headers: { 'x-requested-with': 'PixelPrint' },
        payload: body,
      });
      assert.equal(response.statusCode, 202, response.body);
    }
    assert.deepEqual(
      calls.map((call) => call[2]),
      [PUBLIC_TEAM_ID, null, 'regular-team'],
    );
    assert.ok(calls.every((call) => (call[0] as Record<string, string>).userId === 'employee-a'));
  } finally {
    await app.close();
  }
});
