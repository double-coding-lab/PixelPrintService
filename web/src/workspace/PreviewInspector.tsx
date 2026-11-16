import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from 'antd';
import Icon from '../components/Icon';
import PreviewDebugger from './PreviewDebugger';

/** 从当前元素真实 className 读取末尾类名，不把祖先选择器或伪类当作类名。 */
export function lastInspectorClassName(className: string): string {
  return (
    className
      .split(/[\t\n\f\r ]+/)
      .filter(Boolean)
      .at(-1) ?? ''
  );
}

export type InspectorSourceRequest = { query: string; property?: string };

/** 用真实 DOM 标识发起源码候选查找；计算样式不等同源码位置映射。 */
export function inspectorSourceRequest(
  element: InspectedElement,
  property?: string,
): InspectorSourceRequest {
  return {
    query:
      lastInspectorClassName(element.className) ||
      element.id ||
      element.nodeId ||
      property ||
      element.tagName,
    ...(property ? { property } : {}),
  };
}

export const inspectorStyleNames = [
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
] as const;

export type InspectedElement = {
  tagName: string;
  id: string;
  className: string;
  nodeId: string;
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
};
type InspectorMode = 'hover' | 'pinned';
type InspectorAnchor = { x: number; y: number };
/** 将iframe视口坐标换算为主站坐标，包含边框及CSS缩放。 */
export function inspectorElementAnchor(
  frame: HTMLIFrameElement,
  rect: InspectedElement['rect'],
): InspectorAnchor {
  const bounds = frame.getBoundingClientRect();
  const scaleX = frame.offsetWidth ? bounds.width / frame.offsetWidth : 1;
  const scaleY = frame.offsetHeight ? bounds.height / frame.offsetHeight : 1;
  return {
    x: bounds.left + (frame.clientLeft + rect.x) * scaleX,
    y: bounds.top + (frame.clientTop + rect.y) * scaleY,
  };
}

/** 浮窗优先位于元素左上方，空间不足时收回到可见视口。 */
export function inspectorPanelPosition(
  anchor: InspectorAnchor,
  width: number,
  height: number,
  viewport: { width: number; height: number },
) {
  return {
    left: Math.max(12, Math.min(anchor.x - width - 8, viewport.width - width - 12)),
    top: Math.max(12, Math.min(anchor.y - height - 8, viewport.height - height - 12)),
  };
}
export type InspectorMessage =
  | { type: 'pixelprint:inspect-ready' }
  | { type: 'pixelprint:inspect-state'; channel: string; enabled: boolean }
  | { type: 'pixelprint:inspect-clear'; channel: string }
  | { type: 'pixelprint:inspect-dismiss'; channel: string }
  | {
      type: 'pixelprint:inspect-element';
      channel: string;
      element: InspectedElement;
      mode: InspectorMode;
    };

/** 仅接受结构化对象和协议指定字段，限制从隔离页面传入的内容大小。 */
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 只允许当前消息类型声明的字段。 */
function keys(value: Record<string, unknown>, names: string[]) {
  return (
    Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name))
  );
}

/** 文本按字段限长，保留真实 DOM 类名而不转换为源码类名。 */
function textWithin(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

/** 校验消息来源、opaque origin、随机通道及有界负载；ready 只按当前窗口握手。 */
export function validateInspectorMessage(
  event: Pick<MessageEvent, 'source' | 'origin' | 'data'>,
  currentWindow: Window | null,
  channel: string,
): InspectorMessage | null {
  if (!currentWindow || event.source !== currentWindow || event.origin !== 'null') return null;
  const value: unknown = event.data;
  if (!record(value)) return null;
  if (value.type === 'pixelprint:inspect-ready') {
    return keys(value, ['type']) || (keys(value, ['type', 'channel']) && value.channel === '')
      ? { type: value.type }
      : null;
  }
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(channel) || value.channel !== channel) return null;
  if (value.type === 'pixelprint:inspect-state') {
    return keys(value, ['type', 'channel', 'enabled']) && typeof value.enabled === 'boolean'
      ? { type: value.type, channel, enabled: value.enabled }
      : null;
  }
  if (value.type === 'pixelprint:inspect-clear' || value.type === 'pixelprint:inspect-dismiss')
    return keys(value, ['type', 'channel']) ? { type: value.type, channel } : null;
  const legacy = keys(value, ['type', 'channel', 'element']);
  if (
    value.type !== 'pixelprint:inspect-element' ||
    (!legacy &&
      (!keys(value, ['type', 'channel', 'element', 'mode']) ||
        (value.mode !== 'hover' && value.mode !== 'pinned')))
  )
    return null;
  const element = value.element;
  if (
    !record(element) ||
    !keys(element, ['tagName', 'id', 'className', 'nodeId', 'selector', 'rect', 'styles'])
  )
    return null;
  if (
    !textWithin(element.tagName, 100) ||
    !element.tagName ||
    !textWithin(element.id, 500) ||
    !textWithin(element.className, 4000) ||
    !textWithin(element.nodeId, 200) ||
    !textWithin(element.selector, 2000)
  )
    return null;
  const rect = element.rect;
  if (!record(rect) || !keys(rect, ['x', 'y', 'width', 'height'])) return null;
  for (const name of ['x', 'y', 'width', 'height']) {
    const number = rect[name];
    if (typeof number !== 'number' || !Number.isFinite(number)) return null;
  }
  if ((rect.width as number) < 0 || (rect.height as number) < 0) return null;
  if (!record(element.styles) || Object.keys(element.styles).length > inspectorStyleNames.length)
    return null;
  const styles: Record<string, string> = {};
  for (const [name, value] of Object.entries(element.styles)) {
    if (!(inspectorStyleNames as readonly string[]).includes(name) || !textWithin(value, 500))
      return null;
    styles[name] = value;
  }
  return {
    type: value.type,
    channel,
    mode: legacy ? 'pinned' : (value.mode as InspectorMode),
    element: {
      tagName: element.tagName,
      id: element.id,
      className: element.className,
      nodeId: element.nodeId,
      selector: element.selector,
      rect: {
        x: rect.x as number,
        y: rect.y as number,
        width: rect.width as number,
        height: rect.height as number,
      },
      styles,
    },
  };
}

/** 每次绑定生成独立的密码学随机通道，SSR 期间不访问浏览器 API。 */
export function createInspectorChannel(crypto: Pick<Crypto, 'getRandomValues'>) {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** 单一可见 iframe 的生命周期；独立导出以验证握手、重新加载与解绑行为。 */
export function bindPreviewInspector({
  frame,
  host,
  channel,
  enabled,
  isCurrent,
  onElement,
  onEnabled,
  onClose,
}: {
  frame: HTMLIFrameElement;
  host: Window;
  channel: string;
  enabled: boolean;
  isCurrent: () => boolean;
  onElement: (element: InspectedElement | null, mode?: InspectorMode) => void;
  onEnabled: (enabled: boolean) => void;
  onClose: () => void;
}) {
  let disposed = false;
  /** 同时识别浏览器标签页与保留挂载的 Ant Tabs 隐藏面板。 */
  function visible() {
    if (host.document.hidden) return false;
    for (let node: HTMLElement | null = frame; node; node = node.parentElement) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
      const style = host.getComputedStyle(node);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse'
      )
        return false;
    }
    return true;
  }
  let picking = enabled && visible();
  let lastSelection: { element: InspectedElement; mode: InspectorMode } | null = null;
  /** opaque iframe 必须使用星号目标域，接收侧仍严格验证窗口和通道。 */
  function send(value: boolean, clearSelection = false) {
    frame.contentWindow?.postMessage(
      {
        type: 'pixelprint:inspect-command',
        channel,
        enabled: value,
        ...(clearSelection ? { clearSelection: true } : {}),
      },
      '*',
    );
  }
  /** 隐藏或失效的 iframe 立即失去消息接收资格。 */
  function current() {
    return !disposed && isCurrent() && visible();
  }
  /** 页面实际加载及 ready 握手均同步当前状态，覆盖加载早于 effect 的情况。 */
  function refresh() {
    if (!current()) return;
    lastSelection = null;
    onElement(null);
    send(picking);
  }
  /** 只处理当前可见窗口的消息及当前点选状态。 */
  function receive(event: MessageEvent) {
    if (!current()) return;
    const message = validateInspectorMessage(event, frame.contentWindow, channel);
    if (!message) return;
    if (message.type === 'pixelprint:inspect-ready') refresh();
    else if (message.type === 'pixelprint:inspect-state') {
      /** 旧的启用回执不能在用户关闭后重新启动点选。 */
      if (!message.enabled) {
        picking = false;
        onEnabled(false);
        onElement(null);
        onClose();
      }
    } else if (message.type === 'pixelprint:inspect-dismiss') {
      lastSelection = null;
      onElement(null);
    } else if (message.type === 'pixelprint:inspect-clear') {
      if (lastSelection?.mode !== 'pinned') {
        lastSelection = null;
        onElement(null);
      }
    } else if (picking && (lastSelection?.mode !== 'pinned' || message.mode === 'pinned')) {
      lastSelection = { element: message.element, mode: message.mode };
      onElement(message.element, message.mode);
    }
  }
  /** 关闭整个审查模式，供隐藏与生命周期清理使用。 */
  function close() {
    picking = false;
    lastSelection = null;
    send(false);
    onElement(null);
    onEnabled(false);
    onClose();
  }
  /** 仅清除固定选中和浮窗，下一次悬停仍可审查。 */
  function dismiss() {
    if (!current()) return;
    lastSelection = null;
    onElement(null);
    send(picking, true);
  }
  /** 父窗口获得焦点时同样支持 Esc 收起浮窗。 */
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && current()) dismiss();
  }
  /** 浏览器切入后台时停止子页面捕获。 */
  function visibility() {
    if (host.document.hidden) close();
  }
  /** 主站滚动只换算iframe边界；固定选中继续跟随，临时悬停立即收起。 */
  function reposition() {
    if (!current() || !lastSelection) return;
    if (lastSelection.mode === 'pinned') onElement(lastSelection.element, 'pinned');
    else leaveFrame();
  }
  /** iframe边界离开由主站监听，覆盖浏览器未向子文档派发pointerout的情况。 */
  function leaveFrame() {
    if (!current() || lastSelection?.mode === 'pinned') return;
    lastSelection = null;
    onElement(null);
    send(picking);
  }
  /** 跨隔离iframe时部分浏览器仅向主站发送新pointermove，用它补全移出检测。 */
  function hostPointerMove(event: PointerEvent) {
    if (picking && event.target !== frame && lastSelection?.mode !== 'pinned') leaveFrame();
  }
  host.addEventListener('message', receive);
  host.addEventListener('keydown', keydown);
  host.addEventListener('scroll', reposition, true);
  host.addEventListener('resize', reposition);
  host.addEventListener('pointermove', hostPointerMove, true);
  host.document.addEventListener('visibilitychange', visibility);
  frame.addEventListener('load', refresh);
  frame.addEventListener('pointerleave', leaveFrame);
  const Observer = (host as Window & typeof globalThis).MutationObserver;
  const observer = Observer
    ? new Observer(() => {
        if (!visible()) close();
      })
    : null;
  for (let node: HTMLElement | null = frame; node; node = node.parentElement) {
    observer?.observe(node, {
      attributes: true,
      attributeFilter: ['hidden', 'aria-hidden', 'class', 'style'],
    });
  }
  if (!visible()) close();
  refresh();
  return {
    /** 按钮修改仅影响本次绑定，不读取 iframe DOM。 */
    setEnabled(value: boolean) {
      picking = value && current();
      lastSelection = null;
      onEnabled(picking);
      onElement(null);
      send(picking);
    },
    close,
    dismiss,
    /** 解绑所有监听并停止旧窗口点选，允许重复清理。 */
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      send(false);
      host.removeEventListener('message', receive);
      host.removeEventListener('keydown', keydown);
      host.removeEventListener('scroll', reposition, true);
      host.removeEventListener('resize', reposition);
      host.removeEventListener('pointermove', hostPointerMove, true);
      host.document.removeEventListener('visibilitychange', visibility);
      frame.removeEventListener('load', refresh);
      frame.removeEventListener('pointerleave', leaveFrame);
    },
  };
}

/** 会话和版本共用状态；scope 变化会使旧 frame 立即失效并清空选取。 */
export function usePreviewInspector(scope: string, active = true) {
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [selection, setSelection] = useState<{
    scope: string;
    element: InspectedElement;
    mode: InspectorMode;
    anchor: InspectorAnchor;
  } | null>(null);
  const desired = useRef(false);
  const actualFrame = useRef<HTMLIFrameElement | null>(null);
  const latest = useRef({ scope, active, frame });
  latest.current = { scope, active, frame };
  const binding = useRef<ReturnType<typeof bindPreviewInspector> | null>(null);
  const frameRef = useCallback(
    (node: HTMLIFrameElement | null) => {
      binding.current?.dispose();
      binding.current = null;
      actualFrame.current = node;
      setFrame(node);
    },
    [scope],
  );

  useEffect(() => {
    setSelection(null);
    if (!active) {
      desired.current = false;
      setEnabled(false);
    }
    const host = frame?.ownerDocument.defaultView;
    if (
      !active ||
      !frame ||
      frame !== actualFrame.current ||
      !host ||
      !host.crypto?.getRandomValues
    )
      return;
    const controller = bindPreviewInspector({
      frame,
      host,
      channel: createInspectorChannel(host.crypto),
      enabled: desired.current,
      isCurrent: () =>
        latest.current.active && latest.current.scope === scope && actualFrame.current === frame,
      onElement: (element, mode = 'pinned') =>
        setSelection(
          element
            ? {
                scope,
                element,
                mode,
                anchor: inspectorElementAnchor(frame, element.rect),
              }
            : null,
        ),
      onEnabled: (value) => {
        desired.current = value;
        setEnabled(value);
      },
      onClose: () => {
        desired.current = false;
        setEnabled(false);
      },
    });
    binding.current = controller;
    return () => {
      binding.current = null;
      controller.dispose();
    };
  }, [frame, scope, active]);

  return {
    frameRef,
    debugFrame: active && frame === actualFrame.current ? frame : null,
    enabled: active && enabled,
    element: active && selection?.scope === scope ? selection.element : null,
    mode: selection?.mode ?? 'hover',
    anchor: active && selection?.scope === scope ? selection.anchor : null,
    available: active && !!frame,
    toggle: () => binding.current?.setEnabled(!desired.current),
    close: () => binding.current?.dismiss(),
  };
}

export type PreviewInspectorState = ReturnType<typeof usePreviewInspector>;

/** 紧邻预览工具栏的点选开关。 */
export function PreviewInspectorButton({ inspector }: { inspector: PreviewInspectorState }) {
  return (
    <>
      <Button
        size="small"
        disabled={!inspector.available}
        aria-pressed={inspector.enabled}
        onClick={inspector.toggle}
      >
        {inspector.enabled ? '退出审查' : '审查元素'}
      </Button>
      <PreviewDebugger
        frame={inspector.debugFrame}
        inspecting={inspector.enabled}
        onOpen={() => {
          if (inspector.enabled) inspector.toggle();
        }}
      />
    </>
  );
}

/** 宽高展示最多两位小数，协议与选取状态保留原始精度。 */
export function formatInspectorDimension(value: number) {
  return String(Number(value.toFixed(2)));
}

/** 所有页面文本由 React 转义，样式仅作文本展示，不注入父页面。 */
export default function PreviewInspector({
  inspector,
  onLocateSource,
}: {
  inspector: PreviewInspectorState;
  onLocateSource?: (request: InspectorSourceRequest) => void;
}) {
  const [copyStatus, setCopyStatus] = useState('');
  const panelRef = useRef<HTMLElement | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [automaticPosition, setAutomaticPosition] = useState({ left: 12, top: 12 });
  const [dragging, setDragging] = useState(false);
  const element = inspector.element;
  const pinned = inspector.mode === 'pinned';
  useEffect(() => setCopyStatus(''), [element]);
  /** 保留拖动位置；窗口缩小时将标题与面板限制在可见区域。 */
  const moveTo = useCallback((left: number, top: number) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      left: Math.max(12, Math.min(left, window.innerWidth - rect.width - 12)),
      top: Math.max(12, Math.min(top, window.innerHeight - rect.height - 12)),
    });
  }, []);
  /** 新目标回到元素附近；同一固定目标的拖动位置在滚动时保留。 */
  useLayoutEffect(() => {
    setPosition(null);
  }, [element?.selector, pinned]);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || !inspector.anchor || !element) return;
    const anchor = inspector.anchor;
    const fit = () => {
      const rect = panel.getBoundingClientRect();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const next = inspectorPanelPosition(anchor, rect.width, rect.height, viewport);
      setAutomaticPosition((previous) =>
        previous.left === next.left && previous.top === next.top ? previous : next,
      );
      setPosition((previous) => {
        if (!previous) return previous;
        const left = Math.max(12, Math.min(previous.left, viewport.width - rect.width - 12));
        const top = Math.max(12, Math.min(previous.top, viewport.height - rect.height - 12));
        return previous.left === left && previous.top === top ? previous : { left, top };
      });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(panel);
    window.addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [element, inspector.anchor]);
  /** 捕获指针后跨过预览iframe仍能连续拖动，关闭不会留下遮罩。 */
  function finishDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  /** 类名复制保留原始 DOM 名称，完整选择器仍可独立复制。 */
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`已复制${label}`);
    } catch {
      setCopyStatus('复制失败，请手动选择');
    }
  }
  if (!inspector.enabled || !element) return null;
  const className = lastInspectorClassName(element.className);
  /** 仅用户点击后进入源码查找，使用主站固定回调，不接受iframe提供路径。 */
  function locate(property?: string) {
    if (!element || !onLocateSource) return;
    onLocateSource(inspectorSourceRequest(element, property));
    inspector.close();
  }
  const panel = (
    <aside
      ref={panelRef}
      className={`preview-inspector ${pinned ? 'is-pinned' : 'is-hover'}${dragging ? ' is-dragging' : ''}`}
      role={pinned ? 'dialog' : 'tooltip'}
      aria-modal="false"
      aria-label="元素审查器"
      style={{ ...(position ?? automaticPosition), transform: 'none' }}
    >
      <div
        className="preview-inspector-heading"
        tabIndex={pinned ? 0 : -1}
        aria-label={pinned ? '拖动审查面板，方向键移动，Home 回到元素' : '悬停元素详情'}
        title={pinned ? '拖动调整位置 · 方向键移动 · Home 回到元素' : '点击元素固定详情'}
        onPointerDown={(event) => {
          if (!pinned || event.button !== 0 || (event.target as HTMLElement).closest('button'))
            return;
          const rect = panelRef.current?.getBoundingClientRect();
          if (!rect) return;
          event.preventDefault();
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: rect.left,
            top: rect.top,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start?.id === event.pointerId)
            moveTo(start.left + event.clientX - start.x, start.top + event.clientY - start.y);
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={() => {
          drag.current = null;
          setDragging(false);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Home') {
            event.preventDefault();
            setPosition(null);
            return;
          }
          const offset = {
            ArrowLeft: [-16, 0],
            ArrowRight: [16, 0],
            ArrowUp: [0, -16],
            ArrowDown: [0, 16],
          }[event.key];
          const rect = panelRef.current?.getBoundingClientRect();
          if (offset && rect) {
            event.preventDefault();
            moveTo(rect.left + offset[0], rect.top + offset[1]);
          }
        }}
      >
        <div className="preview-inspector-identity">
          <span className="preview-inspector-indicator" aria-hidden="true" />
          {pinned && (
            <span className="preview-inspector-grip" aria-hidden="true">
              ⠿
            </span>
          )}
          <strong>{element ? `<${element.tagName}>` : '元素审查'}</strong>
          {element && (
            <span className="preview-inspector-size">
              {formatInspectorDimension(element.rect.width)} ×{' '}
              {formatInspectorDimension(element.rect.height)} px
            </span>
          )}
        </div>
        {pinned && (
          <Button type="text" size="small" onClick={inspector.close} aria-label="关闭审查浮窗">
            关闭
          </Button>
        )}
      </div>
      {element ? (
        <div className="preview-inspector-content">
          <div className="preview-inspector-selector preview-inspector-current-class">
            <code title={className || element.tagName}>{className || `<${element.tagName}>`}</code>
            {className ? (
              <Button size="small" onClick={() => void copy(className, '类名')}>
                复制类名
              </Button>
            ) : (
              <span className="preview-inspector-hint">无类名</span>
            )}
          </div>
          {pinned && onLocateSource && (
            <Button
              className="preview-inspector-source-trigger"
              type="text"
              size="small"
              icon={<Icon name="search" />}
              onClick={() => locate()}
            >
              查找源码定义
            </Button>
          )}
          <details className="preview-inspector-selector-details">
            <summary>完整选择器</summary>
            <div className="preview-inspector-selector">
              <code>{element.selector}</code>
              <Button size="small" onClick={() => void copy(element.selector, '选择器')}>
                复制选择器
              </Button>
            </div>
          </details>
          {copyStatus && (
            <span className="preview-inspector-copy" role="status">
              {copyStatus}
            </span>
          )}
          <dl className="preview-inspector-metrics">
            {[
              ['布局', element.styles.display, 'display'],
              ['定位', element.styles.position, 'position'],
              ['内边距', element.styles.padding, 'padding'],
              ['外边距', element.styles.margin, 'margin'],
              ['字号', element.styles['font-size'], 'font-size'],
              ['字色', element.styles.color, 'color'],
            ]
              .filter(([, value]) => value)
              .map(([label, value, property]) => (
                <div key={label}>
                  <dt>
                    {label}
                    {pinned && onLocateSource && (
                      <button
                        type="button"
                        className="preview-inspector-source-link"
                        aria-label={`查找${label}的源码候选`}
                        title={`查找 ${property} 的源码候选`}
                        onClick={() => locate(property)}
                      >
                        <Icon name="search" />
                      </button>
                    )}
                  </dt>
                  <dd title={value}>{value}</dd>
                </div>
              ))}
          </dl>
          <details className="preview-inspector-details">
            <summary>
              DOM 标识与全部样式{' '}
              <span>
                {inspectorStyleNames.filter((name) => Object.hasOwn(element.styles, name)).length}{' '}
                项
              </span>
            </summary>
            <dl className="preview-inspector-fields">
              <dt>id</dt>
              <dd>{element.id || '—'}</dd>
              <dt>className</dt>
              <dd>{element.className || '—'}</dd>
              <dt>data-node-id</dt>
              <dd>{element.nodeId || '—'}</dd>
              {inspectorStyleNames
                .filter((name) => Object.hasOwn(element.styles, name))
                .map((name) => (
                  <React.Fragment key={name}>
                    <dt>
                      {name}
                      {pinned && onLocateSource && (
                        <button
                          type="button"
                          className="preview-inspector-source-link"
                          aria-label={`查找 ${name} 的源码候选`}
                          onClick={() => locate(name)}
                        >
                          <Icon name="search" />
                        </button>
                      )}
                    </dt>
                    <dd>{element.styles[name]}</dd>
                  </React.Fragment>
                ))}
            </dl>
          </details>
          <p className="preview-inspector-hint">
            {pinned ? '已固定选中 · 可拖动 · Esc 收起浮窗' : '点击元素固定详情 · 移开自动收起'}
          </p>
        </div>
      ) : (
        <p className="preview-inspector-waiting">在预览元素上停留片刻，自动查看详情 · Esc 退出</p>
      )}
    </aside>
  );
  /** 挂载到主站根部，避开文件面板的裁剪与布局宽度约束。 */
  return typeof document === 'undefined' ? panel : createPortal(panel, document.body);
}
