import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { Sequelize, type Model, type ModelStatic } from 'sequelize';
import { sessionStore } from './helpers/sessionStore';
import { enableTextContent } from './helpers/content';
import { initD2cFile } from '../src/models/D2cFile';
import { initD2cVersionFile } from '../src/models/D2cVersionFile';
import { initD2cSavedWorkFile } from '../src/models/D2cSavedWorkFile';
import {
  contentModel,
  contentStorageSchema,
  copyTextStorage,
  prepareTextContent,
  resolveTextContent,
  contentEnabled,
} from '../src/functions/d2c/content/runtime';

const digest = (content: string) => ({
  size: Buffer.byteLength(content),
  sha256: createHash('sha256').update(content).digest('hex'),
});

test('无装配/旧schema保留inline，新列不进入默认SELECT或INSERT，显式scope才查询引用', async (t) => {
  const f = sessionStore();
  assert.deepEqual(await prepareTextContent(f.mysql, 'session:one', ''), { content: '' });
  assert.equal(contentEnabled(f.mysql), false);
  const mysql = new Sequelize('mysql://unused:unused@127.0.0.1/offline', { logging: false });
  t.after(() => mysql.close());
  const models: ModelStatic<Model>[] = [
    initD2cFile(mysql),
    initD2cVersionFile(mysql),
    initD2cSavedWorkFile(mysql),
  ];
  const statements: string[] = [];
  mysql.query = (async (sql: string) => {
    statements.push(typeof sql === 'string' ? sql : (sql as { query: string }).query);
    return [];
  }) as unknown as typeof mysql.query;
  for (const model of models) {
    await model.findAll();
    assert.doesNotMatch(statements.at(-1)!, /contentRef/);
    await model.scope('contentBody').findAll();
    assert.match(statements.at(-1)!, /contentRef/);
  }
  mysql.query = (async (sql: string) => {
    statements.push(typeof sql === 'string' ? sql : (sql as { query: string }).query);
    throw new Error('SQL_CAPTURED');
  }) as unknown as typeof mysql.query;
  for (const model of models) {
    await assert.rejects(model.create({ content: 'legacy', objectLocator: null }), /SQL_CAPTURED/);
    assert.doesNotMatch(statements.at(-1)!, /contentRef/);
  }
});

test('shadow保留inline，external外置，回退inline模式仍能读取旧引用且不再上传', async () => {
  const f = sessionStore();
  const memory = enableTextContent(f.mysql, 'shadow');
  const shadow = await prepareTextContent(f.mysql, 'session:one', 'body');
  assert.equal(shadow.content, 'body');
  assert.ok(shadow.contentRef);
  memory.configure({ mode: 'external' });
  const external = await prepareTextContent(f.mysql, 'session:one', 'body');
  assert.equal(external.content, null);
  assert.ok(external.contentRef);
  const row = { ...external, ...digest('body') };
  assert.equal(await resolveTextContent(f.mysql, row, 'session:one'), 'body');
  memory.configure({ mode: 'inline' });
  const before = memory.operations.length;
  assert.deepEqual(await prepareTextContent(f.mysql, 'session:one', 'new'), {
    content: 'new',
    contentRef: null,
  });
  assert.equal(memory.operations.length, before);
  assert.equal(await resolveTextContent(f.mysql, row), 'body');
});

test('inline优先兼容旧写入，冻结剔除过期引用，缺失/损坏的纯引用不能变成空文本', async () => {
  const f = sessionStore();
  const memory = enableTextContent(f.mysql);
  const saved = await prepareTextContent(f.mysql, 'session:one', 'old');
  const changed = { ...saved, content: 'new', ...digest('new') };
  assert.equal(await resolveTextContent(f.mysql, changed), 'new');
  assert.deepEqual(copyTextStorage(f.mysql, changed), { content: 'new', contentRef: null });
  const missing = { ...saved, ...digest('old') };
  memory.objects.clear();
  await assert.rejects(resolveTextContent(f.mysql, missing), { code: 'DOWNLOAD_FAILED' });
  await assert.rejects(resolveTextContent(f.mysql, { ...saved, ...digest('different') }), {
    code: 'INVALID_REFERENCE',
  });
  assert.throws(() => copyTextStorage(f.mysql, { ...saved, ...digest('different') }), {
    code: 'INVALID_REFERENCE',
  });
});

test('阈值和单对象上限保留原inline能力，跨范围拒绝，已取消不上传', async () => {
  const f = sessionStore();
  const memory = enableTextContent(f.mysql, 'external', 4);
  assert.deepEqual(await prepareTextContent(f.mysql, 'session:one', 'a'), {
    content: 'a',
    contentRef: null,
  });
  const huge = 'a'.repeat(2097153);
  assert.deepEqual(await prepareTextContent(f.mysql, 'session:one', huge), {
    content: huge,
    contentRef: null,
  });
  assert.equal(memory.operations.length, 0);
  const saved = await prepareTextContent(f.mysql, 'session:one', 'body');
  await assert.rejects(
    resolveTextContent(f.mysql, { ...saved, ...digest('body') }, 'session:other'),
    { code: 'INVALID_REFERENCE' },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareTextContent(f.mysql, 'session:one', 'body', controller.signal), {
    name: 'AbortError',
  });
});

test('schemaReady改变需重新装配，非法模式/无专用密钥不启用外置', () => {
  assert.equal(contentStorageSchema.safeParse({ mode: 'external' }).success, false);
  const f = sessionStore();
  const memory = enableTextContent(f.mysql, 'inline');
  assert.equal(contentEnabled(f.mysql), true);
  memory.configure({ schemaReady: false });
  assert.throws(() => contentEnabled(f.mysql), { code: 'INVALID_CONFIG' });
  assert.equal(contentModel(sessionStore().mysql, f.mysql.models.D2cFile), f.mysql.models.D2cFile);
});
