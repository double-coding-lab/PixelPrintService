import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { Op, Sequelize } from 'sequelize';
import { forkPublishedSession, type ForkInput } from '../src/functions/d2c/sharing/fork';
import { createSharingService } from '../src/functions/d2c/sharing/service';
import { SessionError } from '../src/functions/d2c/session/access';
import { sameUser } from '../src/functions/d2c/team/access';
import { createAttachmentService } from '../src/functions/d2c/session/attachments';
import { createFileService } from '../src/functions/d2c/files/service';
import { prepareTextContent, resolveTextContent } from '../src/functions/d2c/content/runtime';
import { enableTextContent } from './helpers/content';
import { createRunCheckpointSaver } from '../src/functions/d2c/run/agent/checkpoint';
import { replayHistory } from '../src/functions/d2c/run/history';
import { storedHistoryToMessages } from '../src/functions/d2c/run/agent/history';
import { initD2cAgentCheckpoint } from '../src/models/D2cAgentCheckpoint';
import { initD2cAgentWrite } from '../src/models/D2cAgentWrite';

type Row = Record<string, any>;
type Query = { table: string; operation: string; options: Row };
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
  'base64',
);
const rejects = (statusCode: number, reason: string) => (error: unknown) =>
  error instanceof SessionError && error.statusCode === statusCode && error.reason === reason;

/** 小型 Sequelize 替身：真实筛选/排序/投影、脱离原行的读取、串行事务及全表回滚。 */
function fixture() {
  const shareId = randomUUID();
  const input: ForkInput = {
    workspaceId: 'target-workspace',
    credentialId: 'own-figma',
    clientRequestId: randomUUID(),
  };
  const tables: Record<string, Row[]> = {
    D2cSessionShare: [{ shareId, sessionId: 'source-session', enabled: true }],
    D2cWorkspace: [
      { workspaceId: 'source-workspace', createdUserId: 'author', teamId: null },
      {
        workspaceId: input.workspaceId,
        createdUserId: 'viewer',
        teamId: null,
        status: 'ready',
        activeResourceRevisionId: 'own-resources',
        configJson: { private: 'TARGET_CONFIG' },
      },
    ],
    D2cSession: [
      {
        sessionId: 'source-session',
        workspaceId: 'source-workspace',
        createdUserId: 'author',
        name: '公开作品',
        target: 'h5',
        fileRevision: 7,
        timelineSeq: 9,
        activeRunId: 'source-run',
        credentialId: 'author-figma',
        modelCredentialId: 'author-model',
        figmaUrl: 'https://figma.com/design/private-source',
        contextSummary: 'PRIVATE_SUMMARY',
        summaryThroughSeq: 8,
        validationState: { status: 'passed' },
      },
    ],
    D2cCredential: [
      {
        credentialId: input.credentialId,
        ownerUserId: 'viewer',
        kind: 'figma',
        status: 'active',
        encryptedValue: 'FAKE_CREDENTIAL_MARKER',
      },
    ],
    D2cTeam: [{ teamId: 'team' }],
    D2cTeamMember: [{ teamId: 'team', userId: 'viewer' }],
    D2cFile: [],
    D2cTimeline: [],
    D2cMessageAttachment: [],
    D2cRun: [{ sessionId: 'source-session', runId: 'source-run', state: 'PRIVATE_RUN' }],
    D2cCheckpoint: [{ sessionId: 'source-session', state: 'PRIVATE_CHECKPOINT' }],
  };
  const personalModelCredential = async (userId: string) => {
    assert.equal(userId, 'viewer');
    return 'own-model';
  };
  const queries: Query[] = [];
  const writes: Query[] = [];
  let beforeTransaction: (() => void) | undefined;
  let failWrite: string | undefined;
  let tail = Promise.resolve();
  const transactions = new Set<Row>();

  function match(row: Row, where: Row = {}): boolean {
    return Reflect.ownKeys(where).every((key) => {
      const value = where[key as string];
      if (key === Op.and) return value.every((part: Row) => match(row, part));
      if (key === Op.or) return value.some((part: Row) => match(row, part));
      assert.equal(typeof key, 'string', 'unsupported where operator');
      const actual = String(key)
        .split('.')
        .reduce((current, part) => current?.[part], row);
      if (value && typeof value === 'object')
        return Reflect.ownKeys(value).every((operator) => {
          if (operator === Op.in) return value[operator].includes(actual);
          if (operator === Op.gt) return actual > value[operator];
          if (operator === Op.lte) return actual <= value[operator];
          throw new Error(`unsupported predicate: ${String(operator)}`);
        });
      return actual === value;
    });
  }
  function select(table: string, options: Row): Row[] {
    const rows = tables[table].filter((row) => !row.deletedAt && match(row, options.where));
    for (const [key, direction] of [...(options.order ?? [])].reverse())
      rows.sort(
        (a, b) =>
          (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (direction === 'DESC' ? -1 : 1),
      );
    return rows
      .slice(
        options.offset ?? 0,
        options.limit === undefined ? undefined : (options.offset ?? 0) + options.limit,
      )
      .map((row) => {
        const attrs = options.attributes;
        if (Array.isArray(attrs))
          return structuredClone(Object.fromEntries(attrs.map((key) => [key, row[key]])));
        return structuredClone(
          Object.fromEntries(Object.entries(row).filter(([key]) => !attrs?.exclude?.includes(key))),
        );
      });
  }
  function insert(table: string, values: Row[], options: Row) {
    assert.ok(transactions.has(options.transaction), `${table} write must be transactional`);
    writes.push({ table, operation: 'insert', options });
    for (const value of values) {
      const unique =
        table === 'D2cSession'
          ? 'sessionId'
          : table === 'D2cFile'
            ? 'fileId'
            : table === 'D2cTimeline'
              ? 'entryId'
              : 'attachmentId';
      assert.ok(!tables[table].some((row) => row[unique] === value[unique]), `duplicate ${unique}`);
      tables[table].push(structuredClone(value));
    }
    // Throw after mutation, so the test exercises rollback rather than pre-write validation.
    if (failWrite === table) throw new Error(`injected ${table} write failure`);
    return structuredClone(values);
  }
  const models = Object.fromEntries(
    Object.keys(tables).map((table) => [
      table,
      {
        async findOne(options: Row) {
          queries.push({ table, operation: 'findOne', options });
          return select(table, { ...options, limit: 1 })[0] ?? null;
        },
        async findAll(options: Row) {
          queries.push({ table, operation: 'findAll', options });
          return select(table, options);
        },
        async create(value: Row, options: Row) {
          return insert(table, [value], options)[0];
        },
        async bulkCreate(values: Row[], options: Row) {
          return insert(table, values, options);
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
      beforeTransaction?.();
      const snapshot = structuredClone(tables);
      const tx = { LOCK: { UPDATE: 'UPDATE' } };
      transactions.add(tx);
      try {
        return await callback(tx);
      } catch (error) {
        for (const key of Object.keys(tables)) tables[key] = snapshot[key];
        throw error;
      } finally {
        transactions.delete(tx);
        release();
      }
    },
  } as unknown as Sequelize;
  function file(
    path = 'src/App.tsx',
    content: string | null = 'export default "你好";',
    kind = 'source',
  ) {
    const data = content === null ? png : content;
    const row = {
      fileId: randomUUID(),
      sessionId: 'source-session',
      path,
      pathHash: sha(path),
      kind,
      content,
      objectLocator: content === null ? { provider: 'memory', key: 'image' } : null,
      size: Buffer.byteLength(data),
      sha256: sha(data),
      mimeType: content === null ? 'image/png' : 'text/plain',
      revision: 7,
    };
    tables.D2cFile.push(row);
    return row;
  }
  function message(seq: number, text: string, extra: Row = {}) {
    const row = {
      entryId: `source-entry-${seq}`,
      messageId: `source-message-${seq}`,
      sessionId: 'source-session',
      seq,
      kind: 'message',
      completed: true,
      displayPayload: { role: seq === 1 ? 'user' : 'assistant', text },
      sdkItem: { type: 'tool_call', content: 'PRIVATE_SDK_HISTORY' },
      ...extra,
    };
    tables.D2cTimeline.push(row);
    return row;
  }
  function attachment() {
    const row = {
      attachmentId: 'source-image',
      sessionId: 'source-session',
      userId: 'author',
      messageId: 'source-message-1',
      mimeType: 'image/png',
      width: 1,
      height: 1,
      size: png.length,
      sha256: sha(png),
      fileName: 'image.png',
      expiresAt: null,
      objectLocator: { provider: 'memory', key: 'attachment' },
    };
    tables.D2cMessageAttachment.push(row);
    const ref = {
      attachmentId: row.attachmentId,
      url: `/api/d2c/sessions/source-session/attachments/${row.attachmentId}`,
      mimeType: row.mimeType,
      width: row.width,
      height: row.height,
      size: row.size,
    };
    message(1, `公开图片 ${ref.url}`, {
      displayPayload: { role: 'user', text: '公开图片', attachments: [ref] },
    });
    return { row, ref };
  }
  return {
    mysql,
    tables,
    queries,
    writes,
    input,
    shareId,
    file,
    message,
    attachment,
    fork: (patch: Partial<ForkInput> = {}) =>
      forkPublishedSession(
        mysql,
        'viewer',
        shareId,
        { ...input, ...patch },
        { personalModelCredential },
      ),
    beforeTransaction: (fn: () => void) => {
      beforeTransaction = fn;
    },
    failWrite: (table?: string) => {
      failWrite = table;
    },
  };
}

/** 实际 fork ID 必须被正式执行检查点接受，复制历史须能接入下一条用户消息。 */
test('fork session ID and imported history work with execution checkpoint and SDK replay', async () => {
  const f = fixture();
  f.attachment();
  f.message(2, '原始公开助手正文');
  const result = await f.fork();
  assert.equal((await f.fork()).sessionId, result.sessionId);

  const mysql = new Sequelize('offline', 'offline', '', { dialect: 'mysql', logging: false });
  initD2cAgentCheckpoint(mysql);
  initD2cAgentWrite(mysql);
  try {
    const checkpoint = createRunCheckpointSaver(
      mysql,
      {
        commit: async () => assert.fail('构造检查点和转换历史不应执行数据库写入'),
      },
      { sessionId: result.sessionId, runId: randomUUID(), owner: 'offline-worker' },
    );
    assert.equal(checkpoint.config().configurable?.thread_id, `d2c:${result.sessionId}`);

    const copied = f.tables.D2cTimeline.filter((row) => row.sessionId === result.sessionId).map(
      (row) => ({ completed: row.completed === true, sdkItem: row.sdkItem ?? null }),
    );
    const content = '请继续讨论，不要生成代码';
    const next = {
      completed: true,
      kind: 'message',
      messageId: randomUUID(),
      sdkItem: { type: 'message', role: 'user', content, status: 'completed' },
    };
    const history = replayHistory([...copied, next]);
    const messages = storedHistoryToMessages(history);
    assert.deepEqual(
      messages.map((message) => message.type),
      ['ai', 'human', 'ai', 'human'],
    );
    assert.equal(messages[2].text, '原始公开助手正文');
    assert.equal(messages.at(-1)!.text, content);
    const last = history.at(-1);
    assert.ok(last && 'role' in last && last.role === 'user');
    assert.equal(last.content, content);
    const attachment = f.tables.D2cMessageAttachment.find(
      (row) => row.sessionId === result.sessionId,
    )!;
    assert.ok(Array.isArray(messages[1].content));
    assert.match(
      JSON.stringify(messages[1].content),
      new RegExp(`attachment://${attachment.attachmentId}`),
    );
    assert.doesNotMatch(JSON.stringify(history), /source-image|PRIVATE_SDK_HISTORY/);
  } finally {
    await mysql.close();
  }
});

test('fork requires login and a personal ready workspace; other owners and accessible teams are rejected', async (t) => {
  for (const [label, patch, status, reason] of [
    ['other owner', { createdUserId: 'stranger' }, 404, 'WORKSPACE_NOT_FOUND'],
    ['own team', { teamId: 'team' }, 403, 'PERSONAL_WORKSPACE_REQUIRED'],
    [
      'team member',
      { createdUserId: 'stranger', teamId: 'team' },
      403,
      'PERSONAL_WORKSPACE_REQUIRED',
    ],
    ['not ready', { status: 'building' }, 409, 'WORKSPACE_NOT_READY'],
    ['no resources', { activeResourceRevisionId: null }, 409, 'WORKSPACE_NOT_READY'],
  ] as const)
    await t.test(label, async () => {
      const f = fixture();
      Object.assign(f.tables.D2cWorkspace[1], patch);
      await assert.rejects(f.fork(), rejects(status, reason));
      assert.equal(f.writes.length, 0);
    });
  const f = fixture();
  await assert.rejects(
    forkPublishedSession(f.mysql, '', f.shareId, f.input),
    rejects(401, 'LOGIN_REQUIRED'),
  );
  assert.equal(f.queries.length, 0);
});

test('fork accepts only the current user active Figma credential, including a final transaction recheck', async (t) => {
  for (const patch of [{ ownerUserId: 'author' }, { status: 'disabled' }, { kind: 'model' }])
    await t.test(JSON.stringify(patch), async () => {
      const f = fixture();
      Object.assign(f.tables.D2cCredential[0], patch);
      await assert.rejects(f.fork(), rejects(422, 'CREDENTIAL_UNAVAILABLE'));
      assert.equal(f.writes.length, 0);
    });
  const f = fixture();
  f.file();
  f.beforeTransaction(() => {
    f.tables.D2cCredential[0].status = 'disabled';
  });
  await assert.rejects(f.fork(), rejects(422, 'CREDENTIAL_UNAVAILABLE'));
  assert.equal(f.tables.D2cSession.length, 1);
  assert.equal(f.writes.length, 0);
});

test('public fork rejects missing model resolver or an unconfigured personal model without writes', async (t) => {
  for (const entry of ['direct', 'sharing'] as const)
    await t.test(entry, async () => {
      const f = fixture();
      f.file();
      f.attachment();
      const before = structuredClone(f.tables);
      const call =
        entry === 'direct'
          ? () => forkPublishedSession(f.mysql, 'viewer', f.shareId, f.input)
          : () =>
              createSharingService(f.mysql, {
                binary: () => {
                  throw new Error('must not access binary storage');
                },
              }).fork('viewer', f.shareId, f.input);
      await assert.rejects(call(), rejects(503, 'MODEL_CREDENTIAL_UNAVAILABLE'));
      assert.deepEqual(f.tables, before);
      assert.equal(f.writes.length, 0);
    });
  const f = fixture();
  f.file();
  const callers: string[] = [];
  await assert.rejects(
    forkPublishedSession(f.mysql, 'viewer', f.shareId, f.input, {
      personalModelCredential: async (userId) => {
        callers.push(userId);
        throw new SessionError(422, 'MODEL_CREDENTIAL_UNAVAILABLE', '请配置本人的模型');
      },
    }),
    rejects(422, 'MODEL_CREDENTIAL_UNAVAILABLE'),
  );
  assert.deepEqual(callers, ['viewer']);
  assert.equal(f.tables.D2cSession.length, 1);
  assert.equal(f.writes.length, 0);
});

test('public sharing fork binds only the caller model credential and preserves sameUser ownership rules', async () => {
  const f = fixture();
  f.file();
  f.tables.D2cWorkspace[1].createdUserId = ' VIEWER ';
  assert.equal(sameUser(f.tables.D2cWorkspace[1].createdUserId, 'viewer'), true);
  f.tables.D2cCredential.push(
    {
      credentialId: 'author-model',
      ownerUserId: 'author',
      kind: 'model',
      status: 'active',
      ciphertext: 'PRIVATE_AUTHOR_MODEL_SECRET',
    },
    {
      credentialId: 'own-model',
      ownerUserId: 'viewer',
      kind: 'model',
      status: 'active',
      ciphertext: 'PRIVATE_VIEWER_MODEL_SECRET',
    },
  );
  const before = structuredClone(f.tables.D2cCredential);
  const callers: string[] = [];
  const service = createSharingService(f.mysql, {
    binary: () => {
      throw new Error('must not access binary storage');
    },
    personalModelCredential: async (userId) => {
      callers.push(userId);
      const credential = (await f.mysql.models.D2cCredential.findOne({
        where: { ownerUserId: userId, kind: 'model', status: 'active' },
        attributes: ['credentialId'],
      })) as unknown as Row | null;
      if (!credential) throw new SessionError(422, 'MODEL_CREDENTIAL_UNAVAILABLE', '模型未配置');
      return credential.credentialId as string;
    },
  });
  const result = await service.fork('viewer', f.shareId, f.input, 'Viewer');
  const session = f.tables.D2cSession.find((row) => row.sessionId === result.sessionId)!;
  assert.deepEqual(callers, ['viewer']);
  assert.equal(session.createdUserId, 'viewer');
  assert.equal(session.credentialId, 'own-figma');
  assert.equal(session.modelCredentialId, 'own-model');
  assert.equal(session.activeRunId, null);
  assert.deepEqual(f.tables.D2cCredential, before);
  assert.equal(f.tables.D2cRun.length, 1);
  assert.doesNotMatch(JSON.stringify(session), /author-model|PRIVATE_.*_MODEL_SECRET/);
});

test('fork copies public completed messages and artifacts with new IDs, provenance and idle state only', async () => {
  const f = fixture();
  const sourceFile = f.file();
  const image = f.file('assets/picture.png', null, 'asset');
  for (const path of [
    '.d2c-cache/state.json',
    'node_modules/pkg/index.js',
    'SKILL.md',
    'pp-d2c.config.json',
  ])
    f.file(path);
  f.file('private-state.json', 'PRIVATE_INTERNAL', 'internal');
  f.message(6, '回答', {
    displayPayload: { role: 'assistant', text: '回答', secret: 'PRIVATE_DISPLAY' },
  });
  f.message(
    1,
    `https://www.figma.com/design/public-node?node-id=1-2\n/api/d2c/sessions/source-session/files/${sourceFile.fileId}`,
  );
  f.message(2, 'PRIVATE_TOOL', { kind: 'tool' });
  f.message(3, 'PRIVATE_STAGE', { kind: 'stage' });
  f.message(4, 'PRIVATE_DRAFT', { completed: false });
  f.message(5, 'PRIVATE_REASONING', { kind: 'reasoning_delta' });
  f.message(10, 'AFTER_SNAPSHOT');
  const before = structuredClone(f.tables);
  const modelRequests: string[] = [];
  const result = await forkPublishedSession(
    f.mysql,
    'viewer',
    f.shareId,
    { ...f.input, name: '  我的分支  ' },
    {
      personalModelCredential: async (userId) => {
        modelRequests.push(userId);
        return 'own-model';
      },
    },
    ' Viewer ',
  );
  const session = f.tables.D2cSession.find((row) => row.sessionId === result.sessionId)!;
  assert.equal(session.workspaceId, f.input.workspaceId);
  assert.equal(session.createdUserId, 'viewer');
  assert.equal(session.creatorName, 'Viewer');
  assert.equal(session.name, '我的分支');
  assert.equal(session.target, 'h5');
  assert.equal(session.credentialId, 'own-figma');
  assert.equal(session.modelCredentialId, 'own-model');
  assert.equal(session.figmaUrl, 'https://www.figma.com/design/public-node?node-id=1-2');
  assert.equal(session.activeRunId, null);
  assert.equal(session.contextSummary, null);
  assert.equal(session.summaryThroughSeq, 0);
  assert.equal(session.fileRevision, 1);
  assert.deepEqual(session.validationState, { status: 'not_checked' });
  assert.deepEqual(modelRequests, ['viewer']);
  const copiedFiles = f.tables.D2cFile.filter((row) => row.sessionId === result.sessionId);
  assert.deepEqual(copiedFiles.map((row) => row.path).sort(), [
    'assets/picture.png',
    'src/App.tsx',
  ]);
  for (const row of copiedFiles) {
    const original = [sourceFile, image].find((file) => file.path === row.path)!;
    assert.notEqual(row.fileId, original.fileId);
    assert.equal(row.revision, 1);
    assert.equal(row.sha256, original.sha256);
    assert.equal(row.size, original.size);
    assert.deepEqual(row.objectLocator, original.objectLocator);
  }
  const entries = f.tables.D2cTimeline.filter((row) => row.sessionId === result.sessionId);
  assert.equal(session.timelineSeq, 3);
  assert.deepEqual(
    entries.map((row) => row.seq),
    [1, 2, 3],
  );
  assert.match(entries[0].displayPayload.text, new RegExp(`/plaza/${f.shareId}`));
  assert.match(entries[0].displayPayload.text, /公开作品.*r7.*9/s);
  const newFile = copiedFiles.find((row) => row.path === sourceFile.path)!;
  assert.match(
    entries[1].displayPayload.text,
    new RegExp(`/sessions/${result.sessionId}/files/${newFile.fileId}`),
  );
  assert.equal(entries[2].displayPayload.text, '回答');
  for (const entry of entries) {
    assert.equal(entry.runId, null);
    assert.equal(entry.kind, 'message');
    assert.equal(entry.sdkItem.type, 'message');
    assert.equal(entry.toolCallId, null);
    assert.ok(!before.D2cTimeline.some((row) => row.messageId === entry.messageId));
  }
  assert.doesNotMatch(
    JSON.stringify({ session, entries, copiedFiles }),
    /PRIVATE_|FAKE_CREDENTIAL_MARKER|author-figma|author-model|AFTER_SNAPSHOT/,
  );
  assert.deepEqual(f.tables.D2cRun, before.D2cRun);
  assert.deepEqual(f.tables.D2cCheckpoint, before.D2cCheckpoint);
  assert.deepEqual(f.tables.D2cSession[0], before.D2cSession[0]);
  assert.deepEqual(f.tables.D2cWorkspace, before.D2cWorkspace);
  // Ordered reads must sort scalar heads, then read payloads without filesort or SDK history.
  const reads = f.queries.filter((q) => q.table === 'D2cTimeline');
  assert.ok(reads.some((q) => q.options.order));
  for (const { options } of reads) {
    assert.ok(Array.isArray(options.attributes));
    assert.ok(!options.attributes.includes('sdkItem'));
    if (options.order) assert.deepEqual(options.attributes, ['seq']);
    else assert.equal(options.limit, undefined);
  }
  const workspaceLocks = f.queries.filter(
    (query) =>
      query.table === 'D2cWorkspace' && query.operation === 'findAll' && query.options.lock,
  );
  assert.ok(workspaceLocks.length > 0);
  for (const { options } of workspaceLocks) {
    assert.deepEqual(options.attributes, ['workspaceId']);
    assert.deepEqual(options.order, [['workspaceId', 'ASC']]);
  }
});

test('a published image reused in user and assistant messages is copied once with new scoped references', async () => {
  const f = fixture();
  const { row: original, ref } = f.attachment();
  f.message(6, '复用已公开图片', {
    displayPayload: { role: 'assistant', text: ref.url, attachments: [ref] },
  });
  f.tables.D2cMessageAttachment.push({
    ...original,
    attachmentId: 'unsent-image',
    messageId: null,
    expiresAt: new Date(),
  });
  const result = await f.fork();
  const copies = f.tables.D2cMessageAttachment.filter((row) => row.sessionId === result.sessionId);
  assert.equal(copies.length, 1);
  const entries = f.tables.D2cTimeline.filter((row) => row.sessionId === result.sessionId);
  const url = `/api/d2c/sessions/${result.sessionId}/attachments/${copies[0].attachmentId}`;
  for (const entry of entries.slice(1)) {
    assert.equal(entry.displayPayload.attachments[0].attachmentId, copies[0].attachmentId);
    assert.equal(entry.displayPayload.attachments[0].url, url);
  }
  assert.equal(entries[2].displayPayload.text, url);
  assert.deepEqual(entries[1].sdkItem.content, [
    { type: 'input_text', text: '公开图片' },
    { type: 'input_image', attachmentId: copies[0].attachmentId },
  ]);
  assert.equal(copies[0].messageId, entries[1].messageId);
  assert.doesNotMatch(JSON.stringify(entries), /source-image|unsent-image|PRIVATE_SDK_HISTORY/);
});

test('draft, missing or corrupt published attachments fail the entire fork', async (t) => {
  for (const [label, patch] of [
    ['draft', { messageId: null }],
    ['not in published messages', { messageId: 'unpublished-message' }],
    ['expiring', { expiresAt: new Date() }],
    ['wrong size', { size: png.length + 1 }],
    ['wrong dimensions', { width: 2 }],
    ['no object', { objectLocator: null }],
  ] as const)
    await t.test(label, async () => {
      const f = fixture();
      f.file();
      Object.assign(f.attachment().row, patch);
      await assert.rejects(f.fork(), rejects(503, 'ATTACHMENT_CORRUPT'));
      assert.equal(f.tables.D2cSession.length, 1);
      assert.equal(f.writes.length, 0);
    });
});

test('fork checks current UTF-8 size, content hash and path hash before creating any session', async (t) => {
  for (const [label, patch] of [
    ['stale content', { content: 'different' }],
    ['wrong hash', { sha256: sha('different') }],
    ['character size', { size: '你好'.length }],
    ['negative size', { size: -1 }],
    ['wrong path hash', { pathHash: sha('wrong-path') }],
    ['invalid hash', { sha256: 'invalid' }],
  ] as const)
    await t.test(label, async () => {
      const f = fixture();
      Object.assign(f.file('src/a.ts', '你好'), patch);
      await assert.rejects(f.fork(), rejects(503, 'FILE_CORRUPT'));
      assert.equal(f.tables.D2cSession.length, 1);
      assert.equal(f.writes.length, 0);
    });
});

test('UUID retry is idempotent sequentially and concurrently; new UUID makes an independent fork', async () => {
  const f = fixture();
  f.file();
  f.message(1, '公开正文');
  const [a, b] = await Promise.all([f.fork(), f.fork()]);
  assert.deepEqual(a, b);
  assert.equal(f.tables.D2cSession.length, 2);
  const after = structuredClone(f.tables);
  f.tables.D2cSessionShare[0].enabled = false;
  f.tables.D2cCredential[0].status = 'disabled';
  assert.deepEqual(await f.fork(), a);
  assert.deepEqual(f.tables.D2cFile, after.D2cFile);
  assert.deepEqual(f.tables.D2cTimeline, after.D2cTimeline);
  assert.equal(f.tables.D2cSession.length, 2);
  f.tables.D2cSessionShare[0].enabled = true;
  f.tables.D2cCredential[0].status = 'active';
  const c = await f.fork({ clientRequestId: randomUUID() });
  assert.notEqual(c.sessionId, a.sessionId);
  assert.equal(f.tables.D2cSession.length, 3);
  await assert.rejects(f.fork({ clientRequestId: 'not-a-uuid' }), rejects(422, 'INVALID_INPUT'));
});

test('withdrawal, source revision and target ownership changes during preparation fail without orphan rows', async (t) => {
  for (const [label, mutate, status, reason] of [
    [
      'withdrawn',
      (f: ReturnType<typeof fixture>) => {
        f.tables.D2cSessionShare[0].enabled = false;
      },
      404,
      'SHARE_NOT_FOUND',
    ],
    [
      'revision',
      (f: ReturnType<typeof fixture>) => {
        f.tables.D2cSession[0].fileRevision++;
      },
      409,
      'SOURCE_CHANGED',
    ],
    [
      'deleted source',
      (f: ReturnType<typeof fixture>) => {
        f.tables.D2cSession[0].deletedAt = new Date();
      },
      404,
      'SHARE_NOT_FOUND',
    ],
    [
      'target reassigned',
      (f: ReturnType<typeof fixture>) => {
        f.tables.D2cWorkspace[1].createdUserId = 'someone';
      },
      404,
      'WORKSPACE_NOT_FOUND',
    ],
  ] as const)
    await t.test(label, async () => {
      const f = fixture();
      f.file();
      f.attachment();
      f.beforeTransaction(() => mutate(f));
      await assert.rejects(f.fork(), rejects(status, reason));
      assert.equal(f.tables.D2cSession.length, 1);
      for (const table of ['D2cFile', 'D2cTimeline', 'D2cMessageAttachment'])
        assert.ok(f.tables[table].every((row) => row.sessionId === 'source-session'));
      assert.equal(f.writes.length, 0);
    });
});

test('failures after each write roll back session, files, attachments and messages; same UUID can retry', async (t) => {
  for (const table of ['D2cSession', 'D2cFile', 'D2cMessageAttachment', 'D2cTimeline'])
    await t.test(table, async () => {
      const f = fixture();
      f.file();
      f.attachment();
      const before = structuredClone(f.tables);
      f.failWrite(table);
      await assert.rejects(f.fork(), new RegExp(`injected ${table} write failure`));
      assert.deepEqual(f.tables, before);
      assert.ok(f.writes.some((write) => write.table === table));
      f.failWrite();
      await f.fork();
      assert.equal(f.tables.D2cSession.length, 2);
    });
});

test('external text is rebound to the new scope and private file/attachment reads survive source withdrawal', async () => {
  const f = fixture();
  const memory = enableTextContent(f.mysql);
  const sourceFile: Row = f.file();
  const text = sourceFile.content;
  Object.assign(sourceFile, await prepareTextContent(f.mysql, 'session:source-session', text));
  const { row: originalAttachment } = f.attachment();
  const result = await createSharingService(f.mysql, {
    binary: () => {
      throw new Error('fork must reuse immutable image locators without remote downloads');
    },
    personalModelCredential: async (userId) => {
      assert.equal(userId, 'viewer');
      return 'own-model';
    },
  }).fork('viewer', f.shareId, f.input, 'Viewer');
  const copy = f.tables.D2cFile.find((row) => row.sessionId === result.sessionId)!;
  const attachment = f.tables.D2cMessageAttachment.find(
    (row) => row.sessionId === result.sessionId,
  )!;
  assert.equal(copy.content, null);
  assert.ok(copy.contentRef);
  assert.notDeepEqual(copy.contentRef, sourceFile.contentRef);
  assert.equal(await resolveTextContent(f.mysql, copy, `session:${result.sessionId}`), text);
  await assert.rejects(resolveTextContent(f.mysql, copy, 'session:source-session'), {
    code: 'INVALID_REFERENCE',
  });
  assert.notEqual(attachment.attachmentId, originalAttachment.attachmentId);
  assert.equal(attachment.userId, 'viewer');
  assert.equal(attachment.expiresAt, null);
  assert.deepEqual(attachment.objectLocator, originalAttachment.objectLocator);
  const message = f.tables.D2cTimeline.find((row) => row.messageId === attachment.messageId)!;
  assert.equal(
    message.displayPayload.attachments[0].url,
    `/api/d2c/sessions/${result.sessionId}/attachments/${attachment.attachmentId}`,
  );
  f.tables.D2cSessionShare[0].enabled = false;
  f.tables.D2cSession[0].deletedAt = new Date();
  f.tables.D2cWorkspace[0].deletedAt = new Date();
  f.tables.D2cFile = f.tables.D2cFile.filter((row) => row.sessionId !== 'source-session');
  f.tables.D2cMessageAttachment = f.tables.D2cMessageAttachment.filter(
    (row) => row.sessionId !== 'source-session',
  );
  // Removing the old encrypted body proves the copy does not retain a source-scope reference.
  const reference = sourceFile.contentRef as { locator: { key: string } };
  assert.equal(memory.objects.delete(reference.locator.key), true);
  const files = createFileService(f.mysql, () => undefined);
  assert.equal((await files.get('viewer', result.sessionId, copy.fileId)).content, text);
  let downloads = 0;
  const attachments = createAttachmentService(f.mysql, {
    readUploadBytes: () => 10 * 1024 * 1024,
    binary: {
      async downloadFile(locator: unknown) {
        downloads++;
        assert.deepEqual(locator, originalAttachment.objectLocator);
        return png;
      },
    } as Parameters<typeof createAttachmentService>[1]['binary'],
  });
  assert.deepEqual(
    (await attachments.read('viewer', result.sessionId, attachment.attachmentId)).data,
    png,
  );
  assert.equal(downloads, 1);
  await assert.rejects(
    files.get('stranger', result.sessionId, copy.fileId),
    rejects(404, 'WORKSPACE_NOT_FOUND'),
  );
  await assert.rejects(
    attachments.read('stranger', result.sessionId, attachment.attachmentId),
    rejects(404, 'WORKSPACE_NOT_FOUND'),
  );
  assert.equal(downloads, 1);
});
