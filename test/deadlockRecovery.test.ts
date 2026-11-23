import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import type { Transaction } from 'sequelize';
import { messageFixture } from './helpers/messages';
import { enableCheckpointStorage } from './helpers/checkpointStorage';
import { createRunLeases } from '../src/functions/d2c/run/leases';
import { createRunPersistence } from '../src/functions/d2c/run/persistence';
import { createRunCheckpointSaver } from '../src/functions/d2c/run/agent/checkpoint';
import { appendSessionEvent } from '../src/functions/d2c/session/service';
import { diagnoseRunFailure } from '../src/functions/d2c/run/errors';
import { readFailureDetails } from '../src/shared/failureDetails';
import { getEventFailure } from '../web/src/workspace/timeline';

/** 用原生错误形状验证 cause/parent/original 分类；原始 SQL 不得进入公开诊断。 */
function deadlock(code = 'ER_LOCK_DEADLOCK') {
  return Object.assign(new Error('PRIVATE SQL'), {
    original: { code, errno: 1213, sqlState: '40001', sql: 'PRIVATE SQL' },
  });
}

/** 使用正式租约和事务替身；在回调已经修改记录后注入故障，确认整体回滚。 */
async function fixture() {
  const f = await messageFixture();
  const clock = { time: 1700000000000 };
  const queued = await f.messages.enqueue('employee-a', f.id, {
    clientRequestId: randomUUID(),
    content: '数据库恢复测试',
  });
  const leases = createRunLeases(f.mysql, { leaseMs: 60000, now: async () => clock.time });
  const lease = (await leases.claim(queued.runId, 'worker'))!;
  return { ...f, clock, leases, lease };
}

/** 故障发生于未提交事务，afterCommit不应执行，后续尝试必须使用新事务。 */
function inject(
  f: Awaited<ReturnType<typeof fixture>>,
  t: TestContext,
  failure: (attempt: number, transaction: Transaction) => void,
) {
  const original = f.mysql.transaction.bind(f.mysql);
  let attempts = 0;
  t.mock.method(f.mysql, 'transaction', (action: any, callback?: any) =>
    original(async (transaction) => {
      attempts++;
      const value = await (callback ?? action)(transaction);
      failure(attempts, transaction);
      return value;
    }),
  );
  return () => attempts;
}

test('纯数据库写入死锁整体回滚后重试，修订和提交后通知只生效一次', async (t) => {
  const f = await fixture();
  const transactions = new Set<Transaction>();
  const attempts = inject(f, t, (attempt, tx) => {
    transactions.add(tx);
    if (attempt === 1) throw deadlock();
  });
  let notifications = 0;
  const before = f.tables.D2cTimeline.length;
  await f.leases.commit(
    f.lease,
    async (session, tx) => {
      await session.update({ fileRevision: session.fileRevision + 1 }, { transaction: tx });
      await appendSessionEvent(f.mysql, session, tx, {
        kind: 'preview_changed',
        displayPayload: { status: 'changed' },
      });
      tx.afterCommit(() => {
        notifications++;
      });
    },
    { retryDeadlocks: true },
  );
  assert.equal(attempts(), 2);
  assert.equal(transactions.size, 2);
  assert.equal(f.tables.D2cSession[0].fileRevision, 1);
  assert.equal(f.tables.D2cTimeline.length, before + 1);
  assert.equal(notifications, 1);
});

test('重试次数有界，默认回调、超时和提交后异常不会重放', async (t) => {
  for (const scenario of ['exhausted', 'default', 'timeout', 'committed']) {
    const f = await fixture();
    const attempts = inject(f, t, (_attempt, tx) => {
      if (scenario === 'committed')
        tx.afterCommit(() => {
          throw deadlock();
        });
      else throw deadlock(scenario === 'timeout' ? 'ER_LOCK_WAIT_TIMEOUT' : undefined);
    });
    await assert.rejects(
      f.leases.commit(f.lease, async () => 'saved', {
        retryDeadlocks: scenario !== 'default',
      }),
    );
    assert.equal(attempts(), scenario === 'exhausted' ? 3 : 1, scenario);
  }
});

test('死锁后重新核对租约到期与取消信号，不复活旧owner', async (t) => {
  for (const scenario of ['expired', 'aborted']) {
    const f = await fixture();
    const controller = new AbortController();
    let actions = 0;
    const attempts = inject(f, t, () => {
      if (scenario === 'expired') f.clock.time += 60000;
      else controller.abort(new Error('cancelled'));
      throw deadlock();
    });
    await assert.rejects(
      f.leases.commit(
        f.lease,
        async () => {
          actions++;
        },
        {
          retryDeadlocks: true,
          signal: controller.signal,
        },
      ),
      (error: any) =>
        scenario === 'expired' ? error.reason === 'LEASE_LOST' : /cancelled/.test(error.message),
    );
    assert.equal(actions, 1);
    assert.equal(attempts(), scenario === 'expired' ? 2 : 1);
  }
});

test('检查点已准备的外置正文只上传一次，数据库死锁不重新序列化或上传', async (t) => {
  const f = await fixture();
  const storage = enableCheckpointStorage(f.mysql);
  const saver = createRunCheckpointSaver(f.mysql, f.leases, f.lease);
  const attempts = inject(f, t, (attempt) => {
    if (attempt === 1) throw deadlock();
  });
  const checkpoint = { ...emptyCheckpoint(), id: randomUUID() };
  const config = await saver.put(
    saver.config(),
    checkpoint,
    { source: 'loop', step: 1, parents: {} },
    {},
  );
  assert.equal(attempts(), 2);
  assert.equal(f.tables.D2cAgentCheckpoint.length, 1);
  assert.equal(
    storage.operations.filter((item) => item === 'put').length,
    2,
    'checkpoint和metadata各准备一次',
  );
  assert.equal((await saver.getTuple(config))?.checkpoint.id, checkpoint.id);
});

test('文件保存自动恢复数据库死锁，本地修订基线只在成功提交后推进', async (t) => {
  const f = await fixture();
  const persistence = createRunPersistence(f.mysql, f.leases, f.lease, {
    limits: f.runtime.d2c.limits,
    notify: () => {},
    redact: (value) => value,
  });
  await persistence.load();
  const attempts = inject(f, t, (attempt) => {
    if (attempt === 2) throw deadlock();
  });
  await persistence.write('pages/test.tsx', 'export default 1;', 'source');
  await persistence.write('pages/test.tsx', 'export default 2;', 'source');
  assert.equal(f.tables.D2cSession[0].fileRevision, 2);
  assert.equal(f.tables.D2cFile.filter((row) => row.path === 'pages/test.tsx').length, 1);
  assert.ok(attempts() >= 3);
});

test('数据库错误码进入公开诊断和历史解析，任意SQL与异常正文仍被剔除', () => {
  const { failure } = diagnoseRunFailure(deadlock());
  assert.equal(failure.databaseCode, 'ER_LOCK_DEADLOCK');
  assert.equal(failure.databaseErrno, 1213);
  assert.equal(failure.databaseSqlState, '40001');
  assert.equal(readFailureDetails(failure)?.databaseCode, 'ER_LOCK_DEADLOCK');
  assert.doesNotMatch(JSON.stringify(failure), /PRIVATE|original|sql"/);
  assert.equal(
    readFailureDetails({ databaseCode: 'PRIVATE SQL', databaseSqlState: 'SQL SELECT' }),
    undefined,
  );
  const parsed = getEventFailure({
    kind: 'run_status',
    runId: randomUUID(),
    data: {
      status: 'failed',
      failure,
    },
  } as any);
  assert.equal(parsed?.databaseCode, 'ER_LOCK_DEADLOCK');
});
