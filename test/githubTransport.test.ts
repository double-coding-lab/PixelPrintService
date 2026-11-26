import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { projectConfig } from '../src/config/project';
import { exchangeGitHubCode } from '../src/hooks/http/github';

/** 使用官方端点的离线网络替身，核对授权码/PKCE交换及匹配的 Undici 传输。 */
test('GitHub transport validates official responses and does not mix the native fetch dispatcher', async (t) => {
  const original = projectConfig.auth.github;
  const proxy = projectConfig.network.proxyUrl;
  const dispatcher = getGlobalDispatcher();
  projectConfig.auth.github = {
    enabled: true,
    clientId: 'test-oauth-client',
    clientSecret: 'test-oauth-secret',
  };
  projectConfig.network.proxyUrl = '';
  t.after(() => {
    projectConfig.auth.github = original;
    projectConfig.network.proxyUrl = proxy;
    setGlobalDispatcher(dispatcher);
  });
  const input = {
    code: 'test-authorization-code',
    codeVerifier: 'test-verifier',
    redirectUri: 'https://app.example.test/auth/github/callback',
  };
  for (const mode of ['success', 'token-denied', 'profile-invalid', 'redirect', 'oversized']) {
    await t.test(mode, async (t) => {
      const agent = new MockAgent();
      agent.disableNetConnect();
      setGlobalDispatcher(agent);
      t.after(() => agent.close());
      t.mock.method(globalThis, 'fetch', () => {
        throw new Error('native fetch must not receive an external dispatcher');
      });
      let sent = '';
      const github = agent.get('https://github.com');
      github.intercept({ path: '/login/oauth/access_token', method: 'POST' }).reply((options) => {
        sent = String(options.body);
        return {
          statusCode: 200,
          data: JSON.stringify(
            mode === 'token-denied'
              ? { error: 'bad_verification_code' }
              : { access_token: 'test-only-github-token' },
          ),
        };
      });
      if (mode !== 'token-denied') {
        const profile = agent.get('https://api.github.com');
        profile
          .intercept({
            path: '/user',
            method: 'GET',
            headers: { authorization: 'Bearer test-only-github-token' },
          })
          .reply(
            mode === 'redirect' ? 302 : 200,
            mode === 'oversized'
              ? 'x'.repeat(70000)
              : JSON.stringify({
                  id: mode === 'profile-invalid' ? '123' : 123,
                  login: 'octocat-test',
                  name: 'Test User',
                }),
            mode === 'redirect' ? { headers: { location: 'https://untrusted.example.test/' } } : {},
          );
      }
      if (mode === 'success')
        assert.deepEqual(await exchangeGitHubCode(input), {
          id: '123',
          login: 'octocat-test',
          name: 'Test User',
        });
      else await assert.rejects(exchangeGitHubCode(input));
      const form = new URLSearchParams(sent);
      assert.equal(form.get('client_id'), 'test-oauth-client');
      assert.equal(form.get('client_secret'), 'test-oauth-secret');
      assert.equal(form.get('code'), input.code);
      assert.equal(form.get('code_verifier'), input.codeVerifier);
      assert.equal(form.get('redirect_uri'), input.redirectUri);
      agent.assertNoPendingInterceptors();
    });
  }
});
