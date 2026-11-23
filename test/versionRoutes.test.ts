import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import sessionRoutes from '../src/functions/d2c/session';
import { createFileService } from '../src/functions/d2c/files/service';
import { createVersionService } from '../src/functions/d2c/version/service';
import { messageFixture } from './helpers/messages';
import { createHash, randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';

/** 用真实路由、业务事务与真实ZIP串联测试，只有外部数据库和存储使用替身。 */
async function fixture() {
  const f = await messageFixture();
  let eid = 'employee-a';
  const blobs = new Map<string, Buffer>();
  const versions = createVersionService(f.mysql, {
    readLimits: () => f.runtime.d2c.limits,
    notify: f.notifications.publish,
    binary: () => ({
      async uploadFile({ content, contentType }) {
        const fileName = randomUUID();
        blobs.set(fileName, Buffer.from(content));
        return {
          provider: 'local' as const,
          fileName,
          url: 'https://example.invalid/' + fileName,
          size: content.length,
          sha256: createHash('sha256').update(content).digest('hex'),
          mimeType: contentType,
        };
      },
      async downloadFile(locator) {
        return Buffer.from(blobs.get((locator as { fileName: string }).fileName)!);
      },
    }),
  });
  const files = createFileService(f.mysql, () => f.runtime.d2c.limits);
  const app = Fastify();
  app.decorateRequest(
    'getUser',
    async () =>
      (eid ? { userId: eid } : undefined) as unknown as Awaited<
        ReturnType<FastifyRequest['getUser']>
      >,
  );
  app.decorate(
    'clog',
    Object.assign(() => {}, { warn() {}, error() {}, info() {} }),
  );
  app.register(sessionRoutes, {
    prefix: '/api/d2c',
    worker: false,
    sessionService: f.sessions,
    fileService: files,
    messageService: f.messages,
    notifications: f.notifications,
    versionService: versions,
  });
  await app.ready();
  return {
    ...f,
    app,
    versions,
    setEid: (value: string) => {
      eid = value;
    },
  };
}

test('版本接口继承账号认证/同源/严格参数；保存并下载真实ZIP，不暴露定位和配置', async () => {
  const f = await fixture();
  try {
    const root = `/api/d2c/sessions/${f.id}`;
    const headers = { 'x-requested-with': 'PixelPrint' };
    const created = await f.app.inject({
      method: 'POST',
      url: root + '/files',
      headers,
      payload: {
        path: 'src/index.tsx',
        content: 'export default () => <main>hello</main>;',
        baseFileRevision: 0,
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const listing = await f.app.inject(root + '/files');
    const revision = listing.json().data.fileRevision;
    const input = { clientRequestId: 'snapshot-one', name: '首个草稿', baseFileRevision: revision };
    assert.equal(
      (await f.app.inject({ method: 'POST', url: root + '/versions', payload: input })).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: root + '/versions',
          headers,
          payload: { ...input, createdUserId: 'employee-b' },
        })
      ).statusCode,
      422,
    );
    const saved = await f.app.inject({
      method: 'POST',
      url: root + '/versions',
      headers,
      payload: input,
    });
    assert.equal(saved.statusCode, 202, saved.body);
    const version = saved.json().data;
    assert.equal(version.status, 'saving');
    await f.versions.drain();
    assert.equal(version.archiveObject, undefined);
    assert.equal(version.configSnapshot, undefined);
    const rows = await f.app.inject(root + '/versions');
    assert.equal(rows.json().data.total, 1);
    assert.equal(rows.headers['cache-control'], 'no-store');
    const events = (await f.app.inject(root + '/timeline?afterSeq=0&limit=200')).json().data;
    assert.ok(
      events.entries.some(
        (entry: { kind: string; data: { status: string } }) =>
          entry.kind === 'version_changed' && entry.data.status === 'ready',
      ),
    );
    const url = root + `/versions/${version.versionId}/archive`;
    const zip = await f.app.inject(url);
    assert.equal(zip.statusCode, 200, zip.body);
    assert.match(String(zip.headers['content-type']), /application\/zip/);
    assert.match(String(zip.headers['content-disposition']), /^attachment;/);
    assert.equal(
      Buffer.from(unzipSync(zip.rawPayload)['src/index.tsx']).toString(),
      'export default () => <main>hello</main>;',
    );
    f.setEid('employee-b');
    assert.equal((await f.app.inject(url)).statusCode, 404);
    assert.equal((await f.app.inject(root + '/versions')).statusCode, 404);
    f.setEid('');
    assert.equal((await f.app.inject(url)).statusCode, 401);
  } finally {
    await f.app.close();
  }
});

test('作品库区分本人/全部，跨用户只读；删除源工作区会话后独立链接仍可读和下载', async () => {
  const f = await fixture();
  try {
    const headers = { 'x-requested-with': 'PixelPrint' };
    const root = `/api/d2c/sessions/${f.id}`;
    const source = 'export const frozen = "共享快照";';
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: root + '/files',
          headers,
          payload: { path: 'page/index.tsx', content: source, baseFileRevision: 0 },
        })
      ).statusCode,
      201,
    );
    const revision = (await f.app.inject(root + '/files')).json().data.fileRevision;
    const result = await f.app.inject({
      method: 'POST',
      url: root + '/versions',
      headers,
      payload: { clientRequestId: 'gallery-ready', name: '共享页面', baseFileRevision: revision },
    });
    assert.equal(result.statusCode, 202, result.body);
    await f.versions.drain();
    const versionId = result.json().data.versionId;
    const row = f.tables.D2cVersion[0];
    row.validationSummary = {
      status: 'failed',
      reportPath: 'private-path',
      privateKey: 'do-not-leak',
    };
    row.configSnapshot = { private: 'do-not-leak' };
    f.tables.D2cVersion.push({ ...row, versionId: 'not-ready', status: 'saving' });
    f.tables.D2cVersion.push({ ...row, versionId: 'failed-version', status: 'failed' });
    assert.equal((await f.app.inject('/api/d2c/versions?scope=mine')).json().data.total, 1);
    f.setEid('employee-b');
    assert.equal((await f.app.inject('/api/d2c/versions?scope=mine')).json().data.total, 0);
    const all = await f.app.inject('/api/d2c/versions?scope=all&pageSize=1');
    assert.equal(all.statusCode, 200);
    assert.equal(all.json().data.total, 1);
    assert.equal(all.json().data.rows[0].createdUserId, 'employee-a');
    assert.doesNotMatch(
      all.body,
      /private-path|do-not-leak|archiveObject|configSnapshot|clientRequestId|sessionId|workspaceId|leaseUntil/,
    );
    assert.equal((await f.app.inject('/api/d2c/versions?scope=invalid')).statusCode, 422);
    assert.equal((await f.app.inject('/api/d2c/versions/not-ready')).statusCode, 404);
    assert.equal((await f.app.inject('/api/d2c/versions/failed-version/archive')).statusCode, 404);
    f.tables.D2cWorkspace[0].deletedAt = new Date();
    f.tables.D2cSession[0].deletedAt = new Date();
    f.tables.D2cFile[0].content = 'modified live source';
    const url = `/api/d2c/versions/${versionId}`;
    const detail = await f.app.inject(url);
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.headers['cache-control'], 'no-store');
    assert.deepEqual(detail.json().data.validationSummary, { status: 'failed' });
    const file = detail.json().data.files[0];
    assert.equal(file.path, 'page/index.tsx');
    assert.doesNotMatch(detail.body, /objectLocator|archiveObject|private-path|do-not-leak/);
    const text = await f.app.inject(`${url}/files/${file.fileId}`);
    assert.equal(text.statusCode, 200, text.body);
    assert.equal(text.json().data.content, source);
    const archive = await f.app.inject(url + '/archive');
    assert.equal(archive.statusCode, 200, archive.body);
    assert.equal(Buffer.from(unzipSync(archive.rawPayload)['page/index.tsx']).toString(), source);
    assert.match(String(archive.headers['content-disposition']), /^attachment;/);
    assert.equal((await f.app.inject(url + '/files/' + 'a'.repeat(64))).statusCode, 404);
    assert.equal((await f.app.inject(url + '/files/bad')).statusCode, 422);
    f.tables.D2cVersionFile[0].content = 'corrupt stored text';
    assert.equal((await f.app.inject(`${url}/files/${file.fileId}`)).statusCode, 503);
    f.setEid('');
    for (const path of ['/api/d2c/versions', url, url + '/archive', `${url}/files/${file.fileId}`])
      assert.equal((await f.app.inject(path)).statusCode, 401);
  } finally {
    await f.app.close();
  }
});

test('运行中的版本路由允许省略基础修订与名称，重试返回原版本；非法名称拒绝', async () => {
  const f = await fixture();
  const headers = { 'x-requested-with': 'PixelPrint' };
  const root = `/api/d2c/sessions/${f.id}`;
  try {
    const created = await f.app.inject({
      method: 'POST',
      url: root + '/files',
      headers,
      payload: { path: 'index.tsx', content: 'export const page = 1;', baseFileRevision: 0 },
    });
    assert.equal(created.statusCode, 201, created.body);
    const revision = (await f.app.inject(root + '/files')).json().data.fileRevision;
    f.tables.D2cSession[0].activeRunId = 'running-route';
    f.tables.D2cRun.push({
      runId: 'running-route',
      sessionId: f.id,
      status: 'running',
      leaseOwner: 'worker',
      leaseExpiresAt: new Date(Date.now() + 60000),
    });
    for (const name of [undefined, '', ' \t\n ']) {
      const payload = { clientRequestId: 'optional-name', name };
      const result = await f.app.inject({
        method: 'POST',
        url: root + '/versions',
        headers,
        payload,
      });
      assert.equal(result.statusCode, 202, result.body);
      assert.match(result.json().data.name, new RegExp(` · r${revision} · v1$`));
      assert.equal(f.tables.D2cVersion.length, 1);
      assert.equal(result.json().data.versionId, f.tables.D2cVersion[0].versionId);
      await f.versions.drain();
      f.tables.D2cSession[0].name = '重试前改名';
    }
    for (const name of [null, 123, 'x'.repeat(201), 'bad\u0000name', '不同名称']) {
      const result = await f.app.inject({
        method: 'POST',
        url: root + '/versions',
        headers,
        payload: { clientRequestId: 'optional-name', baseFileRevision: revision, name },
      });
      assert.equal(result.statusCode, name === '不同名称' ? 409 : 422, result.body);
    }
  } finally {
    await f.versions.close();
    await f.app.close();
  }
});

test('删除会话版本继承登录和同源保护，身份仅取服务端用户', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const calls: string[][] = [];
  f.versions.gallery.remove = async (eid, versionId) => {
    calls.push([eid, versionId]);
    return { versionId, deleted: true };
  };
  const request = { method: 'DELETE' as const, url: '/api/d2c/versions/version-one' };
  const headers = { 'x-requested-with': 'PixelPrint' };
  assert.equal((await f.app.inject(request)).statusCode, 403);
  assert.equal(
    (
      await f.app.inject({
        ...request,
        headers: { ...headers, 'sec-fetch-site': 'cross-site' },
      })
    ).statusCode,
    403,
  );
  f.setEid('');
  assert.equal((await f.app.inject({ ...request, headers })).statusCode, 401);
  assert.deepEqual(calls, []);
  f.setEid('employee-a');
  const result = await f.app.inject({ ...request, headers });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json().data, { versionId: 'version-one', deleted: true });
  assert.deepEqual(calls, [['employee-a', 'version-one']]);
});
