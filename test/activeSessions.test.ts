import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { listActiveSessions } from '../src/functions/d2c/session/active';
import { sessionStore } from './helpers/sessionStore';

function fixture() {
  const store = sessionStore();
  const { tables } = store;
  tables.D2cWorkspace[0].name = '我的工作区';
  tables.D2cWorkspace[1].name = '他人的私有工作区';
  tables.D2cTeam.push({ teamId: 'team-a', name: '当前团队', createdUserId: 'employee-b' });
  tables.D2cTeamMember.push({ teamId: 'team-a', userId: 'employee-a', role: 'member' });
  tables.D2cWorkspace.push({
    workspaceId: 'workspace-team',
    createdUserId: 'employee-b',
    teamId: 'team-a',
    name: '团队工作区',
  });
  function add(sessionId: string, workspaceId: string, status: string, n: number) {
    const runId = 'run-' + sessionId;
    tables.D2cSession.push({
      sessionId,
      workspaceId,
      activeRunId: runId,
      name: '会话-' + sessionId,
      target: 'h5',
      contextSummary: 'PRIVATE_HISTORY',
    });
    tables.D2cRun.push({
      id: String(n),
      sessionId,
      runId,
      status,
      updatedAt: new Date(2026, 10, 23, 15, n),
      configSnapshot: { secret: 'PRIVATE_CONFIG' },
      pendingInteraction: { question: 'PRIVATE_QUESTION' },
      checkpoint: { source: 'PRIVATE_SOURCE' },
    });
  }
  return { ...store, add };
}

test('跨个人与当前团队汇总活动会话，排除其他私有工作区、旧轮次及终态', async () => {
  const f = fixture();
  f.add('own', 'workspace-a', 'running', 1);
  f.add('team', 'workspace-team', 'waiting_input', 2);
  f.add('other', 'workspace-b', 'running', 3);
  f.add('done', 'workspace-a', 'succeeded', 4);
  f.add('paused', 'workspace-a', 'paused', 5);
  f.add('queued', 'workspace-a', 'queued', 6);
  f.add('stop', 'workspace-a', 'stopping', 7);
  f.tables.D2cRun.push({
    id: '8',
    runId: 'old-run',
    sessionId: 'own',
    status: 'running',
    updatedAt: new Date(),
  });
  const result = await listActiveSessions(f.mysql, 'employee-a');
  assert.equal(result.total, 4);
  assert.deepEqual(
    result.items.map((r) => r.sessionId),
    ['stop', 'queued', 'team', 'own'],
  );
  assert.equal(result.items.find((r) => r.sessionId === 'team')?.workspaceName, '团队工作区');
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE_|contextSummary|pendingInteraction|checkpoint|configSnapshot/,
  );
});

test('退出团队和软删除立即退出可见范围，空列表无需按会话逐个查询', async () => {
  const f = fixture();
  f.add('team', 'workspace-team', 'running', 1);
  f.add('own', 'workspace-a', 'queued', 2);
  assert.equal((await listActiveSessions(f.mysql, 'employee-a')).total, 2);
  f.tables.D2cTeamMember.length = 0;
  assert.equal((await listActiveSessions(f.mysql, 'employee-a')).total, 1);
  f.tables.D2cSession.find((r) => r.sessionId === 'own')!.deletedAt = new Date();
  assert.equal((await listActiveSessions(f.mysql, 'employee-a')).total, 0);
  f.tables.D2cSession.find((r) => r.sessionId === 'own')!.deletedAt = null;
  f.tables.D2cWorkspace[0].deletedAt = new Date();
  assert.equal((await listActiveSessions(f.mysql, 'employee-a')).total, 0);
  assert.ok(
    f.queries.every((q) => q.operation === 'findAll'),
    '元信息批量读取，没有逐条读取正文或取会话详情',
  );
});

test('分页稳定，校验服务端分页范围，轮次须同时匹配sessionId和activeRunId', async () => {
  const f = fixture();
  for (let n = 1; n <= 25; n++) f.add('s' + n, 'workspace-a', 'running', n);
  const one = await listActiveSessions(f.mysql, 'employee-a', 1, 20),
    two = await listActiveSessions(f.mysql, 'employee-a', 2, 20);
  assert.equal(one.total, 25);
  assert.equal(one.items.length, 20);
  assert.equal(two.items.length, 5);
  assert.equal(new Set([...one.items, ...two.items].map((r) => r.sessionId)).size, 25);
  f.tables.D2cSession[0].activeRunId = f.tables.D2cRun[1].runId;
  assert.equal((await listActiveSessions(f.mysql, 'employee-a')).total, 24);
  for (const [page, size] of [
    [0, 20],
    [1, 51],
    [1.5, 20],
    [1, 0],
  ])
    await assert.rejects(listActiveSessions(f.mysql, 'employee-a', page, size), /分页参数无效/);
});

test('排序查询仅投影少量元数据，一致读事务内复用权限，不读取JSON/TEXT', async () => {
  const f = fixture();
  f.add('own', 'workspace-a', 'running', 1);
  for (const modelName of ['D2cWorkspace', 'D2cSession', 'D2cRun']) {
    const model = f.mysql.models[modelName] as any;
    const method = modelName === 'D2cRun' ? 'findAndCountAll' : 'findAll';
    const original = model[method].bind(model);
    model[method] = async (options: any) => {
      assert.ok(options.transaction);
      assert.equal(options.lock, undefined);
      assert.ok(Array.isArray(options.attributes));
      assert.ok(
        options.attributes.every(
          (a: string) =>
            ![
              'contextSummary',
              'pendingInteraction',
              'configSnapshot',
              'checkpoint',
              'usage',
              'error',
            ].includes(a),
        ),
      );
      return original(options);
    };
  }
  assert.equal((await listActiveSessions(f.mysql, 'employee-a')).items.length, 1);
});
