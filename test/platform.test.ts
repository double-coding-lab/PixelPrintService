import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

const fixtureDirectory = mkdtempSync(path.join(tmpdir(), 'pixelprint-platform-test-'));
const fixturePath = path.join(fixtureDirectory, 'project.config.json');
const fixture = JSON.parse(
  readFileSync(new URL('../project.config.example.json', import.meta.url), 'utf8'),
);
fixture.auth = {
  sessionSecret: 'ab'.repeat(32),
  sessionTtlSeconds: 86400,
  users: [{ id: 'test', name: 'Test', passwordHash: 'scrypt$fixture' }],
};
writeFileSync(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
const originalConfigPath = process.env.PIXELPRINT_CONFIG;
process.env.PIXELPRINT_CONFIG = fixturePath;
const { projectConfig } = await import('../src/config/project');
if (originalConfigPath === undefined) delete process.env.PIXELPRINT_CONFIG;
else process.env.PIXELPRINT_CONFIG = originalConfigPath;
rmSync(fixtureDirectory, { recursive: true, force: true });
const { createSession, readSession, registerIdentity, sessionCookieName, verifyPassword } =
  await import('../src/hooks/http/identity');
const { loginReturnPath, registerLoginRoute, registerAuthGuard } = await import(
  '../src/hooks/http/auth'
);
const { RuntimeConfig } = await import('../src/hooks/tools/config');
const { Sequelize } = await import('sequelize');
const { connectMysql } = await import('../src/hooks/tools/mysql');

/** 使用临时账号与密钥验证基础适配，不访问数据库、Redis 或真实账号。 */
test('local platform adapters', async (t) => {
  const originalAuth = projectConfig.auth;
  const originalUrl = projectConfig.server.publicUrl;
  const salt = '12'.repeat(16);
  const password = 'platform-test-password';
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
  projectConfig.auth = {
    sessionSecret: 'ab'.repeat(32),
    sessionTtlSeconds: 86400,
    users: [
      {
        id: 'platform-test',
        name: 'Test User',
        passwordHash,
        apiToken: 'test-api-token-'.repeat(4),
      },
    ],
  };
  projectConfig.server.publicUrl = 'https://app.example.test';
  t.after(() => {
    projectConfig.auth = originalAuth;
    projectConfig.server.publicUrl = originalUrl;
  });

  await t.test(
    'scrypt verifies default Node hashes and rejects wrong or malformed input',
    async () => {
      assert.equal(await verifyPassword(password, passwordHash), true);
      assert.equal(await verifyPassword('wrong', passwordHash), false);
      assert.equal(await verifyPassword(password, 'plaintext'), false);
      assert.equal(await verifyPassword(null, passwordHash), false);
    },
  );

  await t.test('sessions reject tampering, expiry, future issuance and deleted accounts', () => {
    const now = 1800000000000;
    const token = createSession('platform-test', now);
    assert.equal(readSession(token, now), 'platform-test');
    assert.equal(readSession(token, now + 86400000), null);
    assert.equal(readSession(token, now - 1000), null);
    assert.equal(readSession(`${token.slice(0, -1)}!`, now), null);
    assert.equal(readSession(createSession('missing', now), now), null);
    assert.equal(readSession(undefined), null);
    const [payload, signature] = token.split('.');
    const altered = Buffer.from(
      JSON.stringify({ sub: 'admin', iat: 1800000000, exp: 1800086400 }),
    ).toString('base64url');
    assert.notEqual(altered, payload);
    assert.equal(readSession(`${altered}.${signature}`, now), null);
  });

  await t.test('returnTo only permits safe local page destinations', () => {
    assert.equal(loginReturnPath(undefined), '/workbench');
    assert.equal(loginReturnPath(''), '/workbench');
    assert.equal(loginReturnPath('/'), '/');
    assert.equal(loginReturnPath('/workspace?a=1#files'), '/workspace?a=1#files');
    for (const value of [
      'https://evil.test',
      '//evil.test',
      '/%2f%2fevil.test',
      '/\\evil.test',
      '/login',
      '/%61pi/private',
      '/logout',
      '/%00evil',
      '/%zz',
      '/auth/github',
      '/' + 'x'.repeat(4096),
    ]) {
      assert.equal(loginReturnPath(value), '/workbench', value);
    }
  });

  await t.test(
    'RuntimeConfig serves only local runtime without loading remote configuration',
    async () => {
      const config = new RuntimeConfig();
      await config.load();
      assert.equal(config.get(), projectConfig.runtime);
      assert.equal(config.get('runtime'), projectConfig.runtime);
      assert.equal(config.get('__proto__'), undefined);
      assert.equal(config.all(), projectConfig.runtime);
    },
  );

  await t.test(
    'MySQL registers models without schema synchronization and closes failed connections',
    async (t) => {
      const authenticate = t.mock.method(
        Sequelize.prototype,
        'authenticate',
        async () => undefined,
      );
      const close = t.mock.method(Sequelize.prototype, 'close', async () => undefined);
      const sync = t.mock.method(Sequelize.prototype, 'sync', async () => {
        throw new Error('Schema synchronization is not allowed');
      });
      const mysql = await connectMysql();
      assert.equal(mysql.getDialect(), 'mysql');
      assert.equal(mysql.config.database, projectConfig.database.name);
      assert.ok(Object.keys(mysql.models).length > 0);
      assert.equal(sync.mock.callCount(), 0);
      await mysql.close();
      authenticate.mock.mockImplementation(async () => {
        throw new Error('Database unavailable');
      });
      await assert.rejects(connectMysql(), /Database unavailable/);
      assert.equal(close.mock.callCount(), 2);
    },
  );

  await t.test(
    'login, identity, guard and logout work through real Fastify injection',
    async () => {
      const app = Fastify();
      t.after(() => app.close());
      registerIdentity(app);
      registerLoginRoute(app);
      app.register(async (protectedApp) => {
        registerAuthGuard(protectedApp);
        protectedApp.get('/private', async (request) => ({
          user: await request.getUser(),
          uid: await request.getUid(),
          cid: request.getCid(),
        }));
      });
      const page = await app.inject('/login?returnTo=%2Fworkspace');
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /type="password"/);
      assert.equal(page.headers['cache-control'], 'no-store');
      assert.equal((await app.inject('/private')).statusCode, 401);
      assert.equal(
        (await app.inject({ url: '/private', headers: { authorization: 'Bearer forged' } }))
          .statusCode,
        401,
      );
      const bad = await app.inject({
        method: 'POST',
        url: '/login',
        payload: { id: 'platform-test', password: 'wrong' },
      });
      assert.equal(bad.statusCode, 401);
      assert.equal(bad.headers['set-cookie'], undefined);
      const crossSite = await app.inject({
        method: 'POST',
        url: '/login',
        headers: { origin: 'https://evil.test' },
        payload: { id: 'platform-test', password },
      });
      assert.equal(crossSite.statusCode, 403);
      const login = await app.inject({
        method: 'POST',
        url: '/login',
        payload: { id: 'platform-test', password, returnTo: '/workspace' },
      });
      assert.equal(login.statusCode, 303);
      assert.equal(login.headers.location, '/workspace');
      const setCookie = String(login.headers['set-cookie']);
      assert.match(setCookie, /HttpOnly; SameSite=Lax; Max-Age=86400; Secure/);
      const cookie = setCookie.split(';')[0];
      const identity = await app.inject({ url: '/private', headers: { cookie } });
      assert.equal(identity.statusCode, 200);
      assert.equal(identity.json().user.userId, 'platform-test');
      assert.equal(identity.json().uid, 'platform-test');
      assert.equal(identity.json().user.name, 'Test User');
      const bearerIdentity = await app.inject({
        url: '/private',
        headers: { authorization: `Bearer ${'test-api-token-'.repeat(4)}` },
      });
      assert.equal(bearerIdentity.statusCode, 200);
      assert.equal(bearerIdentity.json().user.userId, 'platform-test');
      assert.equal(bearerIdentity.json().uid, 'platform-test');
      const cookiePriority = await app.inject({
        url: '/private',
        headers: { cookie, authorization: 'Bearer forged' },
      });
      assert.equal(cookiePriority.statusCode, 200);

      assert.ok(identity.json().cid);
      assert.equal(identity.body.includes('passwordHash'), false);
      assert.equal(
        (await app.inject({ url: '/private', headers: { cookie: `${sessionCookieName}=forged` } }))
          .statusCode,
        401,
      );
      const form = await app.inject({
        method: 'POST',
        url: '/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          id: 'platform-test',
          password,
          returnTo: '//evil.test',
        }).toString(),
      });
      assert.equal(form.statusCode, 303);
      assert.equal(form.headers.location, '/workbench');
      const logout = await app.inject({ method: 'POST', url: '/logout', headers: { cookie } });
      assert.equal(logout.statusCode, 204);
      assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);
    },
  );
});
