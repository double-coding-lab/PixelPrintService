import React, { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import Icon from '../components/Icon';

/** 将缩放或面板比例限制在可操作范围，避免极端值挤掉操作入口。 */
export function clampViewValue(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

/** 优先使用原生全屏；拒绝或不支持时由界面明确降级为专注视图。 */
export async function toggleConversationFullscreen(element: HTMLElement) {
  const owner = element.ownerDocument;
  if (owner.fullscreenElement === element) {
    await owner.exitFullscreen();
    return;
  }
  if (typeof element.requestFullscreen !== 'function') throw new Error('FULLSCREEN_UNAVAILABLE');
  await element.requestFullscreen();
}

/** 只改变布局与阅读比例，不重建对话内容、输入框或事件订阅。 */
export default function ConversationView({
  children,
  focused,
  onFocusChange,
  onLayoutChange,
}: {
  children: ReactNode;
  focused: boolean;
  onFocusChange: (focused: boolean) => void;
  onLayoutChange: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const layoutCallback = useRef(onLayoutChange);
  layoutCallback.current = onLayoutChange;
  const [zoom, setZoom] = useState(100);
  const [fullscreen, setFullscreen] = useState(false);
  const [pending, setPending] = useState(false);
  const [hint, setHint] = useState('');
  useEffect(() => {
    if (!focused) return;
    /** 专注模式也支持 Esc；原生全屏的 Esc 交给浏览器管理。 */
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !document.fullscreenElement) {
        onFocusChange(false);
        setHint('');
      }
    }
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [focused, onFocusChange]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const owner = element.ownerDocument;
    let wasFullscreen = false;
    /** 原生 Esc、浏览器退出和按钮退出共用同一个状态源。 */
    function changed() {
      const active = owner.fullscreenElement === element;
      setFullscreen(active);
      if (wasFullscreen && !active) fullscreenButton.current?.focus();
      wasFullscreen = active;
      layoutCallback.current();
    }
    owner.addEventListener('fullscreenchange', changed);
    return () => {
      owner.removeEventListener('fullscreenchange', changed);
      if (owner.fullscreenElement === element) void owner.exitFullscreen().catch(() => {});
    };
  }, []);

  /** 仅缩放文字，不使用 transform 拉伸布局或改变浏览器本身的缩放。 */
  function resizeText(value: number) {
    setZoom(clampViewValue(value, 80, 150));
    onLayoutChange();
  }

  /** 全屏拒绝时保留草稿并展开对话区域，不伪装浏览器已进入全屏。 */
  async function toggleFullscreen() {
    if (!root.current || pending) return;
    setPending(true);
    setHint('');
    try {
      await toggleConversationFullscreen(root.current);
    } catch {
      onFocusChange(true);
      setHint('浏览器未允许全屏，已切换为专注视图。');
    } finally {
      setPending(false);
      onLayoutChange();
    }
  }

  return (
    <div
      ref={root}
      className="conversation-column"
      style={{ '--conversation-scale': zoom / 100 } as CSSProperties}
    >
      <div className="conversation-viewbar" aria-label="对话视图设置">
        <span className="viewbar-caption">对话</span>
        <div className="viewbar-actions">
          <div className="zoom-controls" role="group" aria-label="对话内容缩放">
            <button
              className="icon-button"
              title="缩小内容"
              aria-label="缩小对话内容"
              disabled={zoom <= 80}
              onClick={() => resizeText(zoom - 10)}
            >
              <Icon name="minus" />
            </button>
            <button
              className="zoom-reset"
              title="恢复默认字号"
              aria-label={`恢复默认字号，当前 ${zoom}%`}
              onClick={() => resizeText(100)}
            >
              {zoom}%
            </button>
            <button
              className="icon-button"
              title="放大内容"
              aria-label="放大对话内容"
              disabled={zoom >= 150}
              onClick={() => resizeText(zoom + 10)}
            >
              <Icon name="plus" />
            </button>
          </div>
          <span className="viewbar-separator" />
          <button
            className="icon-button"
            title={focused ? '恢复双栏' : '专注对话，隐藏产物面板'}
            aria-label={focused ? '恢复双栏视图' : '展开对话区域'}
            aria-pressed={focused}
            disabled={fullscreen}
            onClick={() => {
              onFocusChange(!focused);
              onLayoutChange();
            }}
          >
            <Icon name="panels" />
          </button>
          <button
            ref={fullscreenButton}
            className="icon-button"
            title={fullscreen ? '退出全屏（Esc）' : '全屏对话'}
            aria-label={fullscreen ? '退出对话全屏' : '全屏对话'}
            aria-pressed={fullscreen}
            disabled={pending}
            onClick={() => void toggleFullscreen()}
          >
            <Icon name={fullscreen ? 'minimize' : 'maximize'} />
          </button>
        </div>
      </div>
      {hint && (
        <p role="status" className="viewbar-hint">
          {hint}
        </p>
      )}
      {children}
    </div>
  );
}

/** 鼠标/触摸拖动或方向键调整双栏比例；指针捕获只在本元素生命周期内生效。 */
export function ConversationDivider({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div
      className="conversation-divider"
      role="separator"
      tabIndex={0}
      aria-label="调整对话与产物宽度"
      aria-orientation="vertical"
      aria-valuemin={30}
      aria-valuemax={75}
      aria-valuenow={value}
      aria-valuetext={`对话区域 ${value}%`}
      title="拖动调整宽度，方向键微调，双击复原"
      onDoubleClick={() => onChange(55)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
        if (bounds && bounds.width > 0)
          onChange(
            clampViewValue(
              Math.round(((event.clientX - bounds.left) / bounds.width) * 100),
              30,
              75,
            ),
          );
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        onChange(
          clampViewValue(
            event.key === 'Home'
              ? 30
              : event.key === 'End'
                ? 75
                : value + (event.key === 'ArrowRight' ? 2 : -2),
            30,
            75,
          ),
        );
      }}
    >
      <span />
    </div>
  );
}
