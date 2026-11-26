import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { messageFixture } from './helpers/messages';
import { createTeamService } from '../src/functions/d2c/team/service';
import { ownedWorkspace } from '../src/functions/d2c/session/access';
import { visibleWorkspaceWhere } from '../src/functions/d2c/team/access';
import { PUBLIC_TEAM_ID } from '../src/shared/publicTeam';

/** 公开团队使用真实权限服务；内存存储仅替代数据库与外部模型。 */
test('公开团队自动包含普通用户和访客，列表分页稳定且不创建成员记录', async () => {
  const f = await messageFixture();
  const teams = createTeamService(f.mysql);
  for (const user of ['employee-a', 'employee-b', 'guest-test']) {
    const first = await teams.list(user, 1, 1);
    assert.equal(first.total, 1);
    assert.equal(first.rows[0].teamId, PUBLIC_TEAM_ID);
    assert.equal(first.rows[0].isOwner, false);
    const detail = await teams.get(user, PUBLIC_TEAM_ID);
    assert.deepEqual(detail.members, []);
    assert.equal((await teams.list(user, 2, 1)).rows.length, 0);
    await assert.rejects(teams.addMember(user, PUBLIC_TEAM_ID, 'other'), {
      reason: 'PUBLIC_TEAM_MANAGED',
    });
    await assert.rejects(teams.removeMember(user, PUBLIC_TEAM_ID, user), {
      reason: 'PUBLIC_TEAM_MANAGED',
    });
  }
  assert.equal(f.tables.D2cTeamMember.length, 0);
});

test('公开团队可共同访问，个人工作区保持隔离，公开筛选独立于成员表', async () => {
  const f = await messageFixture();
  f.tables.D2cWorkspace[0].teamId = PUBLIC_TEAM_ID;
  for (const user of ['employee-b', 'guest-test']) {
    assert.equal((await ownedWorkspace(f.mysql, user, 'workspace-a')).teamId, PUBLIC_TEAM_ID);
    assert.deepEqual(await visibleWorkspaceWhere(f.mysql, user, { teamId: PUBLIC_TEAM_ID }), {
      teamId: PUBLIC_TEAM_ID,
    });
  }
  await assert.rejects(ownedWorkspace(f.mysql, 'guest-test', 'workspace-b'), {
    reason: 'WORKSPACE_NOT_FOUND',
  });
  assert.equal(f.tables.D2cWorkspace[1].teamId, null);
});

test('公开团队发起任务不借用会话创建者Figma凭据', async () => {
  const f = await messageFixture();
  f.tables.D2cWorkspace[0].teamId = PUBLIC_TEAM_ID;
  f.tables.D2cSession[0].credentialId = 'creator-figma';
  f.tables.D2cCredential.push({
    credentialId: 'creator-figma',
    ownerUserId: 'employee-a',
    kind: 'figma',
    status: 'active',
    revision: 1,
  });
  await assert.rejects(
    f.messages.enqueue('employee-b', f.id, {
      clientRequestId: 'no-personal-figma',
      content: '调整页面',
    }),
    { reason: 'CREDENTIAL_UNAVAILABLE' },
  );
  assert.equal(f.tables.D2cRun.length, 0);
});

test('公开团队固定占首项，普通团队分页不重复，其他用户看不到私有团队', async () => {
  const f = await messageFixture();
  const teams = createTeamService(f.mysql);
  const regular = await teams.create({ userId: 'employee-a' }, '私有团队');
  const first = await teams.list('employee-a', 1, 1);
  const second = await teams.list('employee-a', 2, 1);
  assert.equal(first.total, 2);
  assert.equal(first.rows[0].teamId, PUBLIC_TEAM_ID);
  assert.equal(second.rows[0].teamId, regular.teamId);
  assert.equal((await teams.list('employee-a', 3, 1)).rows.length, 0);
  assert.equal((await teams.list('guest-test')).total, 1);
});
