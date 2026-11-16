import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

export const previewDebuggerAsset = '__pixelprint_tools/eruda-3.4.3.js';
let bundle: Promise<Buffer> | undefined;

/** Eruda 设置仅留在当前页面内存；opaque iframe 无持久存储权限，生成页面的全局对象保持原样。 */
function debuggerStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(String(key)) ?? null,
    setItem: (key, value) => void values.set(String(key), String(value)),
    removeItem: (key) => void values.delete(String(key)),
    clear: () => values.clear(),
  };
}

/** 适配固定依赖的存储访问，只在库的闭包内提供内存 Storage，升级依赖时必须重新验证。 */
export function isolateDebuggerStorage(source: string) {
  if (!source.includes('window.localStorage') || !source.includes('window.sessionStorage'))
    throw new Error('DEBUGGER_STORAGE_ADAPTER_MISMATCH');
  const isolated = source
    .replaceAll('window.localStorage', 'localStorage')
    .replaceAll('window.sessionStorage', 'sessionStorage');
  return Buffer.from(
    `/* Eruda 3.4.3, MIT; settings isolated to this preview document. */\n(function(){const __name=(value)=>value;(function(localStorage,sessionStorage){\n${isolated}\n})((${debuggerStorage.toString()})(),(${debuggerStorage.toString()})());})();`,
  );
}

/** 固定 npm 依赖由服务端分发；仅在经过预览票据校验后的请求内读取。 */
export function readPreviewDebugger() {
  bundle ??= readFile(createRequire(import.meta.url).resolve('eruda/eruda.js'), 'utf8')
    .then(isolateDebuggerStorage)
    .catch((error) => {
      bundle = undefined;
      throw error;
    });
  return bundle;
}

/** 此函数序列化后在 opaque iframe 内执行，调试面板只在收到父窗口命令后加载。 */
function installDebugger(parentOrigin: string, assetUrl: string, nonce: string) {
  let channel = '';
  let desired = false;
  let loaded = false;
  let pending: HTMLScriptElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  type Eruda = {
    init: (options: Record<string, unknown>) => void;
    show: (name?: string) => void;
    hide: () => void;
    destroy: () => void;
    get: (name?: string) => {
      hide?: () => void;
      on?: (event: string, listener: () => void) => void;
    };
  };
  const api = () => (window as unknown as { eruda?: Eruda }).eruda;

  function report(status: 'loading' | 'open' | 'closed' | 'failed') {
    window.parent.postMessage({ type: 'pixelprint:debug-state', channel, status }, parentOrigin);
  }

  /** 失败仅报告固定状态，允许用户重新加载；原始异常不发送到工作台。 */
  function fail() {
    clearTimeout(timer);
    pending?.remove();
    pending = undefined;
    try {
      api()?.destroy();
    } catch {}
    loaded = false;
    report(desired ? 'failed' : 'closed');
  }

  function show() {
    if (loaded) {
      if (desired) {
        api()!.show();
        api()!.show('elements');
      } else api()!.hide();
      report(desired ? 'open' : 'closed');
      return;
    }
    if (!desired) {
      report('closed');
      return;
    }
    if (pending) return;
    report('loading');
    const script = document.createElement('script');
    pending = script;
    script.src = assetUrl;
    script.nonce = nonce;
    script.referrerPolicy = 'no-referrer';
    script.onload = () => {
      if (pending !== script) return;
      clearTimeout(timer);
      pending = undefined;
      try {
        const eruda = api();
        if (!eruda) throw new Error('DEBUGGER_UNAVAILABLE');
        eruda.init({
          tool: ['elements', 'console', 'network', 'sources'],
          useShadowDom: true,
          autoScale: false,
          defaults: { displaySize: 60, theme: 'Light' },
        });
        eruda.get('entryBtn')?.hide?.();
        eruda.get()?.on?.('hide', () => {
          desired = false;
          report('closed');
        });
        loaded = true;
        show();
      } catch {
        fail();
      }
    };
    script.onerror = () => {
      if (pending === script) fail();
    };
    timer = setTimeout(fail, 15000);
    document.head.append(script);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== parentOrigin) return;
    const value = event.data;
    if (
      !value ||
      value.type !== 'pixelprint:debug-command' ||
      typeof value.channel !== 'string' ||
      !/^[a-zA-Z0-9_-]{16,100}$/.test(value.channel) ||
      typeof value.enabled !== 'boolean'
    )
      return;
    channel = value.channel;
    desired = value.enabled;
    show();
  });
  window.addEventListener(
    'pagehide',
    () => {
      clearTimeout(timer);
      pending?.remove();
      pending = undefined;
      try {
        if (loaded) api()?.destroy();
      } catch {}
    },
    { once: true },
  );
}

/** 使用现有响应 nonce 注入小型加载器；保持缓存产物和 CSP 原样。 */
export function previewDebuggerScript(parentOrigin: string, assetUrl: string, nonce: string) {
  const origin = new URL(parentOrigin).origin;
  const url = new URL(assetUrl);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.origin !== origin ||
    !url.pathname.endsWith(`/${previewDebuggerAsset}`) ||
    url.search ||
    url.hash ||
    !/^[a-zA-Z0-9_-]+$/.test(nonce)
  )
    throw new Error('INVALID_DEBUGGER_ASSET');
  const args = [url.pathname, nonce].map((value) => JSON.stringify(value).replace(/</g, '\\u003c'));
  return `<script nonce="${nonce}" data-pixelprint-debugger>{const __name=(value)=>value;(${installDebugger.toString()})(window.location.origin,new URL(${args[0]},window.location.href).href,${args[1]});}</script>`;
}
