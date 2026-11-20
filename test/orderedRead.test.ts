import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { findOrderedPage, findOrderedRows } from '../src/functions/d2c/utils/orderedRead';
import { messageFixture } from './helpers/messages';
import type { D2cTimeline } from '../src/models/D2cTimeline';

test('大字段分页保留原筛选、总数、同序结果和事务锁，正文查询顺序不影响响应', async () => {
  const f = await messageFixture();
  const model = f.mysql.models.D2cTimeline as typeof D2cTimeline;
  for (const seq of [3, 1, 2])
    f.tables.D2cTimeline.push({
      entryId: `entry-${seq}`,
      sessionId: f.id,
      seq,
      displayPayload: { text: 'large source '.repeat(1000) },
    });
  f.tables.D2cTimeline.push({ sessionId: 'other-session', seq: 2, entryId: 'secret' });
  const original = model.findAll.bind(model);
  let queries = 0;
  model.findAll = (async (options: Parameters<typeof model.findAll>[0]) => {
    queries++;
    assert.equal((options!.where as { sessionId: string }).sessionId, f.id);
    assert.ok(options!.transaction);
    assert.equal(options!.lock, 'UPDATE');
    if (options!.order) assert.deepEqual(options!.attributes, ['seq']);
    const rows = await original(options);
    return options!.order ? rows : rows.reverse();
  }) as typeof model.findAll;
  const result = await f.mysql.transaction(async (transaction) =>
    findOrderedPage(model, 'seq', {
      where: { sessionId: f.id },
      order: [['seq', 'ASC']],
      limit: 2,
      offset: 1,
      transaction,
      lock: transaction.LOCK.UPDATE,
    }),
  );
  assert.deepEqual(
    result.rows.map((row) => row.seq),
    [2, 3],
  );
  assert.equal(result.count, 3);
  assert.equal(queries, 2);
  assert.equal(result.rows[0].displayPayload!.text, 'large source '.repeat(1000));
});

test('空分页不读取正文、不返回其他会话记录', async () => {
  const f = await messageFixture();
  const model = f.mysql.models.D2cTimeline;
  const original = model.findAll.bind(model);
  let queries = 0;
  model.findAll = (async (options: Parameters<typeof model.findAll>[0]) => {
    queries++;
    assert.ok(options?.order);
    return original(options);
  }) as typeof model.findAll;
  assert.deepEqual(
    await findOrderedRows(model, 'seq', {
      where: { sessionId: 'missing-session' },
      order: [['seq', 'DESC']],
    }),
    [],
  );
  assert.equal(queries, 1);
});

test('跨会话队列用全局标识回填，同seq的消息不会覆盖且游标继续推进', async (t) => {
  const f = await messageFixture();
  const visited: string[] = [];
  const { createMessageQueueService } = await import('../src/functions/d2c/session/queue');
  const service = createMessageQueueService(f.mysql, { readConfig: () => f.runtime });
  const model = f.mysql.models.D2cSession;
  t.mock.method(model, 'findOne', async (options: { where: { sessionId: string } }) => {
    visited.push(options.where.sessionId);
    return null; // 此测试仅核对候选发现，不执行消息投递或业务写入。
  });
  for (const key of ['a', 'b'])
    f.tables.D2cTimeline.push({
      entryId: `entry-${key}`,
      sessionId: `session-${key}`,
      seq: 7,
      kind: 'stage',
      displayPayload: { action: 'message_queue', status: 'queued', queueId: `queue-${key}` },
    });
  await service.promote(2);
  assert.deepEqual(visited, ['session-a', 'session-b']);
  f.tables.D2cTimeline.push({
    entryId: 'entry-c',
    sessionId: 'session-c',
    seq: 7,
    kind: 'stage',
    displayPayload: { action: 'message_queue', status: 'queued', queueId: 'queue-c' },
  });
  await service.promote(1);
  assert.deepEqual(visited, ['session-a', 'session-b', 'session-c']);
});
