import { previewDebuggerScript } from './debugger';

/** 注入在预览页面内执行的只读点选器；不访问主站DOM、不请求接口、不修改生成源码。 */
function installInspector() {
  if (window.parent === window) return;
  /** 预览由同源主站嵌入；使用浏览器地址，避免 HTTPS 网关后的内部 HTTP 地址导致握手失败。 */
  const parentOrigin = window.location.origin;
  let enabled = false;
  let channel = '';
  let hovered: Element | null = null;
  let pinned: Element | null = null;
  let hoverVisible = false;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  /** 更换目标、退出或滚动时取消旧目标的延迟展示。 */
  function cancelHover() {
    clearTimeout(hoverTimer);
    hoverTimer = undefined;
  }
  const overlay = document.createElement('div');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #4478d7;background:rgba(68,120,215,.12);box-sizing:border-box;display:none;';
  document.documentElement.append(overlay);

  /** 只向创建此iframe的主站窗口发送展示字段，绝不传递HTML或表单值。 */
  function send(value: Record<string, unknown>) {
    window.parent.postMessage({ ...value, channel }, parentOrigin);
  }

  /** 临时详情随鼠标离开立即收起，点击固定的详情由退出操作释放。 */
  function hideHover() {
    cancelHover();
    if (hoverVisible) send({ type: 'pixelprint:inspect-clear' });
    hoverVisible = false;
  }

  /** 悬停与点击使用独立模式，父页面据此决定浮窗生命周期。 */
  function publish(element: Element, mode: 'hover' | 'pinned') {
    hoverVisible = mode === 'hover';
    send({ type: 'pixelprint:inspect-element', mode, element: describe(element) });
  }

  /** 高亮层为固定定位，不参加页面布局；失效目标与关闭状态均隐藏。 */
  function highlight(element: Element | null) {
    hovered = element;
    if (!enabled || !element?.isConnected) {
      overlay.style.display = 'none';
      return;
    }
    const rect = element.getBoundingClientRect();
    Object.assign(overlay.style, {
      display: 'block',
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  /** 组合可复制的短选择器，处理数字、冒号等需要CSS转义的名称。 */
  function selector(element: Element) {
    const parts: string[] = [];
    let current: Element | null = element;
    for (let depth = 0; current && depth < 5; depth++, current = current.parentElement) {
      const tag = current.localName;
      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id).slice(0, 200)}`);
        break;
      }
      const classes = [...current.classList]
        .slice(0, 3)
        .map((name) => `.${CSS.escape(name).slice(0, 200)}`)
        .join('');
      let part = tag + classes;
      if (current.parentElement) {
        const siblings = [...current.parentElement.children].filter(
          (node) => node.localName === tag,
        );
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
    }
    return parts.join(' > ').slice(0, 2000);
  }

  /** 提取DOM类名与常用计算样式；RN Web同样展示其实际DOM，不虚构源码类名。 */
  function describe(element: Element) {
    const rect = element.getBoundingClientRect();
    const computed = getComputedStyle(element);
    const names = [
      'display',
      'position',
      'color',
      'background-color',
      'font-size',
      'font-weight',
      'line-height',
      'width',
      'height',
      'margin',
      'padding',
      'gap',
      'flex-direction',
      'align-items',
      'justify-content',
      'border-radius',
    ];
    return {
      tagName: element.localName.slice(0, 100),
      id: element.id.slice(0, 500),
      className: (element.getAttribute('class') ?? '').slice(0, 4000),
      nodeId: (element.getAttribute('data-node-id') ?? '').slice(0, 200),
      selector: selector(element),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      styles: Object.fromEntries(
        names.map((name) => [name, computed.getPropertyValue(name).slice(0, 500)]),
      ),
    };
  }

  /** 只接受主窗口、主站origin及固定消息形状，opaque iframe通过显式握手频道隔离实例。 */
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== parentOrigin) return;
    const value = event.data;
    if (
      !value ||
      value.type !== 'pixelprint:inspect-command' ||
      typeof value.channel !== 'string' ||
      !/^[a-zA-Z0-9_-]{16,100}$/.test(value.channel) ||
      typeof value.enabled !== 'boolean'
    )
      return;
    if (channel !== value.channel || !value.enabled || value.clearSelection === true) pinned = null;
    channel = value.channel;
    enabled = value.enabled;
    hideHover();
    highlight(enabled ? pinned : null);
    send({ type: 'pixelprint:inspect-state', enabled });
  });
  document.addEventListener(
    'pointermove',
    (event) => {
      if (!enabled || pinned || !(event.target instanceof Element) || event.target === overlay)
        return;
      if (event.target === hovered) return;
      hideHover();
      const target = event.target;
      highlight(target);
      hoverTimer = setTimeout(() => {
        hoverTimer = undefined;
        if (enabled && hovered === target && target.isConnected) publish(target, 'hover');
      }, 450);
    },
    true,
  );
  document.addEventListener(
    'click',
    (event) => {
      if (!enabled || !(event.target instanceof Element) || event.target === overlay) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelHover();
      pinned = event.target;
      highlight(pinned);
      publish(pinned, 'pinned');
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (enabled && event.key === 'Escape') {
        pinned = null;
        hideHover();
        highlight(null);
        send({ type: 'pixelprint:inspect-dismiss' });
      }
    },
    true,
  );
  document.addEventListener(
    'pointerout',
    (event) => {
      if (!pinned && (!event.relatedTarget || event.target === hovered)) {
        hideHover();
        highlight(null);
      }
    },
    true,
  );
  window.addEventListener(
    'scroll',
    () => {
      hideHover();
      highlight(pinned);
      if (pinned?.isConnected) publish(pinned, 'pinned');
    },
    true,
  );
  window.addEventListener('resize', () => {
    hideHover();
    highlight(pinned);
    if (pinned?.isConnected) publish(pinned, 'pinned');
  });
  window.addEventListener(
    'pagehide',
    () => {
      cancelHover();
      overlay.remove();
    },
    { once: true },
  );
  send({ type: 'pixelprint:inspect-ready' });
}

/** 读取已校验HTML后附加每次响应独立nonce的可信脚本，不改变缓存或版本摘要。 */
export function injectPreviewInspector(
  content: Buffer,
  parentOrigin: string,
  nonce: string,
  debuggerUrl?: string,
) {
  if (!/^[a-zA-Z0-9_-]+$/.test(nonce)) throw new Error('INVALID_INSPECTOR_NONCE');
  const origin = new URL(parentOrigin).origin;
  if (!/^https?:$/.test(new URL(origin).protocol)) throw new Error('INVALID_INSPECTOR_ORIGIN');
  /** tsx开发编译会给内层函数加入__name；运行环境不依赖宿主编译器辅助函数。 */
  const script =
    (debuggerUrl ? previewDebuggerScript(origin, debuggerUrl, nonce) : '') +
    `<script nonce="${nonce}" data-pixelprint-inspector>{const __name=(value)=>value;(${installInspector.toString()})();}</script>`;
  /** 基础留白由工作台外层承担；低优先级重置允许生成页面显式定义自身布局。 */
  const baseline =
    '<style data-pixelprint-preview-base>:where(html,body){margin:0;padding:0}</style>';
  const html = content.toString('utf8').replace(/<head(?:\s[^>]*)?>/i, (head) => head + baseline);
  const closingBody = /<\/body\s*>\s*(?:<\/html\s*>)?\s*$/i.exec(html);
  return Buffer.from(
    closingBody
      ? html.slice(0, closingBody.index) + script + html.slice(closingBody.index)
      : html + script,
  );
}
