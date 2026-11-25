import './helpers/projectFixture';
import { publishedRuntimeCoverUrls } from '../src/functions/d2c/sharing/runtimeCover';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { Op, type Sequelize } from 'sequelize';
import { createSharingService } from '../src/functions/d2c/sharing/service';
import { SessionError } from '../src/functions/d2c/session/access';

type Row = Record<string, any>;
const shareId = '12345678-1234-4234-8234-123456789abc';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** 执行服务生成的相关子查询；仅适配 MySQL 标量函数，不模拟截图筛选条件。 */
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.function('JSON_UNQUOTE', (value) => value);
  db.function('JSON_LENGTH', (value) => (value === null ? null : JSON.parse(String(value)).length));
  db.function('CHAR_LENGTH', (value) => (value === null ? null : Array.from(String(value)).length));
  db.function('CONCAT', { varargs: true }, (...args) =>
    args.some((v) => v === null) ? null : args.join(''),
  );
  db.function('regexp', (pattern, value) =>
    Number(new RegExp(String(pattern)).test(String(value))),
  );
  db.exec(`
    CREATE TABLE d2c_session (sessionId TEXT);
    CREATE TABLE d2c_timeline (sessionId TEXT, messageId TEXT, runId TEXT, seq INTEGER, kind TEXT, displayPayload TEXT);
    CREATE TABLE d2c_message_attachment (sessionId TEXT, messageId TEXT, attachmentId TEXT,
      expiresAt TEXT, objectLocator TEXT, fileName TEXT, mimeType TEXT, size INTEGER, width INTEGER, height INTEGER);
  `);
  const sessions: Row[] = [
    { sessionId: 'source', workspaceId: 'workspace', name: 'Demo', createdUserId: 'owner' },
  ];
  const workspaces: Row[] = [{ workspaceId: 'workspace' }];
  const shares: Row[] = [{ sessionId: 'source', shareId, enabled: true }];
  const queries: Row[] = [];
  let afterCover: (() => void) | undefined;
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === 'object' ? value[Op.in]?.includes(row[key]) : row[key] === value,
    );
  const read = (rows: Row[], options: Row) =>
    rows.filter((r) => !r.deletedAt && matches(r, options.where));
  const liveShares = () =>
    shares.filter(
      (r) =>
        r.enabled &&
        sessions.some(
          (s) =>
            s.sessionId === r.sessionId &&
            !s.deletedAt &&
            workspaces.some((w) => w.workspaceId === s.workspaceId && !w.deletedAt),
        ),
    );
  const models = {
    D2cSessionShare: {
      findOne: async (o: Row) => read(shares, o)[0],
      findAll: async (o: Row) => read(o.where[Op.and] ? liveShares() : shares, o),
      findAndCountAll: async (o: Row) => ({
        rows: liveShares()
          .slice(o.offset, o.offset + o.limit)
          .map((row) => ({ ...row })),
        count: liveShares().length,
      }),
    },
    D2cSession: {
      findOne: async (o: Row) => read(sessions, o)[0],
      findAll: async (o: Row) => {
        if (!o.raw) return read(sessions, o);
        queries.push(o);
        assert.equal(o.attributes.length, 2);
        assert.equal(o.attributes[1][1], 'coverAttachmentId');
        const ids = o.where.sessionId[Op.in];
        assert.equal(o.limit, ids.length);
        const sql = o.attributes[1][0].val;
        assert.doesNotMatch(sql, /sdkItem|checkpoint|SELECT\s+\*/i);
        db.exec('DELETE FROM d2c_session');
        for (const s of sessions) db.prepare('INSERT INTO d2c_session VALUES (?)').run(s.sessionId);
        const rows = db
          .prepare(
            `SELECT sessionId, ${sql} AS coverAttachmentId FROM d2c_session AS D2cSession
          WHERE sessionId IN (${ids.map(() => '?').join(',')}) LIMIT ?`,
          )
          .all(...ids, o.limit);
        afterCover?.();
        return rows;
      },
    },
    D2cWorkspace: {
      findOne: async (o: Row) => read(workspaces, o)[0],
      findAll: async (o: Row) => read(workspaces, o),
    },
    D2cMessageAttachment: {
      findAll: async (o: Row) => {
        assert.deepEqual(o.attributes, [
          'sessionId',
          'attachmentId',
          'objectLocator',
          'size',
          'mimeType',
        ]);
        return db
          .prepare('SELECT * FROM d2c_message_attachment')
          .all()
          .flatMap((a: Row) =>
            a.expiresAt === null &&
            o.where[Op.or].some(
              (pair: Row) => pair.sessionId === a.sessionId && pair.attachmentId === a.attachmentId,
            )
              ? [{ ...a, objectLocator: JSON.parse(a.objectLocator) }]
              : [],
          );
      },
    },
    D2cFile: {},
    D2cTimeline: {},
  };
  const service = createSharingService({ models } as unknown as Sequelize, {
    binary: () => {
      throw new Error('cover must not read binary storage');
    },
  });
  /** 与 screenshots.ts 的单图片助手消息及附件格式一致。 */
  function capture(seq: number, attachment: Row = {}, event: Row = {}, data: Row = {}) {
    const a = {
      sessionId: 'source',
      messageId: `message-${seq}`,
      attachmentId: hash(`capture-${seq}`),
      expiresAt: null,
      objectLocator: '{"url":"https://storage.example.test/SECRET"}',
      fileName: 'preview-r12.png',
      mimeType: 'image/png',
      size: 123,
      width: 100,
      height: 200,
      ...attachment,
    };
    const payload = {
      role: 'assistant',
      text: '运行截图 · 文件修订 r12\n\n入口：index.html',
      attachments: [
        {
          attachmentId: a.attachmentId,
          url: `/api/d2c/sessions/${a.sessionId}/attachments/${a.attachmentId}`,
        },
      ],
      ...data,
    };
    const t = {
      sessionId: a.sessionId,
      messageId: a.messageId,
      runId: 'run',
      seq,
      kind: 'message',
      displayPayload: JSON.stringify(payload),
      ...event,
    };
    db.prepare('INSERT INTO d2c_message_attachment VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      ...Object.values(a),
    );
    db.prepare('INSERT INTO d2c_timeline VALUES (?, ?, ?, ?, ?, ?)').run(...Object.values(t));
    return a.attachmentId;
  }
  return {
    db,
    mysql: { models } as unknown as Sequelize,
    service,
    capture,
    sessions,
    shares,
    workspaces,
    queries,
    afterCover: (fn: () => void) => {
      afterCover = fn;
    },
  };
}

const coverUrl = (id: string, share = shareId) =>
  `/api/d2c/plaza/sessions/${share}/attachments/${id}?view=cover`;

test('list and detail select earliest real screenshot by timeline order, using only authenticated URL', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.capture(50);
  const first = f.capture(12);
  f.capture(
    20,
    {},
    {},
    {
      text: '运行截图 · 文件修订 r12\n\n入口：src/App.tsx\n\n截图已达到高度上限，仅展示页面部分内容。',
    },
  );
  const list = await f.service.list('viewer');
  assert.equal(list.items[0].coverUrl, coverUrl(first));
  assert.equal((await f.service.get('viewer', shareId)).coverUrl, coverUrl(first));
  assert.doesNotMatch(
    JSON.stringify(list),
    /SECRET|objectLocator|storage.example.test|displayPayload/,
  );
  assert.equal(f.queries.length, 2);
});

test('rejects uploaded designs, spoofed filenames, drafts, foreign references and malformed screenshots', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.capture(1, { attachmentId: randomUUID() });
  f.capture(2, {}, {}, { role: 'user' });
  f.capture(3, { fileName: 'design-reference.png' });
  f.capture(4, { expiresAt: '2099-01-01' });
  f.capture(5, { messageId: null });
  f.capture(6, {}, { runId: null });
  f.capture(7, {}, { kind: 'stage' });
  f.capture(8, {}, {}, { text: '用户上传设计稿' });
  f.capture(
    9,
    {},
    {},
    {
      attachments: [
        { attachmentId: hash('capture-9'), url: '/api/d2c/sessions/foreign/attachments/x' },
      ],
    },
  );
  f.capture(10, { objectLocator: null });
  f.capture(11, { mimeType: 'image/jpeg' });
  f.capture(12, { size: 0 });
  f.capture(13, { width: 0 });
  f.capture(14, { fileName: 'preview-r13.png' });
  f.capture(15, {}, { sessionId: 'foreign' });
  f.capture(16, {}, {}, { attachments: [] });
  assert.equal((await f.service.get('viewer', shareId)).coverUrl, null);
  const valid = f.capture(100);
  assert.equal((await f.service.get('viewer', shareId)).coverUrl, coverUrl(valid));
});

test('no screenshot returns null, empty pages skip cover queries', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  assert.equal((await f.service.get('viewer', shareId)).coverUrl, null);
  assert.equal((await f.service.list('viewer')).items[0].coverUrl, null);
  const before = f.queries.length;
  assert.deepEqual((await f.service.list('viewer', 2)).items, []);
  assert.equal(f.queries.length, before);
});

test('one bounded batch for the current page, independent of session count or timeline length', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  for (let i = 0; i < 35; i++) {
    const sessionId = `session-${i}`;
    f.sessions.push({ sessionId, workspaceId: 'workspace' });
    f.shares.push({ sessionId, shareId: randomUUID(), enabled: true });
    f.capture(1, { sessionId });
  }
  const page = await f.service.list('viewer', 2, 12);
  assert.equal(page.items.length, 12);
  assert.ok(
    page.items.every((item) =>
      item.coverUrl?.startsWith(`/api/d2c/plaza/sessions/${item.shareId}/attachments/`),
    ),
  );
  assert.equal(f.queries.length, 1);
  assert.deepEqual(
    f.queries[0].where.sessionId[Op.in],
    f.shares.slice(12, 24).map((s) => s.sessionId),
  );
  assert.equal(f.queries[0].limit, 12);
});

test('long histories do not hide the first screenshot or load large message bodies', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  for (let seq = 1; seq <= 600; seq++)
    f.capture(seq, {}, {}, { role: 'user', text: 'x'.repeat(4096) });
  const id = f.capture(
    601,
    { fileName: 'preview-r1234.png' },
    {},
    {
      text: '运行截图 · 文件修订 r1234\n\n入口：src/App.tsx',
    },
  );
  assert.equal((await f.service.get('viewer', shareId)).coverUrl, coverUrl(id));
  assert.equal(f.queries.length, 1);
  assert.equal(f.queries[0].limit, 1);
});

test('login and invalid or withdrawn shares reject before querying covers', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  await assert.rejects(
    f.service.list(''),
    (e: unknown) => e instanceof SessionError && e.statusCode === 401,
  );
  await assert.rejects(f.service.get('viewer', 'source'));
  f.shares[0].enabled = false;
  await assert.rejects(f.service.get('viewer', shareId));
  assert.equal(f.queries.length, 0);
});

test('withdrawal, token rotation and soft deletion during cover lookup block detail and filter list', async (t) => {
  for (const mutation of ['withdraw', 'rotate', 'session', 'workspace']) {
    for (const method of ['get', 'list']) {
      const f = fixture();
      t.after(() => f.db.close());
      f.capture(1);
      f.afterCover(() => {
        if (mutation === 'withdraw') f.shares[0].enabled = false;
        if (mutation === 'rotate') f.shares[0].shareId = randomUUID();
        if (mutation === 'session') f.sessions[0].deletedAt = new Date();
        if (mutation === 'workspace') f.workspaces[0].deletedAt = new Date();
      });
      if (method === 'get') await assert.rejects(f.service.get('viewer', shareId));
      else assert.deepEqual((await f.service.list('viewer')).items, []);
    }
  }
});

test('saved cover resolves the same earliest plaza screenshot, skips drafts and rechecks publication', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const imageUrl = 'https://images.example.test/runtime.png';
  const locator = JSON.stringify({ url: imageUrl, size: 123, mimeType: 'image/png' });
  f.capture(10, { objectLocator: locator });
  f.capture(20, {
    objectLocator: JSON.stringify({
      url: 'https://images.example.test/later.png',
      size: 123,
      mimeType: 'image/png',
    }),
  });
  const map = await publishedRuntimeCoverUrls(f.mysql, 'viewer', [shareId]);
  assert.equal(map.get(shareId), imageUrl);
  assert.equal(f.queries.length, 1);
  assert.equal((await publishedRuntimeCoverUrls(f.mysql, 'viewer', ['not-a-public-id'])).size, 0);
  f.afterCover(() => {
    f.shares[0].enabled = false;
  });
  assert.equal((await publishedRuntimeCoverUrls(f.mysql, 'viewer', [shareId])).size, 0);
  await assert.rejects(publishedRuntimeCoverUrls(f.mysql, '', [shareId]), { statusCode: 401 });
});
