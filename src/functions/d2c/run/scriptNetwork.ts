/** 生成可信脚本的网络封装；生产默认限制主机，script 模式仅供独立本地调试。 */
export function createScriptNetworkPrelude(mode: 'server' | 'script' = 'server', tracePrefix = '') {
  return `
import { writeFileSync, rmSync } from 'node:fs';
const failures = new Map();
const diagnostic = (key, value) => {
  if (value) failures.set(key, value); else failures.delete(key);
  const unresolved = [...failures.values()];
  const selected = unresolved.find(item => item.statusCode === 401 || item.statusCode === 403) || unresolved[0];
  if (selected) writeFileSync(process.env.PIXELPRINT_NETWORK_DIAGNOSTIC, JSON.stringify(selected));
  else rmSync(process.env.PIXELPRINT_NETWORK_DIAGNOSTIC, {force:true});
};
const tracePrefix = ${JSON.stringify(tracePrefix)};
const trace = (phase, url, details = {}) => {
  if (tracePrefix) process.stderr.write(tracePrefix + JSON.stringify({phase,host:url.hostname,...details}) + '\\n');
};
const originalFetch = globalThis.fetch;
const hosts = JSON.parse(process.env.PIXELPRINT_ALLOWED_HOSTS);
const maximum = Number(process.env.PIXELPRINT_NETWORK_BYTES);
let notBefore = 0;
let waitRequiresUser = false;
globalThis.fetch = async (value, options = {}) => {
  const url = new URL(value instanceof Request ? value.url : value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('外网地址格式无效');
  if (${mode === 'server'} && !hosts.some(host => host.startsWith('*.') ? url.hostname.endsWith(host.slice(1)) && url.hostname !== host.slice(2) : url.hostname === host)) { trace('blocked', url, {code:'HOST_NOT_ALLOWED'}); throw new Error('外网目标未授权'); }
  const headers = new Headers(options.headers);
  if (url.hostname !== 'api.figma.com' && headers.has('X-Figma-Token')) throw new Error('凭据不能发送到资源域名');
  if (waitRequiresUser) throw new Error('目标服务要求稍后再试');
  if (Date.now() < notBefore) { trace('waiting', url, {retryAfterMs:notBefore-Date.now()}); await new Promise(resolve => setTimeout(resolve, notBefore - Date.now())); }
  const signal = AbortSignal.any([AbortSignal.timeout(30000), ...(options.signal ? [options.signal] : [])]);
  trace('request', url);
  let response;
  try { response = await originalFetch(url, { ...options, headers, redirect: 'manual', signal }); }
  catch (error) {
    const code = [error?.cause?.code, error?.code, error?.name].find(value => typeof value === 'string');
    diagnostic(url.href, {code: typeof code === 'string' ? code : ''});
    trace('error', url, {code: typeof code === 'string' ? code : ''});
    throw error;
  }
  trace('response', url, {statusCode:response.status});
  if (!response.ok) {
    const raw = response.headers.get('retry-after');
    const retry = Number(raw);
    const retryAfterMs = Number.isFinite(retry) ? Math.max(0, Math.ceil(retry * 1000)) : Math.max(0, Date.parse(raw) - Date.now()) || 0;
    if (response.status === 429) {
      if (retryAfterMs > 300000) waitRequiresUser = true;
      else notBefore = Date.now() + retryAfterMs;
    }
    diagnostic(url.href, {statusCode:response.status, retryAfterMs});
  } else diagnostic(url.href, null);
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('不接受外网重定向'); }
  let total = 0;
  const reader = response.body?.getReader();
  const body = reader ? new ReadableStream({ async pull(controller) {
    try {
      const {done, value} = await reader.read();
      if (done) { trace('body_complete', url, {bytes:total}); controller.close(); return; }
      total += value.byteLength;
      if (total > maximum) { await reader.cancel(); throw new Error('外网响应超过限额'); }
      controller.enqueue(value);
    } catch (error) {
      const code = signal.aborted ? 'TimeoutError' : [error?.cause?.code, error?.code, error?.name].find(value => typeof value === 'string');
      diagnostic(url.href, {code: typeof code === 'string' ? code : ''});
    trace('error', url, {code: typeof code === 'string' ? code : ''});
      controller.error(error);
    }
  }, cancel(reason) { return reader.cancel(reason); } }) : null;
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};
`;
}
