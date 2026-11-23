import PhonePreview, { PhonePreviewButton, usePhonePreview } from './PhonePreview';
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Spin } from 'antd';
import { data, errorMessage, id } from './api';
import { PreviewErrorDetails, validPreviewTicket } from './PreviewPanel';
import {
  previewBuilding,
  previewFileKey,
  watchSessionPreview,
  type SessionPreviewState,
  type SessionPreviewSummary,
} from './sessionPreview';

import PreviewInspector, { PreviewInspectorButton, usePreviewInspector } from './PreviewInspector';

import type { FileInfo } from './types';
import type { InspectorSourceRequest } from './PreviewInspector';

type Frame = { url: string; expiresAt: string; preview: SessionPreviewSummary };

/** 双缓冲保留旧 iframe 节点，新票据页面完成加载后才交接。 */
export function SessionPreviewFrames({
  shown,
  incoming,
  width,
  onReady,
  inspectorRef,
}: {
  shown: Frame | null;
  incoming: Frame | null;
  width: string | number;
  onReady: (frame: Frame) => void;
  inspectorRef?: React.Ref<HTMLIFrameElement>;
}) {
  return (
    <div className="session-preview-frames">
      {[shown, incoming]
        .filter(
          (frame, index, frames): frame is Frame =>
            !!frame && (index === 0 || frame.url !== frames[0]?.url),
        )
        .map((frame) => (
          <iframe
            key={frame.url}
            ref={frame.url === shown?.url ? inspectorRef : undefined}
            title={frame.url === shown?.url ? '当前会话浏览器预览' : '正在加载新版预览'}
            className={frame.url === shown?.url ? '' : 'session-preview-incoming'}
            aria-hidden={frame.url !== shown?.url}
            tabIndex={frame.url === shown?.url ? 0 : -1}
            src={frame.url}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            style={{ width: width === 'auto' ? '100%' : width }}
            onLoad={() => {
              if (frame.url === incoming?.url) {
                onReady(frame);
              }
            }}
          />
        ))}
    </div>
  );
}

/** 当前源码自动预览，成功页面在新 iframe 加载完成前持续保留。 */
export default function SessionPreviewPanel({
  sessionId,
  files,
  previewRevision,
  active,
  onLocateSource,
}: {
  sessionId: string;
  files?: FileInfo[];
  previewRevision: number;
  active: boolean;
  onLocateSource?: (request: InspectorSourceRequest) => void;
}) {
  const [entryPath, setEntryPath] = useState('');
  const selectedEntry = files?.some((file) => file.path === entryPath) ? entryPath : '';
  const fileKey = files ? previewFileKey(files) : undefined;
  const [state, setState] = useState<SessionPreviewState | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [ticketRetry, setTicketRetry] = useState(0);
  const [shown, setShown] = useState<Frame | null>(null);
  const [incoming, setIncoming] = useState<Frame | null>(null);
  const width = 'auto';
  const phone = usePhonePreview(active && !!shown);
  const watcher = useRef<ReturnType<typeof watchSessionPreview> | null>(null);
  const ready = state?.current?.status === 'ready' ? state.current : state?.lastReady;
  const building = previewBuilding(state);
  const waiting = state?.current?.status === 'waiting_files';
  const loading =
    !error &&
    state?.current?.status !== 'failed' &&
    (!state || building || !!incoming || (!!ready && !shown));
  const inspector = usePreviewInspector(
    `${sessionId}:${selectedEntry}:${shown?.url ?? ''}:${width}`,
    active,
  );

  useEffect(() => {
    const watch = watchSessionPreview({
      sessionId,
      entryPath: selectedEntry,
      onState: setState,
      onError: setError,
    });
    watcher.current = watch;
    return () => watch.dispose();
  }, [sessionId, selectedEntry]);

  useEffect(() => {
    if (fileKey !== undefined) watcher.current?.ensure();
  }, [sessionId, selectedEntry, fileKey]);

  useEffect(() => {
    if (retry) watcher.current?.retry();
  }, [retry]);

  useEffect(() => {
    if (previewRevision) watcher.current?.refresh();
  }, [previewRevision]);

  useEffect(() => {
    if (!ready) return;
    if (
      shown?.preview.entryPath === ready.entryPath &&
      shown.preview.fileRevision > ready.fileRevision
    )
      return;
    const controller = new AbortController();
    let renewal: ReturnType<typeof setTimeout>;
    data<{ url: string; expiresAt: string }>(`/previews/${id(ready.previewId)}/ticket`, {
      method: 'POST',
      body: JSON.stringify({}),
      signal: controller.signal,
    })
      .then((ticket) => {
        if (controller.signal.aborted) return;
        if (!validPreviewTicket(ticket, ready.previewId, ready.target))
          throw new Error('预览票据无效或已到期');
        setIncoming({ ...ticket, preview: ready });
        renewal = setTimeout(
          () => setTicketRetry((value) => value + 1),
          Math.max(1000, (Date.parse(ticket.expiresAt) - Date.now()) * 0.8),
        );
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      });
    return () => {
      controller.abort();
      clearTimeout(renewal);
      setIncoming(null);
    };
  }, [ready?.previewId, ticketRetry]);

  return (
    <section className="session-preview" aria-label="当前会话运行预览" hidden={!active}>
      <div className="session-preview-toolbar">
        <span role="status" className="session-preview-status">
          {waiting
            ? '等待文件保存'
            : building
              ? '正在更新预览'
              : state?.current?.status === 'failed'
                ? '构建失败'
                : loading
                  ? '正在加载预览'
                  : ready
                    ? '预览已就绪'
                    : '等待页面入口'}
          {shown && ` · 当前展示 r${shown.preview.fileRevision}`}
        </span>
        <Button
          size="small"
          onClick={() => {
            setRetry((value) => value + 1);
            setTicketRetry((value) => value + 1);
          }}
        >
          刷新
        </Button>
        <PreviewInspectorButton inspector={inspector} />
        <PhonePreviewButton preview={phone} />
      </div>
      <div className="session-preview-body" aria-busy={loading}>
        {!!state && (state.entries.length > 1 || !!selectedEntry) && (
          <label className="session-entry-select">
            页面入口
            <select
              aria-label="当前会话预览入口"
              value={selectedEntry || state.current?.entryPath || ''}
              onChange={(event) => setEntryPath(event.target.value)}
            >
              <option value="">请选择页面入口</option>
              {state.entries.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        )}
        {ready?.target === 'rn' && <p className="muted">RN Web 兼容预览，实际效果以原生端为准。</p>}
        {error && <Alert type="error" showIcon title={error} />}
        {waiting && (
          <Alert
            type="info"
            showIcon
            title="等待生成文件保存，保存后将自动更新预览"
            description={state?.current?.waitingForFile}
          />
        )}
        {state?.current?.status === 'failed' && (
          <Alert
            type="error"
            showIcon
            title={state.current.error?.message || '预览构建失败，后续文件更新将自动重试'}
            description={<PreviewErrorDetails error={state.current.error} />}
          />
        )}
        {!shown &&
          !error &&
          !waiting &&
          state?.current?.status !== 'failed' &&
          (loading ? (
            <div className="session-preview-loading" role="status" aria-live="polite">
              <div className="session-preview-loading-heading">
                <Spin size="small" />
                <span>
                  {waiting ? '等待文件保存…' : building ? '正在构建预览…' : '正在加载预览…'}
                </span>
              </div>
            </div>
          ) : (
            <div className="session-preview-empty" role="status">
              {state?.entries.length ? '选择页面入口' : '暂无预览'}
            </div>
          ))}
        <PreviewInspector inspector={inspector} onLocateSource={onLocateSource} />
        <PhonePreview preview={phone}>
          <SessionPreviewFrames
            inspectorRef={inspector.frameRef}
            shown={shown}
            incoming={incoming}
            width={width}
            onReady={(frame) => {
              setShown(frame);
              setIncoming(null);
            }}
          />
        </PhonePreview>
      </div>
    </section>
  );
}
