import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID, scryptSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';

// Isolated from developer config, live Redis, GitHub and the platform fixture process.
const directory = mkdtempSync(path.join(tmpdir(), 'pixelprint-external-auth-'));
const configPath = path.join(directory, 'project.config.json');
const fixture = JSON.parse(
  readFileSync(new URL('../project.config.example.json', import.meta.url), 'utf8'),
);
const origin = 'https://auth.example.test';
const secret = 'external-auth-test-secret-'.repeat(3);
const clientSecret = 'github-client-secret-DO-NOT-EXPOSE';
const password = 'external-auth-local-password';
const salt = '34'.repeat(16);
const passwordHash = 'scrypt$' + salt + '$' + scryptSync(password, salt, 64).toString('hex');
const apiToken = 'local-api-token-DO-NOT-EXPOSE-'.repeat(2);
const authConfig = () => ({
  sessionSecret: secret,
  sessionTtlSeconds: 172800,
  users: [{ id: 'local-user', name: 'Local User', passwordHash, apiToken }],
  github: { enabled: true, clientId: 'offline-client-id', clientSecret },
  guest: { enabled: true, ttlSeconds: 3600 },
});
fixture.auth = authConfig();
fixture.server.publicUrl = origin;
writeFileSync(configPath, JSON.stringify(fixture), { mode: 0o600 });
const originalConfigPath = process.env.PIXELPRINT_CONFIG;
let configModule: typeof import('../src/config/project');
try {
  process.env.PIXELPRINT_CONFIG = configPath;
  configModule = await import('../src/config/project');
} finally {
  if (originalConfigPath === undefined) delete process.env.PIXELPRINT_CONFIG;
  else process.env.PIXELPRINT_CONFIG = originalConfigPath;
  rmSync(directory, { recursive: true, force: true });
}
const { projectConfig, loadProjectConfig } = configModule;
const {
  createSession,
  createExternalSession,
  readSession,
  readSessionIdentity,
  registerIdentity,
  sessionCookieName,
} = await import('../src/hooks/http/identity');
const { registerLoginRoute, registerAuthGuard } = await import('../src/hooks/http/auth');

const oauthCookieName = 'pixelprint_oauth';
const guestId = 'guest-123e4567-e89b-42d3-a456-426614174000';
const guestPattern = /^guest-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const githubUser = { id: '123456', login: 'octocat-test', name: 'GitHub Test User' };
type ExchangeInput = { code: string; codeVerifier: string; redirectUri: string };
type Exchange = (
  input: ExchangeInput,
) => Promise<typeof githubUser | { id: string; login: string; name: null }>;
type Response = {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | number | undefined>;
};

/** Only the two Redis operations required by OAuth, including TTL and atomic consumption. */
class MemoryRedis {
  entries = new Map<string, { value: string; expiresAt: number }>();
  failSet = false;
  failGetDel = false;
  async set(key: string, value: string, options: { EX?: number; PX?: number; NX?: boolean } = {}) {
    if (this.failSet) throw new Error('redis-private-connection-DO-NOT-EXPOSE');
    if (options.NX && this.entries.has(key)) return null;
    const ttl = options.PX ?? (options.EX === undefined ? Infinity : options.EX * 1000);
    this.entries.set(key, { value, expiresAt: Date.now() + ttl });
    return 'OK';
  }
  async getDel(key: string) {
    if (this.failGetDel) throw new Error('redis-private-connection-DO-NOT-EXPOSE');
    const entry = this.entries.get(key);
    this.entries.delete(key);
    return entry && entry.expiresAt > Date.now() ? entry.value : null;
  }
}

function cookieLines(response: Response): string[] {
  const values = response.headers['set-cookie'];
  return values === undefined ? [] : Array.isArray(values) ? values : [String(values)];
}
function cookiePair(response: Response, name = sessionCookieName): string | undefined {
  return cookieLines(response)
    .find((line) => line.startsWith(name + '='))
    ?.split(';')[0];
}
function requireCookie(response: Response, name = sessionCookieName): string {
  const pair = cookiePair(response, name);
  assert.ok(pair, 'response must set ' + name);
  return pair;
}
function cookieToken(pair: string): string {
  return pair.slice(pair.indexOf('=') + 1);
}
function assertCookie(response: Response, name: string, maxAge?: number) {
  const line = cookieLines(response).find((value) => value.startsWith(name + '='));
  assert.ok(line);
  for (const flag of [/;\s*HttpOnly/i, /;\s*SameSite=Lax/i, /;\s*Secure/i])
    assert.match(line, flag);
  if (maxAge !== undefined)
    assert.match(line, new RegExp(';\\s*Max-Age=' + maxAge + '(?:;|$)', 'i'));
}
function assertPrivate(response: Response, extraSecrets: string[] = []) {
  const exposed = response.body + JSON.stringify(response.headers);
  for (const value of [secret, clientSecret, passwordHash, apiToken, ...extraSecrets]) {
    assert.equal(exposed.includes(value), false, 'response leaked private value');
  }
  assert.equal(response.headers['cache-control'], 'no-store');
}
function assertNoSession(response: Response) {
  const session = cookiePair(response);
  assert.ok(!session || !cookieToken(session), 'failed authentication must not issue a session');
}
function assertRejected(response: Response, extraSecrets: string[] = []) {
  const loginFailure =
    response.statusCode === 303 && /^\/login(?:\?|$)/.test(String(response.headers.location));
  assert.ok(
    (response.statusCode >= 400 && response.statusCode < 600) || loginFailure,
    'authentication must fail or return to the safe login page',
  );
  assertNoSession(response);
  assertPrivate(response, extraSecrets);
}
async function assertFailurePage(app: FastifyInstance, response: Response, secrets: string[] = []) {
  assertRejected(response, secrets);
  const page =
    response.statusCode === 303 ? await app.inject(String(response.headers.location)) : response;
  if (response.statusCode === 303) assert.equal(page.statusCode, 200);
  assert.match(String(page.headers['content-type']), /text\/html/);
  assertPrivate(page, secrets);
}
function signPayload(payload: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return encoded + '.' + createHmac('sha256', secret).update(encoded).digest('base64url');
}
async function makeApp(t: TestContext, exchangeCode: Exchange = async () => githubUser) {
  const app = Fastify();
  const redis = new MemoryRedis();
  app.decorate('redis', redis);
  registerIdentity(app);
  registerLoginRoute(app, { github: { exchangeCode } });
  app.register(async (protectedApp) => {
    registerAuthGuard(protectedApp);
    protectedApp.get('/external-auth-private', async (request) => ({
      user: await request.getUser(),
      uid: await request.getUid(),
    }));
  });
  t.after(() => app.close());
  await app.ready();
  return { app, redis };
}
async function beginGithub(app: FastifyInstance, returnTo = '/workspace?source=github') {
  const response = await app.inject({
    url: '/auth/github?returnTo=' + encodeURIComponent(returnTo),
  });
  assert.equal(response.statusCode, 302);
  const location = new URL(String(response.headers.location));
  assert.equal(location.origin, 'https://github.com');
  assert.equal(location.pathname, '/login/oauth/authorize');
  const state = location.searchParams.get('state');
  assert.ok(state && state.length >= 32);
  return { response, location, state, cookie: requireCookie(response, oauthCookieName) };
}
function callbackUrl(state: string, code = 'offline-authorization-code-DO-NOT-EXPOSE') {
  return '/auth/github/callback?' + new URLSearchParams({ state, code });
}

/** Subtests run serially because the application reads shared in-process projectConfig. */
test('external authentication regression (offline)', { concurrency: false }, async (t) => {
  const originalAuth = projectConfig.auth;
  const originalUrl = projectConfig.server.publicUrl;
  t.beforeEach(() => {
    projectConfig.auth = authConfig();
    projectConfig.server.publicUrl = origin;
  });
  t.after(() => {
    projectConfig.auth = originalAuth;
    projectConfig.server.publicUrl = originalUrl;
  });
  // No test is permitted to accidentally exercise the production GitHub transport.
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('External network is forbidden in externalAuth.test.ts');
  });
  t.after(() => assert.equal(network.mock.callCount(), 0, 'tests must stay offline'));

  await t.test('guest identities are signed, stable, namespaced and expire in milliseconds', () => {
    const now = 1800000000000;
    const token = createExternalSession(
      { id: guestId, name: 'Temporary Guest', provider: 'guest' },
      now,
    );
    assert.deepEqual(readSessionIdentity(token, now), {
      id: guestId,
      name: 'Temporary Guest',
      provider: 'guest',
      expiresAt: now + 3600000,
    });
    assert.equal(readSession(token, now + 1000), guestId);
    assert.equal(readSessionIdentity(token, now + 3599999)?.id, guestId);
    assert.equal(readSessionIdentity(token, now + 3600000), null);
    assert.equal(readSessionIdentity(token, now - 1000), null);
    assert.equal(readSessionIdentity(token.slice(0, -1) + '!', now), null);
    const parts = token.split('.');
    const altered = Buffer.from(JSON.stringify({ sub: 'local-user', provider: 'local' })).toString(
      'base64url',
    );
    assert.equal(readSessionIdentity(altered + '.' + parts[1], now), null);
    for (const value of [undefined, '', 'forged', 'a.b', 'a'.repeat(5000)]) {
      assert.equal(readSessionIdentity(value, now), null);
    }
  });

  await t.test('guest TTL is min(session TTL, configured guest TTL or one-day default)', () => {
    const now = 1800000000000;
    for (const [sessionTtl, guestTtl, expected] of [
      [172800, undefined, 86400],
      [600, undefined, 600],
      [7200, 300, 300],
      [60, 300, 60],
    ] as const) {
      projectConfig.auth.sessionTtlSeconds = sessionTtl;
      projectConfig.auth.guest =
        guestTtl === undefined ? { enabled: true } : { enabled: true, ttlSeconds: guestTtl };
      const token = createExternalSession({ id: guestId, name: 'Guest', provider: 'guest' }, now);
      assert.equal(readSessionIdentity(token, now)?.expiresAt, now + expected * 1000);
      assert.equal(readSession(token, now + expected * 1000), null);
    }
  });

  await t.test('disabling either external provider invalidates previously issued sessions', () => {
    const now = 1800000000000;
    const guest = createExternalSession({ id: guestId, name: 'Guest', provider: 'guest' }, now);
    const github = createExternalSession(
      { id: 'github-123456', name: 'Octocat', provider: 'github' },
      now,
    );
    assert.equal(readSessionIdentity(github, now)?.expiresAt, now + 172800000);
    projectConfig.auth.guest!.enabled = false;
    assert.equal(readSessionIdentity(guest, now), null);
    assert.equal(readSession(github, now), 'github-123456');
    projectConfig.auth.github!.enabled = false;
    assert.equal(readSessionIdentity(github, now), null);
    delete projectConfig.auth.guest;
    delete projectConfig.auth.github;
    assert.equal(readSession(guest, now), null);
    assert.equal(readSession(github, now), null);
  });

  await t.test(
    'external creation cannot mint local IDs, cross-provider IDs or malformed namespaces',
    () => {
      const now = 1800000000000;
      for (const [provider, id] of [
        ['guest', 'local-user'],
        ['guest', 'github-123'],
        ['guest', 'guest-not-a-uuid'],
        ['github', guestId],
        ['github', 'local-user'],
        ['github', 'github-octocat'],
        ['github', 'github-123/../../admin'],
      ] as const) {
        // Either a rejected creation or an unreadable token is acceptable; it must never authenticate.
        let token: string;
        try {
          token = createExternalSession({ id, name: 'Forged', provider }, now);
        } catch {
          continue;
        }
        assert.equal(readSessionIdentity(token, now), null, provider + ':' + id);
      }
    },
  );

  await t.test(
    'legacy provider-less local session payloads retain local identity and account checks',
    () => {
      const now = 1800000000000;
      const legacy = signPayload({ sub: 'local-user', iat: now / 1000, exp: now / 1000 + 3600 });
      assert.deepEqual(readSessionIdentity(legacy, now), {
        id: 'local-user',
        name: 'Local User',
        provider: 'local',
        expiresAt: now + 3600000,
      });
      assert.equal(readSession(legacy, now), 'local-user');
      assert.equal(readSession(createSession('local-user', now), now), 'local-user');
      assert.equal(readSession(legacy, now + 3600000), null);
      const users = projectConfig.auth.users;
      projectConfig.auth.users = [];
      assert.equal(readSessionIdentity(legacy, now), null);
      projectConfig.auth.users = users;
      for (const sub of [guestId, 'github-123456']) {
        assert.equal(
          readSessionIdentity(signPayload({ sub, iat: now / 1000, exp: now / 1000 + 60 }), now),
          null,
        );
      }
    },
  );

  await t.test(
    'configuration accepts optional providers and reserves external local-user prefixes',
    () => {
      const temp = mkdtempSync(path.join(tmpdir(), 'pixelprint-external-auth-config-'));
      t.after(() => rmSync(temp, { recursive: true, force: true }));
      const filename = path.join(temp, 'config.json');
      const write = (value: unknown) =>
        writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
      const value = structuredClone(fixture);
      write(value);
      const loaded = loadProjectConfig(filename);
      assert.equal(loaded.auth.github?.clientId, 'offline-client-id');
      assert.equal(loaded.auth.guest?.ttlSeconds, 3600);
      delete value.auth.github;
      delete value.auth.guest;
      write(value);
      assert.doesNotThrow(() => loadProjectConfig(filename));
      for (const id of ['github-123456', 'github-arbitrary', guestId, 'guest-arbitrary']) {
        value.auth.users[0].id = id;
        write(value);
        assert.throws(() => loadProjectConfig(filename), 'reserved prefix: ' + id);
      }
    },
  );

  await t.test(
    '/auth/me rejects anonymous, forged and expired sessions and never trusts reported IDs',
    async (t) => {
      const { app } = await makeApp(t);
      for (const headers of [
        {},
        { cookie: sessionCookieName + '=forged' },
        { 'x-user-id': 'local-user', authorization: 'Bearer forged' },
        {
          cookie:
            sessionCookieName +
            '=' +
            createExternalSession(
              { id: guestId, name: 'Expired', provider: 'guest' },
              Date.now() - 3601000,
            ),
        },
      ]) {
        const response = await app.inject({
          url: '/auth/me?id=local-user&provider=local',
          headers,
        });
        assert.equal(response.statusCode, 401);
        assertPrivate(response);
      }
    },
  );

  await t.test(
    'two guest browsers receive isolated identities that persist across requests',
    async (t) => {
      const { app } = await makeApp(t);
      const first = await app.inject({
        method: 'POST',
        url: '/auth/guest',
        headers: { origin },
        payload: { returnTo: '/workspace?tab=files' },
      });
      const second = await app.inject({
        method: 'POST',
        url: '/auth/guest',
        headers: { origin },
        payload: {},
      });
      assert.equal(first.statusCode, 303);
      assert.equal(second.statusCode, 303);
      assert.equal(first.headers.location, '/workspace?tab=files');
      assertCookie(first, sessionCookieName, 3600);
      assertPrivate(first);
      const firstCookie = requireCookie(first);
      const secondCookie = requireCookie(second);
      const firstIdentity = readSessionIdentity(cookieToken(firstCookie));
      const secondIdentity = readSessionIdentity(cookieToken(secondCookie));
      assert.ok(firstIdentity && secondIdentity);
      assert.match(firstIdentity.id, guestPattern);
      assert.match(secondIdentity.id, guestPattern);
      assert.notEqual(firstIdentity.id, secondIdentity.id);
      for (const [cookie, expected] of [
        [firstCookie, firstIdentity],
        [secondCookie, secondIdentity],
      ] as const) {
        for (let index = 0; index < 2; index++) {
          const me = await app.inject({ url: '/auth/me', headers: { cookie } });
          assert.equal(me.statusCode, 200);
          assert.equal(me.json().userId, expected.id);
          assert.equal(me.json().provider, 'guest');
          assert.equal(me.json().name, expected.name);
          assertPrivate(me);
        }
        const protectedResponse = await app.inject({
          url: '/external-auth-private',
          headers: { cookie },
        });
        assert.equal(protectedResponse.statusCode, 200);
        assert.equal(protectedResponse.json().uid, expected.id);
        assert.equal(protectedResponse.json().user.userId, expected.id);
      }
    },
  );

  await t.test(
    'guest creation ignores every claimed identity, including another guest browser',
    async (t) => {
      const { app } = await makeApp(t);
      const victim = await app.inject({ method: 'POST', url: '/auth/guest', payload: {} });
      const victimId = readSession(cookieToken(requireCookie(victim)))!;
      for (const id of ['local-user', 'github-123456', victimId]) {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/guest?id=' + encodeURIComponent(id),
          headers: { origin, 'x-user-id': id },
          payload: { id, userId: id, name: 'Admin', provider: 'local', returnTo: '/' },
        });
        assert.equal(response.statusCode, 303);
        const identity = readSessionIdentity(cookieToken(requireCookie(response)));
        assert.ok(identity);
        assert.match(identity.id, guestPattern);
        assert.notEqual(identity.id, id);
        assert.equal(identity.provider, 'guest');
        assert.notEqual(identity.name, 'Admin');
      }
    },
  );

  await t.test('guest POST preserves existing guest, GitHub and local logins', async (t) => {
    const { app } = await makeApp(t);
    for (const token of [
      createSession('local-user'),
      createExternalSession({ id: guestId, name: 'Original Guest', provider: 'guest' }),
      createExternalSession({ id: 'github-123456', name: 'Original GitHub', provider: 'github' }),
    ]) {
      const before = readSessionIdentity(token)!;
      const response = await app.inject({
        method: 'POST',
        url: '/auth/guest',
        headers: { origin, cookie: sessionCookieName + '=' + token },
        payload: { id: 'github-999', returnTo: '/workspace' },
      });
      assert.equal(response.statusCode, 303);
      assert.equal(response.headers.location, '/workspace');
      const effectiveToken = cookiePair(response) ? cookieToken(requireCookie(response)) : token;
      assert.deepEqual(readSessionIdentity(effectiveToken), before);
    }
  });

  await t.test('guest POST rejects cross-site writes and sanitizes form returnTo', async (t) => {
    const { app } = await makeApp(t);
    for (const headers of [
      { origin: 'https://evil.test' },
      { origin, 'sec-fetch-site': 'cross-site' },
      { origin: 'null' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/guest',
        headers,
        payload: {},
      });
      assert.equal(response.statusCode, 403);
      assertNoSession(response);
    }
    for (const returnTo of [
      'https://evil.test',
      '//evil.test',
      '/%2f%2fevil.test',
      '/auth/github',
      '/auth/me',
      '/login',
      '/logout',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/guest',
        headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ returnTo }).toString(),
      });
      assert.equal(response.statusCode, 303);
      assert.equal(response.headers.location, '/workbench', returnTo);
    }
  });

  await t.test(
    'disabled guest entry refuses new sessions and /auth/me refuses old ones',
    async (t) => {
      const token = createExternalSession({ id: guestId, name: 'Guest', provider: 'guest' });
      projectConfig.auth.guest!.enabled = false;
      const { app } = await makeApp(t);
      assertRejected(await app.inject({ method: 'POST', url: '/auth/guest', payload: {} }));
      assert.equal(
        (
          await app.inject({
            url: '/auth/me',
            headers: { cookie: sessionCookieName + '=' + token },
          })
        ).statusCode,
        401,
      );
    },
  );

  await t.test(
    'guest logout clears the browser cookie and a later visit receives a new guest',
    async (t) => {
      const { app } = await makeApp(t);
      const guest = await app.inject({ method: 'POST', url: '/auth/guest', payload: {} });
      const cookie = requireCookie(guest);
      const blocked = await app.inject({
        method: 'POST',
        url: '/logout',
        headers: { origin: 'https://evil.test', cookie },
      });
      assert.equal(blocked.statusCode, 403);
      const logout = await app.inject({
        method: 'POST',
        url: '/logout',
        headers: { origin, cookie },
      });
      assert.equal(logout.statusCode, 204);
      assertCookie(logout, sessionCookieName, 0);
      assert.equal(cookieToken(requireCookie(logout)), '');
      assert.equal(
        (await app.inject({ url: '/auth/me', headers: { cookie: requireCookie(logout) } }))
          .statusCode,
        401,
      );
      const next = await app.inject({ method: 'POST', url: '/auth/guest', payload: {} });
      assert.notEqual(
        readSession(cookieToken(requireCookie(next))),
        readSession(cookieToken(cookie)),
      );
    },
  );

  await t.test(
    'local password and actual legacy cookies still expose only safe local /auth/me fields',
    async (t) => {
      const { app } = await makeApp(t);
      const now = Math.floor(Date.now() / 1000);
      const legacy = signPayload({ sub: 'local-user', iat: now, exp: now + 3600 });
      const login = await app.inject({
        method: 'POST',
        url: '/login',
        payload: { id: 'local-user', password },
      });
      assert.equal(login.statusCode, 303);
      for (const cookie of [sessionCookieName + '=' + legacy, requireCookie(login)]) {
        const response = await app.inject({ url: '/auth/me', headers: { cookie } });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().userId, 'local-user');
        assert.equal(response.json().name, 'Local User');
        assert.equal(response.json().provider, 'local');
        assertPrivate(response);
        assert.equal(/passwordHash|apiToken|clientSecret|sessionSecret/.test(response.body), false);
      }
    },
  );

  await t.test(
    'login offers GitHub, guest and password alternatives, with a disabled explanation when unconfigured',
    async (t) => {
      const { app } = await makeApp(t);
      const enabled = await app.inject('/login?returnTo=%2Fworkspace');
      assert.equal(enabled.statusCode, 200);
      assert.equal(enabled.headers['referrer-policy'], 'same-origin');
      assert.match(enabled.body, /GitHub/i);
      assert.match(enabled.body, /\/auth\/github/);
      assert.match(enabled.body, /action=["']\/auth\/guest/);
      assert.match(enabled.body, /type=["']password/);
      assertPrivate(enabled);
      delete projectConfig.auth.github;
      const disabled = await app.inject('/login');
      assert.equal(disabled.statusCode, 200);
      assert.match(disabled.body, /disabled/i);
      assert.match(disabled.body, /GitHub/i);
      assert.match(disabled.body, /未配置|未启用|不可用|not configured|unavailable|disabled/i);
      assertPrivate(disabled);
      assertRejected(await app.inject('/auth/github'));
    },
  );

  await t.test(
    'GitHub authorization uses only the official endpoint and expiring browser-bound Redis state',
    async (t) => {
      const { app, redis } = await makeApp(t);
      const first = await beginGithub(app);
      const second = await beginGithub(app);
      assert.notEqual(first.state, second.state);
      assert.notEqual(first.cookie, second.cookie);
      for (const flow of [first, second]) {
        const nonceHash = createHash('sha256').update(cookieToken(flow.cookie)).digest('hex');
        assert.ok(
          [...redis.entries.values()].some((entry) => entry.value.includes(nonceHash)),
          'Redis must store the browser nonce hash',
        );
      }
      assert.equal(first.location.searchParams.get('client_id'), 'offline-client-id');
      assert.equal(
        first.location.searchParams.get('redirect_uri'),
        origin + '/auth/github/callback',
      );
      assert.equal(first.location.searchParams.get('code_challenge_method'), 'S256');
      assert.match(first.location.searchParams.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(first.location.searchParams.has('code_verifier'), false);
      assert.equal(first.location.searchParams.has('client_secret'), false);
      assertCookie(first.response, oauthCookieName);
      assertPrivate(first.response);
      assert.equal(redis.entries.size, 2);
      for (const entry of redis.entries.values()) {
        assert.ok(Number.isFinite(entry.expiresAt) && entry.expiresAt > Date.now());
        assert.equal(
          entry.value.includes(cookieToken(first.cookie)),
          false,
          'Redis stores a nonce hash, not the raw browser nonce',
        );
        assert.equal(entry.value.includes(cookieToken(second.cookie)), false);
        assert.equal(entry.value.includes(clientSecret), false);
      }
      const attacker = await app.inject(
        '/auth/github?' +
          new URLSearchParams({
            authorizeUrl: 'https://evil.test/authorize',
            tokenUrl: 'https://evil.test/token',
            userUrl: 'https://evil.test/user',
            redirect_uri: 'https://evil.test/callback',
            client_id: 'attacker',
            state: 'attacker',
            code_challenge: 'attacker',
          }),
      );
      assert.equal(attacker.statusCode, 302);
      const location = new URL(String(attacker.headers.location));
      assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize');
      assert.equal(location.searchParams.get('redirect_uri'), origin + '/auth/github/callback');
      assert.equal(location.searchParams.get('client_id'), 'offline-client-id');
      assert.notEqual(location.searchParams.get('state'), 'attacker');
      assert.notEqual(location.searchParams.get('code_challenge'), 'attacker');
    },
  );

  await t.test(
    'GitHub callback verifies PKCE, uses numeric upstream ID, sanitizes returnTo and consumes state once',
    async (t) => {
      const calls: ExchangeInput[] = [];
      const upstreamToken = 'gho_unexpected-upstream-token-DO-NOT-STORE';
      const { app, redis } = await makeApp(t, async (input) => {
        calls.push(input);
        return { ...githubUser, access_token: upstreamToken };
      });
      const flow = await beginGithub(app);
      const response = await app.inject({
        url: callbackUrl(flow.state) + '&id=999&login=attacker&returnTo=https://evil.test',
        headers: { cookie: flow.cookie },
      });
      assert.equal(response.statusCode, 303);
      assert.equal(response.headers.location, '/workspace?source=github');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].code, 'offline-authorization-code-DO-NOT-EXPOSE');
      assert.equal(calls[0].redirectUri, origin + '/auth/github/callback');
      assert.match(calls[0].codeVerifier, /^[A-Za-z0-9._~-]{43,128}$/);
      assert.equal(
        createHash('sha256').update(calls[0].codeVerifier).digest('base64url'),
        flow.location.searchParams.get('code_challenge'),
      );
      assert.equal(redis.entries.size, 0);
      const cookie = requireCookie(response);
      const identity = readSessionIdentity(cookieToken(cookie));
      assert.equal(identity?.id, 'github-123456');
      assert.equal(identity?.provider, 'github');
      assert.equal(identity?.name, githubUser.name);
      assertCookie(response, sessionCookieName, 172800);
      assertPrivate(response, [calls[0].code, calls[0].codeVerifier, upstreamToken]);
      const payload = Buffer.from(cookieToken(cookie).split('.')[0], 'base64url').toString('utf8');
      for (const value of [clientSecret, calls[0].code, calls[0].codeVerifier, upstreamToken]) {
        assert.equal(payload.includes(value), false, 'session payload must contain identity only');
      }
      const me = await app.inject({ url: '/auth/me', headers: { cookie } });
      assert.equal(me.statusCode, 200);
      assert.equal(me.json().userId, 'github-123456');
      assert.equal(me.json().provider, 'github');
      assertPrivate(me, [calls[0].code, upstreamToken]);
      const protectedResponse = await app.inject({
        url: '/external-auth-private',
        headers: { cookie },
      });
      assert.equal(protectedResponse.statusCode, 200);
      assert.equal(protectedResponse.json().uid, 'github-123456');
      assert.equal(protectedResponse.json().user.provider, 'github');
      const replay = await app.inject({
        url: callbackUrl(flow.state),
        headers: { cookie: flow.cookie },
      });
      assertRejected(replay, [calls[0].code]);
      assert.equal(calls.length, 1);
    },
  );

  await t.test(
    'GitHub falls back to login as name and cannot redirect outside the application',
    async (t) => {
      const { app } = await makeApp(t, async () => ({
        id: '234567',
        login: 'fallback-login',
        name: null,
      }));
      const flow = await beginGithub(app, '//evil.test');
      const response = await app.inject({
        url: callbackUrl(flow.state),
        headers: { cookie: flow.cookie },
      });
      assert.equal(response.statusCode, 303);
      assert.equal(response.headers.location, '/workbench');
      assert.equal(
        readSessionIdentity(cookieToken(requireCookie(response)))?.name,
        'fallback-login',
      );
    },
  );

  await t.test(
    'GitHub return defaults to workbench and preserves explicit home or SPA destinations',
    async (t) => {
      const { app } = await makeApp(t);
      for (const [returnTo, expected] of [
        [undefined, '/workbench'],
        ['', '/workbench'],
        ['/auth/me', '/workbench'],
        ['/', '/'],
        ['/?workspace=w&session=s', '/?workspace=w&session=s'],
        ['/plaza/p?ticket=remove&ref=github', '/plaza/p?ref=github'],
      ]) {
        const start = await app.inject(
          '/auth/github' +
            (returnTo === undefined ? '' : '?returnTo=' + encodeURIComponent(returnTo)),
        );
        assert.equal(start.statusCode, 302);
        const state = new URL(String(start.headers.location)).searchParams.get('state');
        assert.ok(state);
        const response = await app.inject({
          url: callbackUrl(state),
          headers: { cookie: requireCookie(start, oauthCookieName) },
        });
        assert.equal(response.statusCode, 303);
        assert.equal(response.headers.location, expected);
        assert.ok(readSessionIdentity(cookieToken(requireCookie(response))));
      }
    },
  );

  await t.test(
    'GitHub rejects missing state, unknown state, missing cookie and another browser cookie before exchange',
    async (t) => {
      let calls = 0;
      const { app } = await makeApp(t, async () => {
        calls++;
        return githubUser;
      });
      const browserA = await beginGithub(app);
      const browserB = await beginGithub(app);
      for (const request of [
        { url: '/auth/github/callback?code=private-code', headers: { cookie: browserA.cookie } },
        { url: callbackUrl('unknown-state'), headers: { cookie: browserA.cookie } },
        { url: callbackUrl(browserA.state) },
        { url: callbackUrl(browserB.state), headers: { cookie: browserA.cookie } },
      ]) {
        assertRejected(await app.inject(request), [
          'private-code',
          'offline-authorization-code-DO-NOT-EXPOSE',
        ]);
      }
      assert.equal(calls, 0);
    },
  );

  await t.test(
    'guest POST renews an expired browser with a new identity and never revives a forged cookie',
    async (t) => {
      const { app } = await makeApp(t);
      const expired = createExternalSession(
        { id: guestId, name: 'Old Guest', provider: 'guest' },
        Date.now() - 3601000,
      );
      for (const token of [expired, 'forged']) {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/guest',
          headers: { origin, cookie: sessionCookieName + '=' + token },
          payload: { id: guestId },
        });
        assert.equal(response.statusCode, 303);
        const identity = readSessionIdentity(cookieToken(requireCookie(response)));
        assert.ok(identity);
        assert.match(identity.id, guestPattern);
        assert.notEqual(identity.id, guestId);
      }
    },
  );

  await t.test('GitHub callback without code cannot authenticate or reuse its state', async (t) => {
    let calls = 0;
    const { app } = await makeApp(t, async () => {
      calls++;
      return githubUser;
    });
    const flow = await beginGithub(app);
    assertRejected(
      await app.inject({
        url: '/auth/github/callback?state=' + encodeURIComponent(flow.state),
        headers: { cookie: flow.cookie },
      }),
    );
    assertRejected(
      await app.inject({ url: callbackUrl(flow.state), headers: { cookie: flow.cookie } }),
    );
    assert.equal(calls, 0);
  });

  await t.test('concurrent callbacks cannot reuse one GitHub state', async (t) => {
    let calls = 0;
    const { app } = await makeApp(t, async () => {
      calls++;
      return githubUser;
    });
    const flow = await beginGithub(app);
    const responses = await Promise.all(
      [0, 1].map(() =>
        app.inject({ url: callbackUrl(flow.state), headers: { cookie: flow.cookie } }),
      ),
    );
    assert.equal(responses.filter((response) => cookiePair(response)).length, 1);
    assert.equal(calls, 1);
    assertRejected(responses.find((response) => !cookiePair(response))!);
  });

  await t.test('expired Redis state is rejected without code exchange', async (t) => {
    let calls = 0;
    const { app, redis } = await makeApp(t, async () => {
      calls++;
      return githubUser;
    });
    const flow = await beginGithub(app);
    for (const entry of redis.entries.values()) entry.expiresAt = Date.now() - 1;
    assertRejected(
      await app.inject({ url: callbackUrl(flow.state), headers: { cookie: flow.cookie } }),
    );
    assert.equal(calls, 0);
  });

  await t.test(
    'GitHub cancellation consumes state, skips exchange and renders a safe failure page',
    async (t) => {
      let calls = 0;
      const { app } = await makeApp(t, async () => {
        calls++;
        return githubUser;
      });
      const flow = await beginGithub(app);
      const description = '<script>private-cancel-description</script>';
      const response = await app.inject({
        url:
          '/auth/github/callback?' +
          new URLSearchParams({
            state: flow.state,
            error: 'access_denied',
            error_description: description,
          }),
        headers: { cookie: flow.cookie },
      });
      await assertFailurePage(app, response, [description, 'private-cancel-description']);
      assert.equal(calls, 0);
      assertRejected(
        await app.inject({ url: callbackUrl(flow.state), headers: { cookie: flow.cookie } }),
      );
      assert.equal(calls, 0);
    },
  );

  await t.test(
    'GitHub upstream errors never leak code, token, verifier, client secret or raw exception',
    async (t) => {
      const privateCode = 'sensitive-upstream-code';
      const privateToken = 'gho_sensitive-upstream-token';
      const privateError = '<script>private-upstream-error</script>';
      let calls = 0;
      let verifier = '';
      const { app } = await makeApp(t, async (input) => {
        calls++;
        verifier = input.codeVerifier;
        throw new Error(
          [privateError, privateCode, privateToken, clientSecret, verifier].join(' '),
        );
      });
      const flow = await beginGithub(app);
      const response = await app.inject({
        url: callbackUrl(flow.state, privateCode),
        headers: { cookie: flow.cookie },
      });
      await assertFailurePage(app, response, [privateCode, privateToken, privateError, verifier]);
      assert.equal(calls, 1);
      assertRejected(
        await app.inject({
          url: callbackUrl(flow.state, privateCode),
          headers: { cookie: flow.cookie },
        }),
        [privateCode],
      );
      assert.equal(calls, 1);
    },
  );

  await t.test(
    'GitHub rejects nonnumeric upstream IDs rather than trusting a login or client id',
    async (t) => {
      for (const id of ['octocat', 'guest-' + randomUUID(), '123/../../admin', '', '1e3']) {
        const { app } = await makeApp(t, async () => ({ ...githubUser, id }));
        const flow = await beginGithub(app);
        const response = await app.inject({
          url: callbackUrl(flow.state) + '&id=123456',
          headers: { cookie: flow.cookie },
        });
        assertRejected(response);
      }
    },
  );

  await t.test(
    'disabling GitHub rejects an in-flight callback before exchange and invalidates /auth/me',
    async (t) => {
      let calls = 0;
      const { app } = await makeApp(t, async () => {
        calls++;
        return githubUser;
      });
      const flow = await beginGithub(app);
      const token = createExternalSession({
        id: 'github-123456',
        name: 'Octocat',
        provider: 'github',
      });
      projectConfig.auth.github!.enabled = false;
      assertRejected(
        await app.inject({ url: callbackUrl(flow.state), headers: { cookie: flow.cookie } }),
      );
      assert.equal(calls, 0);
      assert.equal(
        (
          await app.inject({
            url: '/auth/me',
            headers: { cookie: sessionCookieName + '=' + token },
          })
        ).statusCode,
        401,
      );
    },
  );

  await t.test(
    'Redis write and atomic-read failures return 503 without exposing connection details',
    async (t) => {
      let calls = 0;
      const { app, redis } = await makeApp(t, async () => {
        calls++;
        return githubUser;
      });
      redis.failSet = true;
      const begin = await app.inject('/auth/github');
      assert.equal(begin.statusCode, 503);
      assertRejected(begin, ['redis-private-connection-DO-NOT-EXPOSE']);
      redis.failSet = false;
      const flow = await beginGithub(app);
      redis.failGetDel = true;
      const response = await app.inject({
        url: callbackUrl(flow.state),
        headers: { cookie: flow.cookie },
      });
      assert.equal(response.statusCode, 503);
      assertRejected(response, ['redis-private-connection-DO-NOT-EXPOSE']);
      assert.equal(calls, 0);
    },
  );
});
