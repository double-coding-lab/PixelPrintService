import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Sequelize } from 'sequelize';
import { createGalleryService } from '../src/functions/d2c/version/gallery';

type Row = Record<string, any>;

/** 使用真实权限帮助、隔离元数据模型；不得读取正文、模型配置或对象存储。 */
function fixture() {
  const version: Row = {
    versionId: 'version',
    status: 'ready',
    archiveObject: {},
    sessionId: 'session',
    workspaceId: 'workspace',
  };
  let session: Row | null = { sessionId: 'session', workspaceId: 'workspace' };
  let workspace: Row | null = { workspaceId: 'workspace', createdUserId: 'owner', teamId: null };
  let member = true;
  let sourceFailure = false;
  const queries: { table: string; options: Row }[] = [];
  const sourceModel = (table: string, read: () => Row | null) => ({
    async findOne(options: Row) {
      queries.push({ table, options });
      assert.notEqual(options.paranoid, false);
      assert.equal(options.lock, undefined);
      if (sourceFailure) throw new Error('database unavailable');
      const row = read();
      if (!row || !Object.entries(options.where).every(([key, value]) => row[key] === value))
        return null;
      return row;
    },
  });
  const mysql = {
    models: {
      D2cVersion: {
        async findOne() {
          return version;
        },
      },
      D2cVersionFile: {
        async findAll() {
          return [];
        },
      },
      D2cSession: sourceModel('session', () => session),
      D2cWorkspace: sourceModel('workspace', () => workspace),
      D2cTeam: sourceModel('team', () => ({ teamId: 'team' })),
      D2cTeamMember: sourceModel('member', () =>
        member ? { teamId: 'team', userId: 'visitor' } : null,
      ),
    },
  } as unknown as Sequelize;
  const service = createGalleryService(mysql, () => {
    throw new Error('must not access storage');
  });
  return {
    service,
    version,
    queries,
    setSession: (value: Row | null) => {
      session = value;
    },
    setWorkspace: (value: Row | null) => {
      workspace = value;
    },
    revoke: () => {
      member = false;
    },
    fail: () => {
      sourceFailure = true;
    },
  };
}

test('version source navigation is available to workspace owner and current team member only', async () => {
  const f = fixture();
  const expected = { workspaceId: 'workspace', sessionId: 'session' };
  assert.deepEqual((await f.service.get('Owner', 'version')).sourceSession, expected);
  assert.deepEqual(f.queries[0].options.attributes, ['sessionId', 'workspaceId']);
  assert.deepEqual(f.queries[1].options.attributes, ['workspaceId', 'createdUserId', 'teamId']);
  assert.equal((await f.service.get('visitor', 'version')).sourceSession, null);
  f.setWorkspace({ workspaceId: 'workspace', createdUserId: 'owner', teamId: 'team' });
  assert.deepEqual((await f.service.get('visitor', 'version')).sourceSession, expected);
  f.revoke();
  assert.equal((await f.service.get('visitor', 'version')).sourceSession, null);
});

test('deleted, missing, mismatched or legacy source does not prevent frozen version access', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => f.setSession(null),
    (f: ReturnType<typeof fixture>) => f.setWorkspace(null),
    (f: ReturnType<typeof fixture>) => f.setSession({ sessionId: 'session', workspaceId: 'other' }),
    (f: ReturnType<typeof fixture>) => {
      f.version.sessionId = null;
    },
    (f: ReturnType<typeof fixture>) => {
      f.version.workspaceId = null;
    },
    (f: ReturnType<typeof fixture>) => {
      f.version.sessionId = '../invalid';
    },
  ]) {
    const f = fixture();
    change(f);
    const detail = await f.service.get('owner', 'version');
    assert.equal(detail.sourceSession, null);
    assert.deepEqual(detail.files, []);
    assert.equal(detail.versionId, 'version');
    assert.equal('sessionId' in detail, false);
    assert.equal('workspaceId' in detail, false);
  }
});

test('source database errors remain visible instead of being misreported as no permission', async () => {
  const f = fixture();
  f.fail();
  await assert.rejects(f.service.get('owner', 'version'), /database unavailable/);
});
