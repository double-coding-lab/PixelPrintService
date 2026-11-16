import React, { useEffect, useRef, useState } from 'react';
import { Button } from 'antd';

type Status = 'closed' | 'loading' | 'open' | 'failed';

/** 调试状态仅属于当前 iframe；通信不接受其他预览窗口或旧频道的响应。 */
export function validateDebuggerState(
  event: Pick<MessageEvent, 'source' | 'origin' | 'data'>,
  frameWindow: Window | null,
  channel: string,
): Status | null {
  if (!frameWindow || event.source !== frameWindow || event.origin !== 'null') return null;
  const value = event.data;
  return value &&
    value.type === 'pixelprint:debug-state' &&
    value.channel === channel &&
    ['closed', 'loading', 'open', 'failed'].includes(value.status)
    ? value.status
    : null;
}

/** 工作台按钮控制 iframe 内的 Eruda；切换预览或离开面板时关闭原窗口的调试界面。 */
export default function PreviewDebugger({
  frame,
  inspecting,
  onOpen,
}: {
  frame: HTMLIFrameElement | null;
  inspecting: boolean;
  onOpen: () => void;
}) {
  const [status, setStatus] = useState<Status>('closed');
  const command = useRef<(enabled: boolean) => void>(() => {});
  const latest = useRef(onOpen);
  latest.current = onOpen;

  useEffect(() => {
    setStatus('closed');
    const host = frame?.ownerDocument.defaultView;
    if (!frame || !host) {
      command.current = () => {};
      return;
    }
    let channel = host.crypto.randomUUID();
    let desired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function send() {
      frame!.contentWindow?.postMessage(
        { type: 'pixelprint:debug-command', channel, enabled: desired },
        '*',
      );
    }
    command.current = (enabled) => {
      desired = enabled;
      clearTimeout(timer);
      setStatus(enabled ? 'loading' : 'closed');
      if (enabled) {
        latest.current();
        timer = setTimeout(() => setStatus('failed'), 16000);
      }
      send();
    };
    function receive(event: MessageEvent) {
      const value = validateDebuggerState(event, frame!.contentWindow, channel);
      if (!value) return;
      if (value !== 'loading') clearTimeout(timer);
      setStatus(value);
    }
    function load() {
      clearTimeout(timer);
      desired = false;
      channel = host!.crypto.randomUUID();
      setStatus('closed');
      send();
    }
    host.addEventListener('message', receive);
    frame.addEventListener('load', load);
    return () => {
      desired = false;
      send();
      clearTimeout(timer);
      command.current = () => {};
      host.removeEventListener('message', receive);
      frame.removeEventListener('load', load);
    };
  }, [frame]);

  useEffect(() => {
    if (inspecting) command.current(false);
  }, [inspecting, frame]);

  return (
    <Button
      size="small"
      disabled={!frame}
      aria-pressed={status === 'open' || status === 'loading'}
      title={
        status === 'failed'
          ? '调试面板加载失败，请重试；票据过期时先刷新预览'
          : '检查 DOM、样式、日志和请求；临时调试修改不会写回源码'
      }
      onClick={() => command.current(status !== 'open' && status !== 'loading')}
    >
      {status === 'open'
        ? '关闭调试'
        : status === 'loading'
          ? '取消加载'
          : status === 'failed'
            ? '重试调试'
            : '调试面板'}
    </Button>
  );
}
