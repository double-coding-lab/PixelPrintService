import { fetch, ProxyAgent, type RequestInit } from 'undici';
import { projectConfig } from '@/config/project';

export type GitHubProfile = { id: string; login: string; name: string | null };
export type GitHubExchange = (input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}) => Promise<GitHubProfile>;

/** 只访问固定 GitHub 官方端点；授权码、访问令牌和上游错误正文保持进程内私有。 */
export const exchangeGitHubCode: GitHubExchange = async (input) => {
  const config = projectConfig.auth.github;
  if (!config?.enabled) throw new Error('GitHub login unavailable');
  const dispatcher = projectConfig.network.proxyUrl
    ? new ProxyAgent(projectConfig.network.proxyUrl)
    : undefined;
  const signal = AbortSignal.timeout(15000);
  async function request(url: string, init: RequestInit) {
    const response = await fetch(url, {
      ...init,
      signal,
      redirect: 'error',
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('GitHub request failed');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('GitHub response invalid');
    const parts: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 65536) throw new Error('GitHub response invalid');
        parts.push(part.value);
      }
      return JSON.parse(Buffer.concat(parts).toString('utf8'));
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  try {
    const token = await request('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'PixelPrint',
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
      }),
    });
    if (
      typeof token.access_token !== 'string' ||
      !token.access_token ||
      token.access_token.length > 4096 ||
      /[\u0000-\u0020\u007f]/u.test(token.access_token)
    )
      throw new Error('GitHub authorization failed');
    const profile = await request('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'PixelPrint',
        Authorization: `Bearer ${token.access_token}`,
      },
    });
    if (
      !Number.isSafeInteger(profile.id) ||
      profile.id <= 0 ||
      typeof profile.login !== 'string' ||
      !/^[A-Za-z0-9-]{1,39}$/.test(profile.login)
    )
      throw new Error('GitHub identity invalid');
    return {
      id: String(profile.id),
      login: profile.login,
      name: typeof profile.name === 'string' ? profile.name : null,
    };
  } finally {
    await dispatcher?.close();
  }
};
