import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Sequelize } from 'sequelize';
import { publicOverviewPayload } from '../src/functions/d2c/sharing/overview';

/** 执行真实生成 SQL，检验 JSON 路径及投影，而非仅验证 Sequelize 函数对象。 */
test('公开主对话 SQL 仅移除子 Agent 大正文，保留入口与主对话原文', async () => {
  const mysql = new Sequelize('test', 'test', 'test', { dialect: 'mysql', logging: false });
  const db = new DatabaseSync(':memory:');
  try {
    db.function('JSON_UNQUOTE', (value) => value);
    db.exec('CREATE TABLE d2c_timeline (seq INTEGER, kind TEXT, displayPayload TEXT)');
    const insert = db.prepare('INSERT INTO d2c_timeline VALUES (?, ?, ?)');
    const child = {
      stage: 'subagent',
      agentId: 'agent',
      role: 'ui',
      status: 'reasoning',
      message: { role: 'assistant', text: 'x'.repeat(60000) },
      reasoning: { streamId: 'stream', text: 'y'.repeat(60000), status: 'streaming' },
    };
    const parent = { role: 'assistant', text: 'parent response' };
    insert.run(1, 'stage', JSON.stringify(child));
    insert.run(2, 'message', JSON.stringify(parent));
    insert.run(3, 'stage', JSON.stringify({ stage: 'queued', status: 'queued' }));
    const generator = mysql.getQueryInterface().queryGenerator as unknown as {
      selectQuery(table: string, options: unknown): string;
    };
    const sql = generator.selectQuery('d2c_timeline', {
      attributes: ['seq', 'kind', [publicOverviewPayload(), 'displayPayload']],
      order: [['seq', 'ASC']],
      limit: 500,
    });
    assert.doesNotMatch(sql, /\$\$/);
    const rows = db.prepare(sql).all();
    const result = JSON.parse(String(rows[0].displayPayload));
    assert.deepEqual(result, {
      stage: 'subagent',
      agentId: 'agent',
      role: 'ui',
      status: 'reasoning',
    });
    assert.deepEqual(JSON.parse(String(rows[1].displayPayload)), parent);
    assert.deepEqual(JSON.parse(String(rows[2].displayPayload)), {
      stage: 'queued',
      status: 'queued',
    });
    assert.ok(Buffer.byteLength(String(rows[0].displayPayload)) < 200);
  } finally {
    db.close();
    await mysql.close();
  }
});
