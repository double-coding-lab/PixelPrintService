import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import Fastify from 'fastify';
import { registerPublicHome } from '../src/hooks/http/publicHome';
import { appPath, readAppRoute } from '../web/src/workspace/appRoutes';
import type { WorkspaceService } from '../src/functions/d2c/workspace/service';

// Config and static resources are isolated from developer credentials and build output.
const directory = mkdtempSync(path.join(tmpdir(), 'pixelprint-public-home-config-'));
const configPath = path.join(directory, 'project.config.json');
const fixture = JSON.parse(
  readFileSync(new URL('../project.config.example.json', import.meta.url), 'utf8'),
);
const password = 'public-home-fixture-password';
const salt = '56'.repeat(16);
fixture.auth = {
  sessionSecret: 'public-home-fixture-secret-'.repeat(3),
  sessionTtlSeconds: 86400,
  users: [
    {
      id: 'home-test',
      name: 'Home Test',
      passwordHash: `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`,
    },
  ],
  guest: { enabled: true, ttlSeconds: 3600 },
};
writeFileSync(configPath, JSON.stringify(fixture), { mode: 0o600 });
const previousConfigPath = process.env.PIXELPRINT_CONFIG;
try {
  process.env.PIXELPRINT_CONFIG = configPath;
  await import('../src/config/project');
} finally {
  if (previousConfigPath === undefined) delete process.env.PIXELPRINT_CONFIG;
  else process.env.PIXELPRINT_CONFIG = previousConfigPath;
  rmSync(directory, { recursive: true, force: true });
}
const { registerHttpHooks } = await import('../src/hooks/http/index');
const { createSession, sessionCookieName } = await import('../src/hooks/http/identity');
const { registerLoginRoute, registerAuthGuard } = await import('../src/hooks/http/auth');
const { default: workspaceRoutes } = await import('../src/functions/d2c/workspace');

const landing = '<!doctype html><link rel="stylesheet" href="/assets/landing.css"><h1>Landing</h1>';
const spa = '<!doctype html><div id="root">SPA fixture</div>';
const css = 'body { color: #123456; }';

/** Exercise production HTTP hooks, page component and workspace routes without a DB. */
async function makeApp(t: TestContext, includeLanding = true) {
  const root = mkdtempSync(path.join(tmpdir(), 'pixelprint-public-home-'));
  mkdirSync(path.join(root, 'assets'));
  writeFileSync(path.join(root, 'index.html'), spa);
  writeFileSync(path.join(root, 'assets/landing.css'), css);
  if (includeLanding) writeFileSync(path.join(root, 'landing.html'), landing);
  const app = Fastify();
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  app.decorate('logging', { info() {}, error() {} });
  registerHttpHooks(app);
  const reads = { uid: 0, user: 0 };
  app.addHook('onRequest', async (request) => {
    const getUid = request.getUid;
    const getUser = request.getUser;
    request.getUid = async () => {
      reads.uid++;
      return getUid.call(request);
    };
    request.getUser = async () => {
      reads.user++;
      return getUser.call(request);
    };
  });
  registerLoginRoute(app);
  const list = t.mock.fn(async () => ({ items: [], total: 0 }));
  app.register(
    async (protectedApp) => {
      registerAuthGuard(protectedApp);
      protectedApp.register(workspaceRoutes, {
        templateRoot: root,
        environment: 'local',
        workspaceService: { list } as unknown as WorkspaceService,
      });
    },
    { prefix: '/api/d2c' },
  );
  await registerPublicHome(app, root);
  await app.ready();
  return { app, reads, list, root };
}

test('plain and marketing roots return the same static page without reading identity', async (t) => {
  const { app, reads } = await makeApp(t);
  const authenticated = `${sessionCookieName}=${createSession('home-test')}`;
  for (const headers of [
    {},
    { cookie: authenticated },
    { cookie: `${sessionCookieName}=forged`, authorization: 'Bearer forged' },
  ]) {
    for (const url of ['/', '/?', '/?utm_source=github&ref=readme', '/?returnTo=/workbench']) {
      const response = await app.inject({ url, headers });
      assert.equal(response.statusCode, 200, url);
      assert.equal(response.body, landing);
      assert.match(String(response.headers['content-type']), /text\/html/);
      assert.equal(response.headers.location, undefined);
      assert.equal(response.headers['set-cookie'], undefined);
      assert.match(String(response.headers['content-security-policy']), /style-src 'self'/);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
    }
  }
  const head = await app.inject({ method: 'HEAD', url: '/' });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.deepEqual(reads, { uid: 0, user: 0 });
});

test('legacy root query keys select SPA; frontend remains the only business parser', async (t) => {
  const { app } = await makeApp(t);
  for (const key of ['workspace', 'session', 'view', 'version', 'share', 'work']) {
    for (const query of [key, `${key}=`, `${key}=unknown`, `${key}=a&${key}=b`]) {
      const response = await app.inject('/?utm_source=github&' + query);
      assert.equal(response.statusCode, 200, query);
      assert.equal(response.body, spa, query);
      assert.equal(response.headers['content-security-policy'], undefined);
    }
  }
  for (const [url, expected] of [
    ['/?workspace=w&session=s', '/workbench/w/sessions/s'],
    ['/?view=plaza&share=p', '/plaza/p'],
    ['/?view=my-works&work=m', '/plaza/saved/m'],
    ['/?view=works&version=v', '/works/versions/v'],
    ['/?session=orphan', '/workbench'],
    ['/?view=unknown', '/workbench'],
    ['/?view=plaza&version=v&share=p', '/plaza/p'],
    ['/?view=works&view=plaza&version=v', '/works/versions/v'],
    ['/?%77orkspace=w&session=s', '/workbench/w/sessions/s'],
  ]) {
    const response = await app.inject(url);
    assert.equal(response.body, spa, url);
    assert.equal(appPath(readAppRoute(new URL(url, 'http://localhost'))), expected);
  }
  for (const url of ['/?Workspace=w', '/?workspaceId=w', '/?campaign=workspace', '/?ticket=x'])
    assert.equal((await app.inject(url)).body, landing, url);
});

test('SPA deep links and landing stylesheet remain reachable with existing policies', async (t) => {
  const { app } = await makeApp(t);
  for (const url of [
    '/workbench',
    '/workbench/w/sessions/s',
    '/works',
    '/works/versions/v',
    '/works/saved/m',
    '/plaza',
    '/plaza/p?view=works&version=v',
    '/plaza/saved',
    '/plaza/saved/m',
    '/slbhealthcheck.html?workspace=w&session=s',
    '/index.html',
  ]) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200, url);
    assert.equal(response.body, spa, url);
    assert.equal(response.headers['content-security-policy'], undefined, url);
  }
  const stylesheet = await app.inject('/assets/landing.css');
  assert.equal(stylesheet.statusCode, 200);
  assert.equal(stylesheet.body, css);
  assert.match(String(stylesheet.headers['content-type']), /text\/css/);
});

test('public home never bypasses API authentication or reserved namespace 404s', async (t) => {
  const { app, list } = await makeApp(t);
  for (const headers of [
    {},
    { cookie: `${sessionCookieName}=forged` },
    { authorization: 'Bearer forged' },
  ]) {
    for (const url of ['/api/d2c/workspaces', '/api/d2c/workspaces?view=plaza', '/auth/me'])
      assert.equal((await app.inject({ url, headers })).statusCode, 401, url);
  }
  assert.equal(list.mock.callCount(), 0);
  const cookie = `${sessionCookieName}=${createSession('home-test')}`;
  assert.equal(
    (await app.inject({ url: '/api/d2c/workspaces', headers: { cookie } })).statusCode,
    200,
  );
  assert.deepEqual(list.mock.calls[0].arguments, ['home-test', 1, 20]);
  for (const prefix of ['/api', '/auth', '/files', '/H5_Preview', '/RN_Preview']) {
    for (const url of [prefix, `${prefix}?view=plaza`, `${prefix}/missing?workspace=w`]) {
      const response = await app.inject(url);
      assert.equal(response.statusCode, 404, url);
      assert.deepEqual(response.json(), { error: 'Not found' });
    }
  }
});

test('missing landing returns 503 without identity, redirect or SPA fallback', async (t) => {
  const { app, reads } = await makeApp(t, false);
  for (const url of ['/', '/?utm_source=github']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'Public home unavailable' });
    assert.equal(response.headers.location, undefined);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.deepEqual(reads, { uid: 0, user: 0 });
  for (const url of ['/?workspace=w&session=s', '/workbench', '/plaza'])
    assert.equal((await app.inject(url)).body, spa, url);
});

test('local and guest login defaults reach workbench, while explicit home and legacy returns survive', async (t) => {
  const { app } = await makeApp(t);
  const destinations: [unknown, string][] = [
    [undefined, '/workbench'],
    ['', '/workbench'],
    ['//evil.test', '/workbench'],
    ['/auth/github', '/workbench'],
    ['/', '/'],
    ['/?workspace=w&session=s', '/?workspace=w&session=s'],
    ['/plaza/p?ticket=remove&ref=login', '/plaza/p?ref=login'],
  ];
  for (const [returnTo, expected] of destinations) {
    const page = await app.inject(
      '/login' +
        (returnTo === undefined ? '' : '?returnTo=' + encodeURIComponent(String(returnTo))),
    );
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes(`name="returnTo" value="${expected.replaceAll('&', '&amp;')}"`));
    for (const url of ['/login', '/auth/guest']) {
      const login = await app.inject({
        method: 'POST',
        url,
        payload: { id: 'home-test', password, ...(returnTo === undefined ? {} : { returnTo }) },
      });
      assert.equal(login.statusCode, 303, url);
      assert.equal(login.headers.location, expected, url);
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const destination = await app.inject({
        url: String(login.headers.location),
        headers: { cookie },
      });
      assert.equal(destination.statusCode, 200);
      assert.equal(destination.body, expected === '/' ? landing : spa);
      assert.equal(destination.headers.location, undefined);
    }
  }
});
