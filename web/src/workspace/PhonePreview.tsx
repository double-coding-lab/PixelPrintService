import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Spin } from 'antd';
import Icon from '../components/Icon';
import { phoneViewports, previewViewportLayout } from './phoneViewport';

/** 全屏只改变原DOM的展示方式，保留iframe、票据及页面交互状态。 */
export function usePhonePreview(available: boolean) {
  const [fullscreen, setFullscreen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const opened = useRef(false);
  const native = useRef(false);

  function close() {
    opened.current = false;
    setFullscreen(false);
    if (document.fullscreenElement === root.current) void document.exitFullscreen().catch(() => {});
  }
  function open() {
    if (!available) return;
    restoreFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    opened.current = true;
    native.current = false;
    setFullscreen(true);
    try {
      void root.current
        ?.requestFullscreen?.()
        .then(() => {
          native.current = document.fullscreenElement === root.current;
          if (!opened.current && document.fullscreenElement === root.current)
            void document.exitFullscreen().catch(() => {});
        })
        .catch(() => {});
    } catch {
      // 不支持浏览器全屏或被拒绝时，保留页面内的全屏展示。
    }
  }
  useEffect(() => {
    if (!available) close();
  }, [available]);
  useEffect(() => {
    if (!fullscreen) return;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const background: { element: HTMLElement; inert: boolean }[] = [];
    for (
      let element: HTMLElement | null = root.current;
      element?.parentElement;
      element = element.parentElement
    ) {
      for (const sibling of element.parentElement.children) {
        if (sibling !== element && sibling instanceof HTMLElement) {
          background.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      if (element.parentElement === document.body) break;
    }
    const change = () => {
      if (document.fullscreenElement === root.current) native.current = true;
      else if (native.current) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const controls = root.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), select, iframe',
        );
        const first = controls?.[0],
          last = controls?.[controls.length - 1];
        if (
          first &&
          last &&
          ((event.shiftKey && document.activeElement === first) ||
            (!event.shiftKey && document.activeElement === last))
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('fullscreenchange', change);
    document.addEventListener('keydown', key, true);
    return () => {
      opened.current = false;
      document.body.style.overflow = priorOverflow;
      background.forEach(({ element, inert }) => {
        element.inert = inert;
      });
      document.removeEventListener('fullscreenchange', change);
      document.removeEventListener('keydown', key, true);
      if (document.fullscreenElement === root.current)
        void document.exitFullscreen().catch(() => {});
      if (restoreFocus.current?.isConnected) restoreFocus.current.focus();
    };
  }, [fullscreen]);
  return { root, fullscreen, available, open, close };
}
export type PhonePreviewState = ReturnType<typeof usePhonePreview>;

export type PreviewLoadingState = { title: string; entryPath?: string | null };

/** 加载提示位于显示区域内，独立于页面缩放和滚动位置。 */
export function PreviewLoading({ title, entryPath }: PreviewLoadingState) {
  return (
    <div className="preview-loading-indicator" role="status" aria-live="polite">
      <Spin size="large" />
      <strong>{title}</strong>
      {entryPath && <code>{entryPath}</code>}
    </div>
  );
}

/** 常规工具条中的全屏入口，未有可见页面时禁用。 */
export function PhonePreviewButton({ preview }: { preview: PhonePreviewState }) {
  return (
    <Button
      size="small"
      icon={<Icon name="maximize" />}
      disabled={!preview.available}
      onClick={preview.open}
    >
      全屏预览
    </Button>
  );
}

/** 视口控制页面布局，缩放只控制显示大小；普通与全屏共用同一 iframe。 */
export default function PhonePreview({
  preview,
  children,
  toolbarStart,
  loading,
}: {
  preview: PhonePreviewState;
  children: ReactNode;
  toolbarStart?: ReactNode;
  loading?: PreviewLoadingState;
}) {
  const [preset, setPreset] = useState<string>('standard');
  const [zoom, setZoom] = useState<number | 'fit'>(1);
  const [available, setAvailable] = useState({ width: 422, height: 876 });
  const stage = useRef<HTMLDivElement>(null);
  const exit = useRef<HTMLButtonElement>(null);
  const visible = preview.available || !!loading;
  const { width, height, scale } = previewViewportLayout(
    available.width,
    available.height,
    preset,
    zoom,
  );
  const fittedScale = previewViewportLayout(available.width, available.height, preset, 'fit').scale;
  useEffect(() => {
    if (!stage.current) return;
    const element = stage.current;
    const resize = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setAvailable((prior) =>
        prior.width === width && prior.height === height ? prior : { width, height },
      );
    };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
    observer?.observe(element);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [preview.fullscreen, preview.available]);
  useEffect(() => {
    if (preview.fullscreen) exit.current?.focus();
  }, [preview.fullscreen]);
  return (
    <div
      ref={preview.root}
      className={`phone-preview-shell${preview.fullscreen ? ' is-fullscreen' : ''}${!visible ? ' is-pending' : ''}`}
      aria-hidden={!visible}
      inert={!visible}
      role={preview.fullscreen ? 'dialog' : undefined}
      aria-modal={preview.fullscreen ? true : undefined}
      aria-label={preview.fullscreen ? '全屏手机预览' : undefined}
    >
      <div className={`phone-preview-toolbar${toolbarStart ? ' has-entry' : ''}`}>
        {toolbarStart ?? <strong>手机预览</strong>}
        <label>
          <span className="phone-preview-screen-label">视口</span>
          <select
            aria-label="预览视口尺寸"
            value={preset}
            onChange={(event) => setPreset(event.target.value)}
          >
            <option value="responsive">
              适合窗口{preset === 'responsive' ? ` · ${width} × ${height}` : ''}
            </option>
            {phoneViewports.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="phone-preview-zoom">
          <span className="phone-preview-screen-label">缩放</span>
          <select
            aria-label="预览显示缩放"
            value={zoom}
            onChange={(event) =>
              setZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))
            }
          >
            <option value="fit">自动适应 · {Math.round(fittedScale * 100)}%</option>
            {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => (
              <option key={value} value={value}>
                {value * 100}%
              </option>
            ))}
          </select>
        </label>
        <span className="phone-preview-dimensions" aria-live="polite">
          {width} × {height}
        </span>
        {preview.fullscreen && (
          <Button ref={exit} size="small" onClick={preview.close} icon={<Icon name="minimize" />}>
            退出全屏
          </Button>
        )}
      </div>
      <div className="phone-preview-display" aria-busy={!!loading}>
        <div
          ref={stage}
          className="phone-preview-stage"
          inert={!!loading}
          aria-hidden={loading ? true : undefined}
        >
          <div className="phone-preview-stage-content">
            <div
              className="phone-preview-device"
              style={{ width: width * scale, height: height * scale }}
            >
              <div
                className="phone-preview-canvas"
                style={{ width, height, transform: `scale(${scale})` }}
              >
                {children}
              </div>
            </div>
          </div>
        </div>
        {loading && (
          <div className="phone-preview-loading">
            <PreviewLoading {...loading} />
          </div>
        )}
      </div>
    </div>
  );
}
