import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Sequelize, type Model, type ModelStatic } from 'sequelize';
import { initD2cVersion } from '../src/models/D2cVersion';
import { initD2cVersionFile } from '../src/models/D2cVersionFile';
import { initD2cSavedWork } from '../src/models/D2cSavedWork';
import { initD2cSavedWorkFile } from '../src/models/D2cSavedWorkFile';
import { createGalleryService } from '../src/functions/d2c/version/gallery';
import { createSavedWorkService } from '../src/functions/d2c/savedWork/service';
import { workCoverUrl } from '../src/functions/d2c/utils/workCover';

type Row = Record<string, any>;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Realistic frozen metadata: the list must not need the corresponding binary bytes. */
function image(node: string, label = node): Row {
  const path = `design-reference/root-${node}.png`;
  return {
    path,
    pathHash: sha(path),
    kind: 'attachment',
    size: 123,
    sha256: sha(label),
    objectLocator: {
      provider: 'local',
      url: `https://images.example.test/${label}.png`,
      size: 123,
      sha256: sha(label),
      mimeType: 'image/png',
    },
  };
}

/** Frozen preview assets omit design-reference; keep MIME, size and hash consistent. */
function raster(path: string, size = 1000, label = path.split('/').pop()!): Row {
  const file = image('0_1', label);
  const mimeType = /\.png$/i.test(path)
    ? 'image/png'
    : /\.webp$/i.test(path)
      ? 'image/webp'
      : 'image/jpeg';
  return {
    ...file,
    path,
    pathHash: sha(path),
    kind: 'asset',
    size,
    objectLocator: { ...file.objectLocator, size, mimeType },
  };
}

/** Execute real Sequelize MySQL SELECTs in SQLite, including OR pairs and REGEXP filters. */
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.function('regexp', (pattern, value) =>
    Number(value != null && new RegExp(String(pattern)).test(String(value))),
  );
  const mysql = new Sequelize('mysql://test:test@localhost/test', { logging: false });
  const models = [
    initD2cVersion(mysql),
    initD2cVersionFile(mysql),
    initD2cSavedWork(mysql),
    initD2cSavedWorkFile(mysql),
  ] as ModelStatic<Model>[];
  for (const model of models) {
    const columns = Object.entries(model.getAttributes()).map(([name, attr]) => {
      const numeric = ['size', 'revision', 'workRevision', 'sourceFileRevision'].includes(name);
      return `\`${attr.field ?? name}\` ${numeric ? 'INTEGER' : 'TEXT'}`;
    });
    db.exec(`CREATE TABLE \`${model.tableName}\` (${columns.join(', ')})`);
  }
  const queries: string[] = [];
  mysql.query = (async (query: string, options: Row) => {
    assert.equal(typeof query, 'string');
    assert.match(query, /^SELECT /);
    queries.push(query);
    const rows = db
      .prepare(query)
      .all()
      .map((record) => {
        const row: Row = { ...record };
        for (const [key, attr] of Object.entries(options.model?.getAttributes() ?? {}) as [
          string,
          Row,
        ][]) {
          if (attr.type.key === 'JSON' && typeof row[key] === 'string')
            row[key] = JSON.parse(row[key]);
        }
        return row;
      });
    if (options.plain) return rows[0] ?? null;
    return options.raw ? rows : rows.map((row) => options.model.build(row, { isNewRecord: false }));
  }) as typeof mysql.query;
  /** Seed directly so the test never opens a network connection or uses text content storage. */
  function insert(table: string, row: Row) {
    const entries = Object.entries(row);
    db.prepare(
      `INSERT INTO \`${table}\` (${entries.map(([key]) => `\`${key}\``).join(',')}) VALUES (${entries.map(() => '?').join(',')})`,
    ).run(
      ...entries.map(([, value]) => (typeof value === 'object' ? JSON.stringify(value) : value)),
    );
  }
  const forbidden = () => {
    throw new Error('lists must not access binary storage, runtime limits or configuration');
  };
  const gallery = createGalleryService(mysql, forbidden);
  const saved = createSavedWorkService(mysql, { binary: forbidden, readLimits: forbidden });
  function version(id: string, owner = 'alice', status = 'ready', date = '2026-11-23') {
    insert('d2c_version', {
      versionId: id,
      name: id,
      createdUserId: owner,
      status,
      createdAt: date,
      target: 'h5',
    });
  }
  function work(id: string, revision = 1, owner = 'alice', date = '2026-11-23') {
    insert('d2c_saved_work', {
      workId: id,
      ownerEid: owner,
      revision,
      name: id,
      target: 'h5',
      datachange_lasttime: date,
    });
  }
  return { db, queries, insert, version, work, gallery, saved };
}

/** Assert the actual generated cover query projects metadata and contains no expensive ordering. */
function coverQueries(queries: string[], table: string) {
  const covers = queries.filter((query) => query.includes(`FROM \`${table}\``));
  for (const query of covers) {
    assert.doesNotMatch(query, /\b(content|contentRef|configSnapshot|sourceId|sessionId)\b/);
    assert.doesNotMatch(query, /ORDER BY|SELECT \*/);
    assert.match(query, /REGEXP/);
  }
  return covers;
}

test('gallery batches one metadata query for the authorized ready page and numeric first design', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.version('a');
  f.version('b');
  f.version('off-page', 'alice', 'ready', '2026-11-01');
  f.version('not-ready', 'alice', 'saving');
  f.version('foreign', 'bob');
  for (const [versionId, file] of [
    ['a', image('10_1')],
    ['a', image('2_10')],
    ['a', image('2_2')],
    ['a', raster('static/theme-page/hero.webp', 999999)],
    ['off-page', image('0_1', 'off-page')],
    ['not-ready', image('0_1', 'not-ready')],
    ['foreign', image('0_1', 'foreign')],
    ['b', { ...image('1_1'), path: 'static/theme-page/icon.png' }],
    ['b', raster('static/theme-page/cover.JPEG')],
  ] as [string, Row][])
    f.insert('d2c_version_file', { versionId, ...file });
  const result = await f.gallery.list('alice', 'mine', 1, 2);
  assert.deepEqual(
    result.rows.map((row) => row.versionId),
    ['b', 'a'],
  );
  assert.equal(result.total, 3);
  assert.ok(result.rows.every((row) => row.canDelete === true));
  assert.equal(result.rows[0].coverUrl, raster('static/theme-page/cover.JPEG').objectLocator.url);
  assert.equal(result.rows[1].coverUrl, image('2_2').objectLocator.url);
  assert.doesNotMatch(JSON.stringify(result), /objectLocator|sha256|pathHash|configSnapshot/);
  assert.doesNotMatch(f.queries.join('\n'), /\b(content|contentRef|configSnapshot)\b/);
  const [query] = coverQueries(f.queries, 'd2c_version_file');
  assert.equal(coverQueries(f.queries, 'd2c_version_file').length, 1);
  assert.match(query, /`versionId` IN \('b', 'a'\)/);
  assert.doesNotMatch(query, /off-page|not-ready|foreign/);
  const all = await f.gallery.list('bob', 'all');
  assert.equal(all.total, 4);
  assert.equal(all.rows.find((row) => row.versionId === 'foreign')!.canDelete, true);
  assert.equal(all.rows.find((row) => row.versionId === 'a')!.canDelete, false);
  assert.equal(
    all.rows.find((row) => row.versionId === 'foreign')!.coverUrl,
    image('0_1', 'foreign').objectLocator.url,
  );
});

test('saved asset fallback SQL enforces owner and exact page work/revision pairs without design roots', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.work('a', 2);
  f.work('b', 3);
  f.work('off-page', 1, 'alice', '2026-11-01');
  f.work('foreign-work', 1, 'bob');
  for (const [ownerEid, workId, workRevision, label] of [
    ['alice', 'a', 1, 'obsolete'],
    ['alice', 'a', 3, 'cross-pair-a'],
    ['alice', 'b', 2, 'cross-pair-b'],
    ['bob', 'a', 2, 'cross-owner'],
    ['alice', 'off-page', 1, 'off-page'],
    ['bob', 'foreign-work', 1, 'foreign'],
    ['alice', 'a', 2, 'correct'],
  ] as const)
    f.insert('d2c_saved_work_file', {
      ownerEid,
      workId,
      workRevision,
      ...raster('static/theme-page/hero.png', 10000, label),
    });
  for (const file of [
    raster('static/theme-page/icon.png', 100),
    raster('static/theme-page/z.webp', 1000),
    raster('static/theme-page/a.jpg', 1000),
    { ...raster('static/theme-page/broken.png', 999999), pathHash: 'bad' },
  ])
    f.insert('d2c_saved_work_file', { ownerEid: 'alice', workId: 'b', workRevision: 3, ...file });
  const result = await f.saved.list('alice', 1, 2);
  assert.equal(result.total, 3);
  assert.deepEqual(
    result.items.map((item) => [item.workId, item.coverUrl]),
    [
      ['b', raster('static/theme-page/a.jpg', 1000).objectLocator.url],
      ['a', raster('static/theme-page/hero.png', 10000, 'correct').objectLocator.url],
    ],
  );
  assert.doesNotMatch(JSON.stringify(result), /configSnapshot|objectLocator|ownerEid|sha256/);
  const covers = coverQueries(f.queries, 'd2c_saved_work_file');
  assert.equal(covers.length, 1);
  assert.match(covers[0], /`ownerEid` = 'alice'/);
  assert.match(covers[0], /`workId` = 'b' AND .*`workRevision` = 3/);
  assert.match(covers[0], /`workId` = 'a' AND .*`workRevision` = 2/);
  assert.match(covers[0], / OR /);
  assert.doesNotMatch(covers[0], /off-page|foreign-work/);
});

test('frozen raster fallback checks MIME, rejects private/unsafe paths, and skips invalid large candidates', () => {
  const files = [
    raster('static/small.png', 50),
    raster('static/z.webp', 500),
    raster('static/a.JPEG', 500),
    { ...raster('static/broken.jpg', 9999), objectLocator: null },
  ];
  assert.equal(workCoverUrl(files as any), raster('static/a.JPEG').objectLocator.url);
  assert.equal(workCoverUrl(files.reverse() as any), raster('static/a.JPEG').objectLocator.url);
  assert.equal(workCoverUrl([...files, image('9_1')] as any), image('9_1').objectLocator.url);
  assert.equal(
    workCoverUrl([...files, { ...image('0_0'), sha256: 'bad' }] as any),
    raster('static/a.JPEG').objectLocator.url,
  );
  for (const path of [
    'assets/cover.png',
    'assets/cover.jpg',
    'assets/cover.JPEG',
    'assets/cover.WeBp',
  ]) {
    const file = raster(path);
    assert.equal(workCoverUrl([file] as any), file.objectLocator.url);
    assert.equal(
      workCoverUrl([
        { ...file, objectLocator: { ...file.objectLocator, mimeType: 'text/html' } },
      ] as any),
      null,
    );
  }
  for (const path of [
    'assets/cover.svg',
    'assets/cover.html',
    'assets/cover.gif',
    'assets/cover.avif',
    'internal/cover.png',
    '__preview/cover.png',
    '.d2c-cache/cover.png',
    'node_modules/cover.png',
    'assets/../cover.png',
    '/assets/cover.png',
    'assets/%2e%2e/cover.png',
    'assets\\cover.png',
  ])
    assert.equal(workCoverUrl([raster(path)] as any), null, path);
  const file = raster('assets/cover.png');
  assert.equal(workCoverUrl([{ ...file, kind: 'internal' }] as any), null);
  assert.equal(
    workCoverUrl([
      { ...file, objectLocator: { ...file.objectLocator, mimeType: 'image/webp' } },
    ] as any),
    null,
  );
});

test('empty lists skip the frozen file query and invalid pagination fails before querying', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  assert.deepEqual((await f.gallery.list('alice', 'mine')).rows, []);
  assert.deepEqual((await f.saved.list('alice')).items, []);
  assert.equal(coverQueries(f.queries, 'd2c_version_file').length, 0);
  assert.equal(coverQueries(f.queries, 'd2c_saved_work_file').length, 0);
  const count = f.queries.length;
  await assert.rejects(f.gallery.list('alice', 'mine', 0));
  await assert.rejects(f.saved.list('alice', 0));
  assert.equal(f.queries.length, count);
});

test('design cover integrity, safe URLs and numeric ordering are deterministic', () => {
  const good = image('2_2');
  const many = [image('10_0'), image('2_10'), good, image('9007199254740993_0')];
  assert.equal(workCoverUrl(many as any), good.objectLocator.url);
  assert.equal(workCoverUrl(many.reverse() as any), good.objectLocator.url);
  for (const override of [
    { path: 'static/theme-page/hero.png' },
    { path: 'design-reference/root-1_2.png/../root-2_2.png' },
    { path: 'design-reference/root-2_2.svg' },
    { pathHash: sha('wrong-path') },
    { kind: 'source' },
    { size: 0 },
    { size: 1.2 },
    { sha256: 'bad' },
    { objectLocator: null },
    { objectLocator: [] },
    { objectLocator: { ...good.objectLocator, size: 124 } },
    { objectLocator: { ...good.objectLocator, sha256: sha('wrong-bytes') } },
    { objectLocator: { ...good.objectLocator, mimeType: 'text/html' } },
    { objectLocator: { ...good.objectLocator, url: 'javascript:alert(1)' } },
    {
      objectLocator: {
        ...good.objectLocator,
        url: 'https://user:secret@images.example.test/a.png',
      },
    },
  ])
    assert.equal(workCoverUrl([{ ...good, ...override }] as any), null, JSON.stringify(override));
  assert.equal(workCoverUrl([]), null);
  assert.equal(
    workCoverUrl([{ ...good, pathHash: 'bad' }, image('3_0')] as any),
    image('3_0').objectLocator.url,
  );
});
