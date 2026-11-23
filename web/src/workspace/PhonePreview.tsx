import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from 'antd';
import Icon from '../components/Icon';
import { phoneViewports, phoneViewportScale } from './phoneViewport';

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

/** 普通与全屏模式共用手机视口和同一iframe，仅等比缩放展示。 */
export default function PhonePreview({
  preview,
  children,
}: {
  preview: PhonePreviewState;
  children: ReactNode;
}) {
  const [preset, setPreset] = useState<string>('standard');
  const [landscape, setLandscape] = useState(false);
  const [scale, setScale] = useState(1);
  const stage = useRef<HTMLDivElement>(null);
  const exit = useRef<HTMLButtonElement>(null);
  const device = phoneViewports.find((item) => item.id === preset) ?? phoneViewports[2];
  const width = landscape ? device.height : device.width;
  const height = landscape ? device.width : device.height;
  useEffect(() => {
    if (!stage.current) return;
    const element = stage.current;
    const resize = () => {
      const box = element.getBoundingClientRect();
      setScale(phoneViewportScale(box.width, box.height, width, height));
    };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
    observer?.observe(element);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [preview.fullscreen, width, height]);
  useEffect(() => {
    if (preview.fullscreen) exit.current?.focus();
  }, [preview.fullscreen]);
  return (
    <div
      ref={preview.root}
      className={`phone-preview-shell${preview.fullscreen ? ' is-fullscreen' : ''}`}
      role={preview.fullscreen ? 'dialog' : undefined}
      aria-modal={preview.fullscreen ? true : undefined}
      aria-label={preview.fullscreen ? '全屏手机预览' : undefined}
    >
      <div className="phone-preview-toolbar">
        <strong>手机预览</strong>
        <label>
          屏幕比例
          <select
            aria-label="手机屏幕比例"
            value={preset}
            onChange={(event) => setPreset(event.target.value)}
          >
            {phoneViewports.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="small"
          onClick={() => setLandscape((value) => !value)}
          aria-label="切换横竖屏"
        >
          {landscape ? '切为竖屏' : '切为横屏'}
        </Button>
        <span className="phone-preview-dimensions" aria-live="polite">
          {width} × {height} · {Math.round(scale * 100)}%
        </span>
        {preview.fullscreen && (
          <Button ref={exit} size="small" onClick={preview.close} icon={<Icon name="minimize" />}>
            退出全屏
          </Button>
        )}
      </div>
      <div ref={stage} className="phone-preview-stage">
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
  );
}
