import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import { Sequelize } from 'sequelize';
import { createSharingService } from '../src/functions/d2c/sharing/service';
import sharingRoutes from '../src/functions/d2c/sharing/routes';
import { SessionError } from '../src/functions/d2c/session/access';
import { updateModelUsage } from '../src/functions/d2c/run/agent/usage';

const shareId = '12345678-1234-4234-8234-123456789abc';
type Row = Record<string, any>;
const rejects = (reason: string) => (error: unknown) =>
  error instanceof SessionError && error.reason === reason;

/** 独立数据库替身严格执行会话过滤和列投影，私有查询立即失败。 */
function fixture() {
  const tables: Record<string, Row[]> = {
    D2cSessionShare: [{ shareId, sessionId: 'source', enabled: true }],
    D2cSession: [{ sessionId: 'source', workspaceId: 'workspace', createdUserId: 'owner' }],
    D2cWorkspace: [{ workspaceId: 'workspace', createdUserId: 'owner' }],
    D2cFile: [],
    D2cRun: [],
    D2cTimeline: [],
  };
  const queries: Array<{ table: string; options: Row }> = [];
  let afterRuns: (() => void) | undefined;
  const models = Object.fromEntries(
    Object.keys(tables).map((table) => {
      const read = (options: Row) => {
        queries.push({ table, options });
        const result = tables[table]
          .filter(
            (row) =>
              !row.deletedAt &&
              Object.entries(options.where).every(([key, value]) => row[key] === value),
          )
          .map((row) =>
            options.attributes
              ? Object.fromEntries(
                  options.attributes.map((attribute: string | unknown[]) => {
                    if (typeof attribute === 'string') return [attribute, row[attribute]];
                    assert.equal(table, 'D2cTimeline');
                    assert.equal(attribute[1], 'status');
                    assert.match(
                      JSON.stringify(attribute[0]),
                      /JSON_UNQUOTE.*JSON_EXTRACT.*displayPayload.*\$\.status/,
                    );
                    return ['status', row.displayPayload?.status];
                  }),
                )
              : { ...row },
          );
        if (table === 'D2cRun') afterRuns?.();
        return result;
      };
      return [
        table,
        {
          findOne: async (options: Row) => read(options)[0] ?? null,
          findAll: async (options: Row) => read(options),
        },
      ];
    }),
  );
  const service = createSharingService({ models } as unknown as Sequelize, {
    binary: () => {
      throw new Error('usage must not load storage');
    },
  });
  return {
    tables,
    queries,
    service,
    afterRuns: (fn: () => void) => {
      afterRuns = fn;
    },
  };
}

/** 持久化聚合包含主/子/摘要请求，不应与 model_status 再次相加。 */
function usage() {
  let value: Record<string, unknown> | null = null;
  for (const scope of ['generation', 'design', 'summary'] as const) {
    value = updateModelUsage(value, { operationId: scope, scope, status: 'started' });
    value = updateModelUsage(value, {
      operationId: scope,
      scope,
      status: 'completed',
      tokenUsage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
  }
  return { ...value, privateContext: 'SECRET' };
}

/** 统一轮次时间，令终态 updatedAt 包含空闲时间以检验首个结束事件。 */
function run(runId: string, extra: Row = {}) {
  return {
    runId,
    sessionId: 'source',
    status: 'succeeded',
    usage: usage(),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:30Z'),
    modelSnapshot: { SECRET: true },
    error: { SECRET: true },
    checkpoint: 'SECRET',
    ...extra,
  };
}

test('published usage aggregates all runs and main/sub/summary once, with a strict safe whitelist', async () => {
  const f = fixture();
  f.tables.D2cRun.push(
    ...Array.from({ length: 12 }, (_, i) => run(`run-${i}`)),
    run('foreign', { sessionId: 'private-other' }),
  );
  f.tables.D2cTimeline.push(
    {
      sessionId: 'source',
      runId: 'run-0',
      kind: 'run_status',
      createdAt: new Date('2026-01-01T00:00:02Z'),
      displayPayload: { status: 'failed', SECRET: true },
    },
    {
      sessionId: 'source',
      runId: 'run-0',
      kind: 'run_status',
      createdAt: new Date('2026-01-01T00:00:01Z'),
      displayPayload: { status: 'succeeded' },
    },
    {
      sessionId: 'source',
      runId: 'run-0',
      kind: 'model_status',
      displayPayload: { tokenUsage: { total_tokens: 999999 } },
    },
    {
      sessionId: 'private-other',
      runId: 'run-1',
      kind: 'run_status',
      createdAt: new Date('2026-01-01T00:00:01Z'),
      displayPayload: { status: 'failed' },
    },
  );
  const result = await f.service.usage('viewer', shareId);
  assert.deepEqual(Object.keys(result).sort(), ['observedAt', 'sessionElapsedMs', 'usage']);
  assert.deepEqual(result.usage, {
    requests: 36,
    reportedRequests: 36,
    completedRequests: 36,
    failedRequests: 0,
    interruptedRequests: 0,
    pendingRequests: 0,
    unreportedRequests: 0,
    usageComplete: true,
    inputTokens: 360,
    outputTokens: 180,
    totalTokens: 540,
  });
  assert.equal(result.sessionElapsedMs, 331000);
  assert.ok(Number.isFinite(Date.parse(result.observedAt)));
  assert.doesNotMatch(JSON.stringify(result), /SECRET|model|checkpoint|runId|failure|config/);
  const query = f.queries.find((query) => query.table === 'D2cRun')!;
  assert.deepEqual(query.options.attributes, [
    'runId',
    'status',
    'usage',
    'createdAt',
    'updatedAt',
  ]);
  assert.equal(query.options.limit, undefined);
  assert.equal(f.queries.filter((query) => query.table === 'D2cTimeline').length, 1);
  assert.ok(f.queries.every((query) => !query.options.attributes?.includes('displayPayload')));
});

test('missing, partial and malformed usage stay unknown; tokens only sum reported requests', async () => {
  const f = fixture();
  f.tables.D2cRun.push(
    run('reported'),
    run('unreported', {
      usage: {
        requests: 1,
        reportedRequests: 0,
        completedRequests: 0,
        failedRequests: 1,
        interruptedRequests: 0,
        pendingRequests: 0,
        unreportedRequests: 1,
        usageComplete: false,
        totalTokens: 999999,
      },
    }),
  );
  let result = await f.service.usage('viewer', shareId);
  assert.equal(result.usage.totalTokens, 45);
  assert.equal(result.usage.usageComplete, false);
  assert.equal(result.usage.requests, 4);
  f.tables.D2cRun.push(run('legacy', { usage: null }));
  result = await f.service.usage('viewer', shareId);
  assert.equal(result.usage.requests, null);
  assert.equal(result.usage.totalTokens, 45);
  f.tables.D2cRun[0].usage.totalTokens = -1;
  assert.equal((await f.service.usage('viewer', shareId)).usage.totalTokens, null);
  f.tables.D2cRun[0].usage.requests = Number.MAX_SAFE_INTEGER;
  assert.equal((await f.service.usage('viewer', shareId)).usage.requests, null);
});

test('empty sessions have unknown usage and zero elapsed time; reported zero remains zero', async () => {
  const f = fixture();
  let result = await f.service.usage('viewer', shareId);
  assert.equal(result.sessionElapsedMs, 0);
  assert.ok(Object.values(result.usage).every((value) => value === null));
  f.tables.D2cRun.push(
    run('zero', { usage: { ...usage(), inputTokens: 0, outputTokens: 0, totalTokens: 0 } }),
  );
  result = await f.service.usage('viewer', shareId);
  assert.equal(result.usage.totalTokens, 0);
});

test('running time uses observedAt; paused time stops; invalid dates remain unknown', async () => {
  const f = fixture();
  const start = new Date(Date.now() - 1000);
  f.tables.D2cRun.push(run('live', { status: 'waiting_input', createdAt: start }));
  let result = await f.service.usage('viewer', shareId);
  assert.equal(result.sessionElapsedMs, Date.parse(result.observedAt) - start.getTime());
  f.tables.D2cRun[0] = run('paused', { status: 'paused' });
  assert.equal((await f.service.usage('viewer', shareId)).sessionElapsedMs, 30000);
  f.tables.D2cRun[0].createdAt = null;
  assert.equal((await f.service.usage('viewer', shareId)).sessionElapsedMs, null);
});

test('login, share token and publication authorize usage, never source ownership', async () => {
  const f = fixture();
  await assert.rejects(f.service.usage('', shareId), rejects('LOGIN_REQUIRED'));
  await assert.rejects(f.service.usage('owner', 'source'), rejects('INVALID_SHARE_ID'));
  assert.equal(f.queries.length, 0);
  f.tables.D2cSessionShare[0].enabled = false;
  await assert.rejects(f.service.usage('owner', shareId), rejects('SHARE_NOT_FOUND'));
  assert.ok(!f.queries.some((query) => query.table === 'D2cRun'));
  f.tables.D2cSessionShare[0].enabled = true;
  f.tables.D2cSessionShare[0].shareId = '87654321-1234-4234-8234-123456789abc';
  await assert.rejects(f.service.usage('viewer', shareId), rejects('SHARE_NOT_FOUND'));
});

test('withdrawal or soft deletion during aggregation blocks the in-flight response', async () => {
  for (const table of ['D2cSessionShare', 'D2cSession', 'D2cWorkspace']) {
    const f = fixture();
    f.afterRuns(() => {
      if (table === 'D2cSessionShare') f.tables[table][0].enabled = false;
      else f.tables[table][0].deletedAt = new Date();
    });
    await assert.rejects(f.service.usage('viewer', shareId), rejects('SHARE_NOT_FOUND'));
  }
});

test('HTTP usage contract inherits login, no-store and publication errors', async (t) => {
  const f = fixture();
  let eid = 'viewer';
  const app = Fastify();
  app.decorateRequest(
    'getUser',
    async () =>
      (eid ? { userId: eid, name: eid } : undefined) as unknown as Awaited<
        ReturnType<FastifyRequest['getUser']>
      >,
  );
  app.register(sharingRoutes, { prefix: '/api/d2c', sharing: async () => f.service });
  t.after(() => app.close());
  const url = `/api/d2c/plaza/sessions/${shareId}/usage`;
  let response = await app.inject(url);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.deepEqual(Object.keys(response.json().data).sort(), [
    'observedAt',
    'sessionElapsedMs',
    'usage',
  ]);
  eid = '';
  response = await app.inject(url);
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().data.reason, 'LOGIN_REQUIRED');
  eid = 'viewer';
  f.tables.D2cSessionShare[0].enabled = false;
  assert.equal((await app.inject(url)).statusCode, 404);
  assert.equal((await app.inject('/api/d2c/plaza/sessions/source/usage')).statusCode, 422);
});

/** Sequelize 的 fn 字符串参数会转义美元符号，必须检查真实生成 SQL。 */
test('用量状态查询生成合法 JSON 路径', async () => {
  const f = fixture();
  await f.service.usage('viewer', shareId);
  const options = f.queries.find((query) => query.table === 'D2cTimeline')!.options;
  const db = new Sequelize('test', 'test', 'test', { dialect: 'mysql', logging: false });
  try {
    const generator = db.getQueryInterface().queryGenerator as unknown as {
      selectQuery(table: string, options: unknown): string;
    };
    const sql = generator.selectQuery('d2c_timeline', options);
    assert.ok(sql.includes("JSON_EXTRACT(`displayPayload`, '$.status')"));
    assert.doesNotMatch(sql, /\$\$/);
  } finally {
    await db.close();
  }
});
