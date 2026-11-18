import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { Op, Sequelize } from 'sequelize';
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
      ? Object.fromEntries(attrs.map((key: string) => [key, row[key]]))
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
    reason('WORKSPACE_NOT_FOUND'),
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
  assert.equal(f.queries.length, 4);
  const query = f.queries[0];
  assert.equal(query.operation, 'findAndCountAll');
  assert.equal(query.options.limit, 12);
  assert.equal(query.options.offset, 12);
  for (const q of f.queries)
    assert.ok(
      !q.options.attributes.includes('contextSummary') &&
        !q.options.attributes.includes('configJson'),
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
