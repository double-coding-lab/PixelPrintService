import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { Op, Sequelize } from 'sequelize';
import { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyRequest } from 'fastify';
import sharingRoutes from '../src/functions/d2c/sharing/routes';
import { createSharingService } from '../src/functions/d2c/sharing/service';
import { publishedSession } from '../src/functions/d2c/sharing/access';
import { ownedSession, SessionError } from '../src/functions/d2c/session/access';
import { D2cSessionShare, initD2cSessionShare } from '../src/models/D2cSessionShare';

type Row = Record<string, any>;
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const reason = (code: string) => (error: unknown) =>
  error instanceof SessionError && error.reason === code;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);

/** 有界数据库替身实际执行筛选、投影、排序和事务，记录 SQL 形状及锁序。 */
function fixture() {
  const tables: Record<string, Row[]> = {
    D2cSessionShare: [],
    D2cSession: [
      {
        sessionId: 'session-a',
        workspaceId: 'workspace-a',
        createdUserId: 'owner',
        creatorName: 'Owner',
        name: 'Demo',
        target: 'h5',
        fileRevision: 2,
        timelineSeq: 9,
        createdAt: new Date(1),
        contextSummary: 'private-summary',
        credentialId: 'secret',
      },
    ],
    D2cWorkspace: [
      {
        workspaceId: 'workspace-a',
        createdUserId: 'owner',
        teamId: 'team-a',
        configJson: { secret: 'config' },
      },
    ],
    D2cTeam: [{ teamId: 'team-a' }],
    D2cTeamMember: [{ teamId: 'team-a', userId: 'member' }],
    D2cFile: [],
    D2cTimeline: [],
    D2cMessageAttachment: [],
  };
  const queries: Array<{ table: string; options: Row; operation: string }> = [];
  const locks: string[] = [];
  let downloads = 0;
  let onDownload: (() => void) | undefined;
  let binaryData: Buffer = Buffer.from('binary');
  let tail = Promise.resolve();
  function match(row: Row, where: Row = {}): boolean {
    return Reflect.ownKeys(where).every((key) => {
      if (key === Op.and) {
        const conditions = (where as Record<symbol, any>)[key];
        if (Array.isArray(conditions)) return conditions.every((part: Row) => match(row, part));
        assert.match(
          (where as Record<symbol, any>)[key].val,
          /EXISTS .*d2c_session.*d2c_workspace.*deletedAt.*D2cSessionShare/s,
        );
        const session = tables.D2cSession.find(
          (item) => item.sessionId === row.sessionId && !item.deletedAt,
        );
        return (
          !!session &&
          tables.D2cWorkspace.some(
            (item) => item.workspaceId === session.workspaceId && !item.deletedAt,
          )
        );
      }
      const actual = String(key)
        .split('.')
        .reduce((value, part) => value?.[part], row);
      const expected = where[key as keyof Row];
      if (expected && typeof expected === 'object')
        return Reflect.ownKeys(expected).every((op) =>
          op === Op.gt
            ? actual > expected[op]
            : op === Op.lt
              ? actual < expected[op]
              : op === Op.in
                ? expected[op].includes(actual)
                : false,
        );
      return actual === expected;
    });
  }
  function rows(table: string, options: Row) {
    const result = tables[table].filter((row) => !row.deletedAt && match(row, options.where));
    for (const [key, direction] of [...(options.order ?? [])].reverse())
      result.sort(
        (a, b) =>
          (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (direction === 'DESC' ? -1 : 1),
      );
    return result;
  }
  function project(row: Row, options: Row): Row {
    const attrs = options.attributes;
    const projected = Array.isArray(attrs)
      ? Object.fromEntries(
          attrs.map((key: string | [unknown, string]) => {
            if (typeof key === 'string') return [key, row[key]];
            if (key[1] !== 'displayPayload') return [key[1], row[key[1]]];
            const value = row.displayPayload;
            if (row.kind !== 'stage' || value?.stage !== 'subagent') return [key[1], value];
            const { message: _message, reasoning: _reasoning, ...overview } = value;
            return [key[1], overview];
          }),
        )
      : { ...row };
    return Object.assign(projected, {
      async update(values: Row) {
        Object.assign(row, values);
        Object.assign(projected, values);
        return projected;
      },
    });
  }
  const models = Object.fromEntries(
    Object.keys(tables).map((table) => [
      table,
      {
        async findOne(options: Row) {
          queries.push({ table, options, operation: 'findOne' });
          if (options.lock) locks.push(table);
          const row = rows(table, options)[0];
          return row ? project(row, options) : null;
        },
        async findAll(options: Row) {
          queries.push({ table, options, operation: 'findAll' });
          return rows(table, options)
            .slice(
              options.offset ?? 0,
              options.limit === undefined ? undefined : (options.offset ?? 0) + options.limit,
            )
            .map((row) => project(row, options));
        },
        async findAndCountAll(options: Row) {
          queries.push({ table, options, operation: 'findAndCountAll' });
          if (options.replacements) {
            // 执行真实相关子查询，验证 SQL 过滤先于 count/limit；仅适配 MySQL 的正则函数。
            const db = new DatabaseSync(':memory:');
            try {
              db.function('regexp', (pattern, value) =>
                Number(
                  value !== null &&
                    new RegExp(String(pattern).replaceAll('[[:space:]]', '\\s')).test(
                      String(value),
                    ),
                ),
              );
              db.function('CONCAT', { varargs: true }, (...values) => values.join(''));
              db.exec(`CREATE TABLE d2c_session (sessionId TEXT, workspaceId TEXT, createdUserId TEXT, deletedAt TEXT);
                CREATE TABLE d2c_workspace (workspaceId TEXT, createdUserId TEXT, teamId TEXT, deletedAt TEXT);
                CREATE TABLE d2c_session_share (sessionId TEXT, shareId TEXT, enabled INTEGER, createdAt INTEGER);`);
              for (const row of tables.D2cSession)
                db.prepare('INSERT INTO d2c_session VALUES (?, ?, ?, ?)').run(
                  row.sessionId,
                  row.workspaceId,
                  row.createdUserId ?? null,
                  row.deletedAt ? 'deleted' : null,
                );
              for (const row of tables.D2cWorkspace)
                db.prepare('INSERT INTO d2c_workspace VALUES (?, ?, ?, ?)').run(
                  row.workspaceId,
                  row.createdUserId ?? null,
                  row.teamId ?? null,
                  row.deletedAt ? 'deleted' : null,
                );
              for (const row of tables.D2cSessionShare)
                db.prepare('INSERT INTO d2c_session_share VALUES (?, ?, ?, ?)').run(
                  row.sessionId,
                  row.shareId,
                  Number(row.enabled),
                  Number(row.createdAt),
                );
              const where = `enabled = 1 AND ${options.where[Op.and].val}`;
              const count = db
                .prepare(
                  `SELECT COUNT(*) AS total FROM d2c_session_share AS D2cSessionShare WHERE ${where}`,
                )
                .get(options.replacements)!.total;
              const selected = db
                .prepare(
                  `SELECT shareId FROM d2c_session_share AS D2cSessionShare WHERE ${where} ORDER BY createdAt DESC, shareId DESC LIMIT ${options.limit} OFFSET ${options.offset}`,
                )
                .all(options.replacements);
              return {
                count: Number(count),
                rows: selected.map((item) =>
                  project(tables[table].find((row) => row.shareId === item.shareId)!, options),
                ),
              };
            } finally {
              db.close();
            }
          }
          const all = rows(table, options);
          return {
            count: all.length,
            rows: all
              .slice(options.offset, options.offset + options.limit)
              .map((row) => project(row, options)),
          };
        },
        async create(values: Row) {
          assert.ok(!tables[table].some((row) => row.sessionId === values.sessionId));
          const row = { ...values, createdAt: new Date() };
          tables[table].push(row);
          return project(row, {});
        },
      },
    ]),
  );
  const mysql = {
    models,
    async transaction(callback: (tx: Row) => Promise<unknown>) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const snapshot = structuredClone(tables);
      try {
        return await callback({ LOCK: { UPDATE: 'UPDATE' } });
      } catch (error) {
        for (const key of Object.keys(tables)) tables[key] = snapshot[key];
        throw error;
      } finally {
        release();
      }
    },
  } as unknown as Sequelize;
  const service = createSharingService(mysql, {
    binary: () => ({
      async downloadFile() {
        downloads++;
        onDownload?.();
        return binaryData;
      },
    }),
  });
  function file(path: string, kind = 'source', content: string | null = 'hello') {
    const row = {
      fileId: randomUUID(),
      sessionId: 'session-a',
      path,
      kind,
      content,
      pathHash: sha(path),
      objectLocator: content === null ? { private: 'locator' } : null,
      mimeType: content === null ? 'image/png' : 'text/plain',
      revision: 1,
      size: content === null ? binaryData.length : Buffer.byteLength(content),
      sha256: sha(content ?? binaryData),
    };
    tables.D2cFile.push(row);
    return row;
  }
  function event(seq: number, kind: string, displayPayload: Row, extra: Row = {}) {
    const row = {
      sessionId: 'session-a',
      entryId: `event-${seq}`,
      kind,
      seq,
      displayPayload,
      sdkItem: { secret: 'sdk' },
      completed: true,
      ...extra,
    };
    tables.D2cTimeline.push(row);
    return row;
  }
  return {
    service,
    mysql,
    tables,
    queries,
    locks,
    file,
    event,
    downloads: () => downloads,
    setBinary(data: Buffer) {
      binaryData = data;
    },
    onDownload(fn: () => void) {
      onDownload = fn;
    },
  };
}

test('sharing model has comments/defaults, unique session and share IDs, and never connects', async () => {
  const mysql = new Sequelize('test', 'test', 'test', { dialect: 'mysql', logging: false });
  initD2cSessionShare(mysql);
  for (const [name, field] of Object.entries(D2cSessionShare.getAttributes())) {
    assert.ok(field.comment, name);
    if (!field.allowNull && !field.autoIncrement)
      assert.notEqual(field.defaultValue, undefined, name);
  }
  assert.ok(
    D2cSessionShare.options.indexes?.some(
      (index) => index.unique && index.fields?.includes('sessionId'),
    ),
  );
  assert.ok(
    D2cSessionShare.options.indexes?.some(
      (index) => index.unique && index.fields?.includes('shareId'),
    ),
  );
  await mysql.close();
});

test('all APIs require authenticated identity, even public reads', async () => {
  const f = fixture();
  for (const call of [
    () => f.service.status('', 'session-a'),
    () => f.service.set('', 'session-a', true),
    () => f.service.list(''),
    () => f.service.get('', randomUUID()),
    () => f.service.timeline('', randomUUID()),
    () => f.service.files('', randomUUID()),
    () => f.service.file('', randomUUID(), 'f'),
    () => f.service.attachment('', randomUUID(), 'a'),
  ])
    await assert.rejects(call(), reason('LOGIN_REQUIRED'));
});

test('creator alone toggles; current team member reads status but cannot publish or revoke', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.status('member', 'session-a'), {
    public: false,
    shareId: null,
    canManage: false,
  });
  for (const enabled of [true, false])
    await assert.rejects(
      f.service.set('member', 'session-a', enabled),
      reason('SESSION_CREATOR_REQUIRED'),
    );
  await f.service.set('owner', 'session-a', true);
  await assert.rejects(
    f.service.set('stranger', 'session-a', false),
    reason('SESSION_CREATOR_REQUIRED'),
  );
  f.tables.D2cSession[0].createdUserId = null;
  await assert.rejects(
    f.service.set('owner', 'session-a', false),
    reason('SESSION_CREATOR_REQUIRED'),
  );
});

test('concurrent publication retains one UUID, revoke then republish rotates permanently', async () => {
  const f = fixture();
  const [first, second] = await Promise.all([
    f.service.set('owner', 'session-a', true),
    f.service.set('OWNER', 'session-a', true),
  ]);
  assert.equal(first.shareId, second.shareId);
  assert.equal(f.tables.D2cSessionShare.length, 1);
  assert.deepEqual(f.locks.slice(0, 3), ['D2cWorkspace', 'D2cSession', 'D2cSessionShare']);
  await f.service.set('owner', 'session-a', false);
  await assert.rejects(f.service.get('reader', first.shareId!), reason('SHARE_NOT_FOUND'));
  const renewed = await f.service.set('owner', 'session-a', true);
  assert.notEqual(renewed.shareId, first.shareId);
  await assert.rejects(f.service.get('reader', first.shareId!), reason('SHARE_NOT_FOUND'));
  assert.equal((await f.service.get('reader', renewed.shareId!)).sessionId, 'session-a');
});

test('public authorizer checks live session/workspace each read, carries transaction, does not broaden private access', async () => {
  const f = fixture();
  const { shareId } = await f.service.set('owner', 'session-a', true);
  await assert.rejects(ownedSession(f.mysql, 'reader', 'session-a'), reason('WORKSPACE_NOT_FOUND'));
  f.queries.length = 0;
  const tx = {} as any;
  const result = await publishedSession(f.mysql, 'reader', shareId!, tx);
  assert.equal(result.session.sessionId, 'session-a');
  assert.ok(f.queries.every((q) => q.options.transaction === tx));
  assert.ok(
    f.queries
      .filter((q) => q.table !== 'D2cSessionShare')
      .every(
        (q) =>
          !q.options.attributes.includes('configJson') &&
          !q.options.attributes.includes('contextSummary'),
      ),
  );
  f.tables.D2cWorkspace[0].deletedAt = new Date();
  for (const read of [
    () => f.service.get('reader', shareId!),
    () => f.service.timeline('reader', shareId!),
    () => f.service.files('reader', shareId!),
    () => f.service.file('reader', shareId!, 'f'),
    () => f.service.attachment('reader', shareId!, 'a'),
  ])
    await assert.rejects(read(), reason('SHARE_NOT_FOUND'));
  f.tables.D2cWorkspace[0].deletedAt = null;
  f.tables.D2cSession[0].deletedAt = new Date();
  await assert.rejects(f.service.get('reader', shareId!), reason('SHARE_NOT_FOUND'));
});

test('metadata returns only explicit latest display fields', async () => {
  const f = fixture();
  const { shareId } = await f.service.set('owner', 'session-a', true);
  f.tables.D2cSession[0].name = 'Latest';
  const value = await f.service.get('reader', shareId!);
  assert.equal(value.name, 'Latest');
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      'shareId',
      'coverUrl',
      'canManage',
      'sourceSession',
      'sessionId',
      'name',
      'target',
      'creatorName',
      'createdEid',
      'fileRevision',
      'timelineSeq',
      'createdAt',
    ].sort(),
  );
});

test('list paginates and counts alive rows in DB, queries bounded page metadata without private columns', async () => {
  const f = fixture();
  for (let i = 0; i < 40; i++) {
    f.tables.D2cSession.push({
      ...f.tables.D2cSession[0],
      sessionId: `session-${i}`,
      deletedAt: i === 0 ? new Date() : null,
    });
    f.tables.D2cSessionShare.push({
      sessionId: `session-${i}`,
      shareId: randomUUID(),
      enabled: true,
      createdAt: new Date(i),
    });
  }
  f.tables.D2cSession.push({
    ...f.tables.D2cSession[0],
    sessionId: 'orphan',
    workspaceId: 'missing',
  });
  f.tables.D2cSessionShare.push({
    sessionId: 'orphan',
    shareId: randomUUID(),
    enabled: true,
    createdAt: new Date(100),
  });
  const result = await f.service.list('reader', 2, 12);
  assert.equal(result.total, 39);
  assert.equal(result.items.length, 12);
  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 12);
  assert.equal(result.items[0].sessionId, 'session-27');
  assert.equal(f.queries.length, 9); // 同页12个会话共用一次工作区权限检查。
  assert.ok(result.items.every((item) => item.coverUrl === null));
  const query = f.queries[0];
  assert.equal(query.operation, 'findAndCountAll');
  assert.equal(query.options.limit, 12);
  assert.equal(query.options.offset, 12);
  for (const q of f.queries)
    assert.ok(
      !(q.options.attributes ?? []).includes('contextSummary') &&
        !(q.options.attributes ?? []).includes('configJson'),
    );
  f.tables.D2cWorkspace[0].deletedAt = new Date();
  assert.equal((await f.service.list('reader')).total, 0);
});

test('timeline strips sdk/private fields, excludes queue variants and internal events, rewrites own links', async () => {
  const f = fixture();
  const { shareId } = await f.service.set('owner', 'session-a', true);
  f.event(1, 'stage', { action: 'message_queue', content: 'private draft' });
  f.event(2, 'stage', { stage: 'message_queue', content: 'private legacy' });
  f.event(3, 'message', {
    role: 'assistant',
    text: 'See /api/d2c/sessions/session-a/files/file-a and /api/d2c/sessions/other/files/file-b',
    checkpoint: 'private',
    credentials: 'secret',
    config: 'secret',
  });
  f.event(4, 'checkpoint', { private: 'secret' });
  f.event(5, 'file_changed', {
    action: 'created',
    fileId: 'hidden',
    path: '.d2c-cache/secret.json',
    revision: 1,
    fileRevision: 1,
  });
  const result = await f.service.timeline('reader', shareId!);
  assert.deepEqual(
    result.entries.map((row) => row.seq),
    [3],
  );
  assert.equal(result.nextSeq, 5);
  assert.equal(
    result.entries[0].data.text,
    `See /api/d2c/plaza/sessions/${shareId}/files/file-a and `,
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /private|secret|sdkItem|checkpoint|credentials|config/,
  );
});

test('filtered timeline pages still advance cursors in both directions', async () => {
  const f = fixture();
  const { shareId } = await f.service.set('owner', 'session-a', true);
  f.event(1, 'stage', { action: 'message_queue' });
  f.event(2, 'message', { role: 'user', text: 'sent' });
  f.event(3, 'stage', { action: 'message_queue' });
  const first = await f.service.timeline('reader', shareId!, 0, 1);
  assert.equal(first.entries.length, 0);
  assert.equal(first.nextSeq, 1);
  assert.equal(first.hasMore, true);
  const next = await f.service.timeline('reader', shareId!, first.nextSeq, 1);
  assert.equal(next.entries[0].seq, 2);
  const reverse = await f.service.timeline('reader', shareId!, 0, 1, 0);
  assert.equal(reverse.previousSeq, 3);
  assert.equal(reverse.hasMore, true);
  assert.equal(reverse.entries.length, 0);
  assert.equal(
    (await f.service.timeline('reader', shareId!, 0, 1, reverse.previousSeq)).entries[0].seq,
    2,
  );
});

test('subagent event projection removes nested extras and filters agent ID', async () => {
  const f = fixture();
  const { shareId } = await f.service.set('owner', 'session-a', true);
  const agentId = randomUUID();
  f.event(1, 'stage', {
    stage: 'subagent',
    agentId,
    role: 'ui',
    status: 'message',
    message: { role: 'assistant', text: 'visible', config: 'secret' },
    sdkItem: 'private',
  });
  f.event(2, 'stage', {
    stage: 'subagent',
    agentId: randomUUID(),
    role: 'ui',
    status: 'completed',
  });
  const result = await f.service.timeline('reader', shareId!, 0, 500, undefined, agentId);
  assert.equal(result.entries.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|config|sdkItem/);
});

test('files exclude protected paths and kinds; text/binary DTOs verify content integrity', async () => {
  const f = fixture();
  const { shareId } = await f.service.set('owner', 'session-a', true);
  const text = f.file('src/App.tsx');
  const binary = f.file('assets/a.png', 'asset', null);
  const excluded = [
    '.d2c-cache/x.json',
    'SKILL.md',
    'pp-d2c.config.json',
    'node_modules/a.js',
    '../escape',
    'src/.env',
  ].map((path) => f.file(path));
  excluded.push(f.file('internal.json', 'internal'));
  const list = await f.service.files('reader', shareId!);
  assert.equal(list.length, 2);
  assert.ok(list.every((row) => row.url.startsWith(`/api/d2c/plaza/sessions/${shareId}/files/`)));
  assert.doesNotMatch(JSON.stringify(list), /objectLocator|private/);
  assert.equal(((await f.service.file('reader', shareId!, text.fileId)) as Row).content, 'hello');
  assert.equal(f.downloads(), 0);
  assert.ok(
    Buffer.isBuffer(((await f.service.file('reader', shareId!, binary.fileId)) as Row).data),
  );
  for (const row of excluded)
    await assert.rejects(f.service.file('reader', shareId!, row.fileId), reason('FILE_NOT_FOUND'));
  text.sha256 = sha('changed');
  await assert.rejects(f.service.file('reader', shareId!, text.fileId), reason('FILE_CORRUPT'));
  binary.size++;
  await assert.rejects(f.service.file('reader', shareId!, binary.fileId), reason('FILE_CORRUPT'));
});

test('file lookup rejects cross-session IDs, path corruption, header injection; unknown MIME becomes octet-stream', async () => {
  const f = fixture();
  const { shareId } = await f.service.set('owner', 'session-a', true);
  const row = f.file('assets/a.bin', 'asset', null);
  row.mimeType = 'application/x-custom';
  assert.equal(
    (await f.service.file('reader', shareId!, row.fileId)).mimeType,
    'application/octet-stream',
  );
  row.mimeType = 'text/plain\r\nX-Evil: 1';
  await assert.rejects(f.service.file('reader', shareId!, row.fileId), reason('FILE_CORRUPT'));
  row.pathHash = sha('else');
  await assert.rejects(f.service.file('reader', shareId!, row.fileId), reason('FILE_CORRUPT'));
  row.sessionId = 'other';
  await assert.rejects(f.service.file('reader', shareId!, row.fileId), reason('FILE_NOT_FOUND'));
});

test('revocation during download blocks bytes before returning', async () => {
  const f = fixture();
  const { shareId } = await f.service.set('owner', 'session-a', true);
  const row = f.file('assets/a.bin', 'asset', null);
  f.onDownload(() => {
    f.tables.D2cSessionShare[0].enabled = false;
  });
  await assert.rejects(f.service.file('reader', shareId!, row.fileId), reason('SHARE_NOT_FOUND'));
});

/** 真正可解析且 CRC 正确的 PNG，复用已有附件测试的编码路径。 */
async function attachmentFixture() {
  const f = fixture();
  // 独立使用固定 PNG 字节；错误 CRC 由测试前修正而不放宽生产校验。
  const data = Buffer.from(png);
  for (let offset = 8; offset < data.length; ) {
    const size = data.readUInt32BE(offset);
    let crc = 0xffffffff;
    for (const byte of data.subarray(offset + 4, offset + 8 + size)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    data.writeUInt32BE((crc ^ 0xffffffff) >>> 0, offset + 8 + size);
    offset += size + 12;
  }
  f.setBinary(data);
  const { shareId } = await f.service.set('owner', 'session-a', true);
  const attachmentId = 'attachment-a';
  const row = {
    sessionId: 'session-a',
    attachmentId,
    messageId: 'message-a',
    eid: 'owner',
    objectLocator: { private: 'locator' },
    size: data.length,
    sha256: sha(data),
    mimeType: 'image/png',
    width: 1,
    height: 1,
    expiresAt: null,
  };
  f.tables.D2cMessageAttachment.push(row);
  f.event(
    1,
    'message',
    {
      role: 'user',
      text: 'sent',
      attachments: [
        {
          attachmentId,
          url: '/api/d2c/sessions/session-a/attachments/attachment-a',
          mimeType: 'image/png',
          width: 1,
          height: 1,
          size: data.length,
        },
      ],
    },
    { messageId: 'message-a' },
  );
  return { ...f, shareId: shareId!, row };
}

test('sent message attachment resolves to bytes; pending, queued, foreign and unreferenced images cannot download', async () => {
  const f = await attachmentFixture();
  const image = await f.service.attachment('reader', f.shareId, 'attachment-a');
  assert.equal(image.mimeType, 'image/png');
  assert.ok(Buffer.isBuffer(image.data));
  const sent = { ...f.row };
  for (const change of [
    { messageId: null },
    { expiresAt: new Date() },
    { sessionId: 'other' },
    { messageId: 'not-sent' },
  ]) {
    Object.assign(f.row, sent, change);
    await assert.rejects(
      f.service.attachment('reader', f.shareId, 'attachment-a'),
      reason('ATTACHMENT_NOT_FOUND'),
    );
  }
  Object.assign(f.row, sent);
  f.tables.D2cTimeline[0].displayPayload.attachments = [];
  await assert.rejects(
    f.service.attachment('reader', f.shareId, 'attachment-a'),
    reason('ATTACHMENT_NOT_FOUND'),
  );
  assert.equal(f.downloads(), 1);
});

test('attachment hash, size, MIME, image dimensions and actual bytes must agree', async () => {
  const f = await attachmentFixture();
  const original = { ...f.row };
  for (const change of [
    { sha256: sha('bad') },
    { size: f.row.size + 1 },
    { width: 2 },
    { mimeType: 'text/html' },
    { mimeType: 'image/jpeg' },
  ]) {
    Object.assign(f.row, original, change);
    await assert.rejects(
      f.service.attachment('reader', f.shareId, 'attachment-a'),
      reason('ATTACHMENT_CORRUPT'),
    );
  }
  Object.assign(f.row, original);
  const bad = Buffer.from('not an image');
  f.setBinary(bad);
  Object.assign(f.row, { size: bad.length, sha256: sha(bad) });
  await assert.rejects(
    f.service.attachment('reader', f.shareId, 'attachment-a'),
    reason('ATTACHMENT_CORRUPT'),
  );
});

test('invalid share IDs and pagination fail explicitly', async () => {
  const f = fixture();
  await assert.rejects(f.service.get('reader', 'session-a'), reason('INVALID_SHARE_ID'));
  for (const [page, pageSize] of [
    [0, 12],
    [1, 0],
    [1, 101],
    [NaN, 12],
  ])
    await assert.rejects(f.service.list('reader', page, pageSize), reason('INVALID_PAGE'));
});

test('legacy personal session: workspace owner may publish/revoke without backfilling creator', async () => {
  const f = fixture();
  f.tables.D2cSession[0].createdUserId = null;
  f.tables.D2cWorkspace[0].teamId = null;
  assert.equal((await f.service.status('OWNER', 'session-a')).canManage, true);
  const published = await f.service.set('owner', 'session-a', true);
  assert.equal(published.public, true);
  await f.service.set('owner', 'session-a', false);
  assert.equal((await f.service.status('owner', 'session-a')).public, false);
  assert.equal(f.tables.D2cSession[0].createdUserId, null);
  await assert.rejects(f.service.status('reader', 'session-a'));
  await assert.rejects(f.service.set('reader', 'session-a', true));
});

test('legacy team session: neither workspace owner nor teammate gains publication permission', async () => {
  const f = fixture();
  f.tables.D2cSession[0].createdUserId = null;
  for (const eid of ['owner', 'member']) {
    assert.equal((await f.service.status(eid, 'session-a')).canManage, false);
    await assert.rejects(f.service.set(eid, 'session-a', true), reason('SESSION_CREATOR_REQUIRED'));
  }
  assert.equal(f.tables.D2cSessionShare.length, 0);
});

test('explicit session creator stays authoritative even in a personal workspace', async () => {
  const f = fixture();
  f.tables.D2cWorkspace[0].teamId = null;
  f.tables.D2cSession[0].createdUserId = 'another-creator';
  assert.equal((await f.service.status('owner', 'session-a')).canManage, false);
  await assert.rejects(
    f.service.set('owner', 'session-a', true),
    reason('SESSION_CREATOR_REQUIRED'),
  );
});

test('empty legacy fields remain compatible; moving to a team rechecks write permission', async () => {
  const f = fixture();
  f.tables.D2cWorkspace[0].teamId = '';
  f.tables.D2cSession[0].createdUserId = '  ';
  assert.equal((await f.service.status('owner', 'session-a')).canManage, true);
  await f.service.set('owner', 'session-a', true);
  f.tables.D2cWorkspace[0].teamId = 'team-a';
  assert.equal((await f.service.status('owner', 'session-a')).canManage, false);
  await assert.rejects(
    f.service.set('owner', 'session-a', false),
    reason('SESSION_CREATOR_REQUIRED'),
  );
});

test('mine executes ownership SQL before pagination/count, normalizes creators and limits legacy fallback to personal workspaces', async () => {
  const f = fixture();
  const add = (
    id: string,
    creator: string | null,
    teamId: string | null,
    owner = 'owner',
    enabled = true,
  ) => {
    const workspaceId = `workspace-${id}`;
    const sessionId = `session-${id}`;
    f.tables.D2cWorkspace.push({ workspaceId, createdUserId: owner, teamId });
    f.tables.D2cSession.push({ sessionId, workspaceId, createdUserId: creator, name: id });
    f.tables.D2cSessionShare.push({
      sessionId,
      shareId: randomUUID(),
      enabled,
      createdAt: new Date(f.tables.D2cSessionShare.length + 1),
    });
  };
  add('explicit', ' \tOwNeR\r\n', 'team-a');
  add('legacy-null', null, null, ' OWNER ');
  add('legacy-empty', ' \t\n ', '', 'owner');
  add('team-no-fallback', null, 'team-a');
  add('other-creator', 'member', null);
  add('other-owner', null, '', 'member');
  add('disabled', 'owner', null, 'owner', false);
  add('deleted-session', 'owner', null);
  f.tables.D2cSession.at(-1)!.deletedAt = new Date();
  add('deleted-workspace', 'owner', null);
  f.tables.D2cWorkspace.at(-1)!.deletedAt = new Date();
  const first = await f.service.list('OWNER', 1, 2, 'mine');
  const second = await f.service.list('owner', 2, 2, 'mine');
  assert.equal(first.total, 3);
  assert.equal(second.total, 3);
  assert.deepEqual(
    [...first.items, ...second.items].map((item) => item.name),
    ['legacy-empty', 'legacy-null', 'explicit'],
  );
  assert.ok(
    [...first.items, ...second.items].every((item) => item.canManage && item.sourceSession),
  );
  const query = f.queries.find((q) => q.operation === 'findAndCountAll')!.options;
  assert.deepEqual(query.replacements, { plazaUser: 'owner' });
  assert.doesNotMatch(query.where[Op.and].val, /OWNER|'owner'/);
  const mysql = new Sequelize('test', 'test', 'test', { dialect: 'mysql', logging: false });
  try {
    initD2cSessionShare(mysql);
    const generated: Array<{ sql: string; options: Row }> = [];
    // 保留真实 Sequelize findAndCountAll/query generator，仅截断数据库传输。
    mysql.query = (async (sql: string, options: Row) => {
      generated.push({ sql, options });
      return options.plain ? { count: 3 } : [];
    }) as typeof mysql.query;
    await D2cSessionShare.findAndCountAll(query);
    assert.equal(generated.length, 2);
    for (const entry of generated) {
      assert.match(entry.sql, /EXISTS .*REGEXP CONCAT.*:plazaUser/s);
      assert.deepEqual(entry.options.replacements, { plazaUser: 'owner' });
    }
    const count = generated.find((entry) => /count\(/i.test(entry.sql))!;
    const page = generated.find((entry) => !/count\(/i.test(entry.sql))!;
    assert.doesNotMatch(count.sql, /LIMIT/);
    assert.match(page.sql, /LIMIT 0, 2/);
  } finally {
    await mysql.close();
  }
  assert.equal((await f.service.list('owner')).total, 6);
  await assert.rejects(
    f.service.list('owner', 1, 12, 'invalid' as 'mine'),
    reason('INVALID_SCOPE'),
  );
});

test('sourceSession requires current private read permission; former creator remains in mine without management rights', async () => {
  const f = fixture();
  f.tables.D2cSession[0].createdUserId = 'member';
  const { shareId } = await f.service.set('member', 'session-a', true);
  assert.deepEqual((await f.service.get('member', shareId!)).sourceSession, {
    workspaceId: 'workspace-a',
    sessionId: 'session-a',
  });
  assert.equal((await f.service.get('member', shareId!)).canManage, true);
  const owner = await f.service.get('owner', shareId!);
  assert.equal(owner.canManage, false);
  assert.ok(owner.sourceSession);
  const stranger = await f.service.get('reader', shareId!);
  assert.equal(stranger.canManage, false);
  assert.equal(stranger.sourceSession, null);
  f.tables.D2cTeamMember.length = 0;
  const mine = await f.service.list('member', 1, 12, 'mine');
  assert.equal(mine.total, 1);
  assert.equal(mine.items.length, 1);
  assert.equal(mine.items[0].canManage, false);
  assert.equal(mine.items[0].sourceSession, null);
  const detail = await f.service.get('member', shareId!);
  assert.equal(detail.canManage, false);
  assert.equal(detail.sourceSession, null);
  assert.doesNotMatch(
    JSON.stringify(detail),
    /workspace-a|configJson|credentialId|private-summary/,
  );
  await assert.rejects(
    f.service.set('member', 'session-a', false),
    (error: unknown) => error instanceof SessionError && error.statusCode === 403,
  );
  assert.equal(f.tables.D2cSessionShare[0].enabled, true);
});

test('get rereads current metadata after async permissions and hides stale source when association changes', async () => {
  const f = fixture();
  const { shareId } = await f.service.set('owner', 'session-a', true);
  const workspaces = f.mysql.models.D2cWorkspace;
  const original = workspaces.findOne.bind(workspaces);
  workspaces.findOne = (async (options: Row) => {
    const row = await original(options);
    if (options.attributes?.includes('createdUserId')) {
      f.tables.D2cSession[0].workspaceId = 'new-workspace';
      f.tables.D2cSession[0].name = 'Moved';
    }
    return row;
  }) as typeof workspaces.findOne;
  f.tables.D2cWorkspace.push({
    workspaceId: 'new-workspace',
    createdUserId: 'other',
    teamId: null,
  });
  const result = await f.service.get('owner', shareId!);
  assert.equal(result.name, 'Moved');
  assert.equal(result.sourceSession, null);
  assert.equal(result.canManage, false);
});

test('list/get recheck revocation, rotation and deletion after asynchronous private permission checks', async () => {
  for (const mutation of ['revoke', 'rotate', 'session-delete', 'workspace-delete']) {
    for (const operation of ['list', 'get']) {
      const f = fixture();
      const { shareId } = await f.service.set('owner', 'session-a', true);
      const model = f.mysql.models.D2cWorkspace;
      const original = model.findOne.bind(model);
      model.findOne = (async (options: Row) => {
        const row = await original(options);
        if (options.attributes?.includes('createdUserId')) {
          if (mutation === 'revoke') f.tables.D2cSessionShare[0].enabled = false;
          if (mutation === 'rotate') f.tables.D2cSessionShare[0].shareId = randomUUID();
          if (mutation === 'session-delete') f.tables.D2cSession[0].deletedAt = new Date();
          if (mutation === 'workspace-delete') f.tables.D2cWorkspace[0].deletedAt = new Date();
        }
        return row;
      }) as typeof model.findOne;
      if (operation === 'list')
        assert.deepEqual((await f.service.list('owner', 1, 12, 'mine')).items, [], mutation);
      else
        await assert.rejects(f.service.get('owner', shareId!), reason('SHARE_NOT_FOUND'), mutation);
    }
  }
});

test('private permission database errors propagate instead of disguising them as no access', async () => {
  const f = fixture();
  const { shareId } = await f.service.set('owner', 'session-a', true);
  const model = f.mysql.models.D2cWorkspace;
  const original = model.findOne.bind(model);
  model.findOne = (async (options: Row) => {
    if (options.attributes?.includes('createdUserId')) throw new Error('database unavailable');
    return original(options);
  }) as typeof model.findOne;
  await assert.rejects(f.service.get('owner', shareId!), /database unavailable/);
  await assert.rejects(f.service.list('owner', 1, 12, 'mine'), /database unavailable/);
});

test('HTTP real service returns mine permissions/source safely and denies lost creator revocation with403', async (t) => {
  const f = fixture();
  f.tables.D2cSession[0].createdUserId = 'member';
  const { shareId } = await f.service.set('member', 'session-a', true);
  let userId = 'member';
  const app = Fastify();
  t.after(() => app.close());
  app.decorateRequest(
    'getUser',
    async () => ({ userId, name: userId }) as Awaited<ReturnType<FastifyRequest['getUser']>>,
  );
  app.register(sharingRoutes, { prefix: '/api/d2c', sharing: async () => f.service });
  await app.ready();
  const url = '/api/d2c/plaza/sessions?scope=mine&pageSize=1';
  const available = await app.inject(url);
  assert.equal(available.statusCode, 200, available.body);
  assert.equal(available.json().data.items[0].canManage, true);
  assert.deepEqual(available.json().data.items[0].sourceSession, {
    workspaceId: 'workspace-a',
    sessionId: 'session-a',
  });
  f.tables.D2cTeamMember.length = 0;
  const lost = await app.inject(url);
  assert.equal(lost.statusCode, 200, lost.body);
  assert.equal(lost.json().data.total, 1);
  assert.equal(lost.json().data.items[0].canManage, false);
  assert.equal(lost.json().data.items[0].sourceSession, null);
  const detail = await app.inject(`/api/d2c/plaza/sessions/${shareId}`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().data.sourceSession, null);
  const denied = await app.inject({
    method: 'PUT',
    url: '/api/d2c/sessions/session-a/sharing',
    headers: { 'x-requested-with': 'PixelPrint' },
    payload: { public: false },
  });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(f.tables.D2cSessionShare[0].enabled, true);
  userId = 'owner';
  const other = await app.inject(url);
  assert.equal(other.json().data.total, 0);
  assert.equal(
    (await app.inject(`/api/d2c/plaza/sessions/${shareId}`)).json().data.canManage,
    false,
  );
});
