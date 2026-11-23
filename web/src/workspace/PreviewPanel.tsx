import { comparePreviewEntries } from './previewEntry';
import PhonePreview, { PhonePreviewButton, usePhonePreview } from './PhonePreview';
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button } from 'antd';
import { data, errorMessage, id } from './api';
import Icon from '../components/Icon';
import PreviewInspector, { PreviewInspectorButton, usePreviewInspector } from './PreviewInspector';
import type { FileInfo, Target } from './types';

type Preview = {
  previewId: string;
  versionId: string | null;
  status: string;
  target: Target;
  error?: {
    message: string;
    code?: string;
    file?: string;
    module?: string;
    line?: number;
    column?: number;
  } | null;
  entryPath: string;
};
type Ticket = { url: string; expiresAt: string | null };

/** 编译诊断仅显示接口公开的模块和相对文件定位，不显示原始日志。 */
export function PreviewErrorDetails({ error }: { error: Preview['error'] }) {
  if (!error?.code) return null;
  return (
    <div>
      <div>错误类型：{error.code}</div>
      {error.module && (
        <div>
          缺失模块：<code>{error.module}</code>
        </div>
      )}
      {error.file && (
        <div>
          文件：
          <code>
            {error.file}
            {error.line ? `:${error.line}${error.column ? `:${error.column}` : ''}` : ''}
          </code>
        </div>
      )}
    </div>
  );
}

/** 入口保留冻结源码的实际相对路径，仅允许 TSX/JSX 源文件。 */
export function previewEntries(files: FileInfo[]) {
  return files
    .filter((file) => file.kind === 'source' && /\.(tsx|jsx)$/i.test(file.path))
    .sort((a, b) => comparePreviewEntries(a.path, b.path));
}

/** 票据仅允许当前预览的同源隔离入口，不接受外部地址或查询参数。 */
export function validPreviewTicket(
  ticket: Ticket,
  previewId: string,
  target: Target,
  allowPermanent = false,
) {
  const prefix = target === 'rn' ? 'RN_Preview' : 'H5_Preview';
  const parts = ticket.url.split('/');
  return (
    parts.length === 5 &&
    parts[0] === '' &&
    parts[1] === prefix &&
    parts[2] === id(previewId) &&
    /^[a-zA-Z0-9_~.-]+$/.test(parts[3]) &&
    parts[3] !== '.' &&
    parts[3] !== '..' &&
    parts[4] === 'index.html' &&
    (ticket.expiresAt === null
      ? allowPermanent
      : Number.isFinite(Date.parse(ticket.expiresAt)) && Date.parse(ticket.expiresAt) > Date.now())
  );
}

/** 已保存版本的独立预览；卸载仅取消客户端请求，不取消后台构建。 */
export default function PreviewPanel({
  versionId,
  files,
  target,
  active = true,
  onPreviewLinkChange,
}: {
  versionId: string;
  files: FileInfo[];
  target: Target;
  active?: boolean;
  onPreviewLinkChange?: (url: string | null) => void;
}) {
  const entries = previewEntries(files);
  const [entryPath, setEntryPath] = useState(entries[0]?.path ?? '');
  const [previewState, setPreview] = useState<Preview | null>(null);
  const [ticketState, setTicket] = useState<Ticket | null>(null);
  const [expired, setExpired] = useState(false);
  const width = 'auto';
  const [busy, setBusy] = useState<'generate' | 'ticket' | null>(null);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [pollRetry, setPollRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const [checking, setChecking] = useState(false);
  const [closed, setClosed] = useState(false);
  const [ticketRevision, setTicketRevision] = useState(0);
  const lookup = useRef<AbortController | null>(null);
  const selectedEntry = entries.some((file) => file.path === entryPath)
    ? entryPath
    : (entries[0]?.path ?? '');
  const preview =
    previewState?.versionId === versionId && previewState.entryPath === selectedEntry
      ? previewState
      : null;
  const ticket =
    preview && ticketState?.url.split('/')[2] === id(preview.previewId) ? ticketState : null;
  const phone = usePhonePreview(active && !!ticket && !expired && !closed);
  const inspector = usePreviewInspector(
    `${versionId}:${selectedEntry}:${ticket?.url ?? ''}:${width}`,
    active && !!ticket && !expired && !closed,
  );
  const building = !!preview && preview.status !== 'ready' && preview.status !== 'failed';

  /** 固定链接仅来自当前入口已校验的长期票据，切换或失效时清除旧地址。 */
  useEffect(() => {
    onPreviewLinkChange?.(ticket?.expiresAt === null && !expired ? ticket.url : null);
    return () => onPreviewLinkChange?.(null);
  }, [ticket?.url, ticket?.expiresAt, expired, onPreviewLinkChange]);

  useEffect(() => {
    const controller = new AbortController();
    lookup.current = controller;
    request.current?.abort();
    pending.current = false;
    setBusy(null);
    setPreview(null);
    setTicket(null);
    setClosed(false);
    setExpired(false);
    setError('');
    setPollError('');
    if (!selectedEntry) {
      setChecking(false);
      return () => controller.abort();
    }
    setChecking(true);
    data<Preview | null>(
      `/versions/${id(versionId)}/previews?entryPath=${encodeURIComponent(selectedEntry)}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) setPreview(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [versionId, selectedEntry]);

  /** 已有或刚构建就绪的预览自动申请票据；关闭、切入口、切版本时中止旧请求。 */
  useEffect(() => {
    if (!preview || preview.status !== 'ready' || closed) return;
    const controller = new AbortController();
    setBusy('ticket');
    setTicket(null);
    setError('');
    data<Ticket>(`/previews/${id(preview.previewId)}/ticket`, {
      method: 'POST',
      body: JSON.stringify({}),
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!validPreviewTicket(value, preview.previewId, preview.target, true))
          throw new Error('预览票据无效或已到期，请刷新预览');
        setTicket(value);
        setExpired(false);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(null);
      });
    return () => controller.abort();
  }, [preview?.previewId, preview?.status, closed, ticketRevision]);

  useEffect(() => () => request.current?.abort(), []);

  useEffect(() => {
    if (!preview || preview.status === 'ready' || preview.status === 'failed') return;
    const controller = new AbortController();
    const previewId = preview.previewId;
    let timer: ReturnType<typeof setTimeout>;
    setPollError('');
    /** 每次响应后安排下一次查询，避免重叠且只查询当前 preview。 */
    async function poll() {
      try {
        const value = await data<Preview>(`/previews/${id(previewId)}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setPreview(value);
        if (value.status !== 'ready' && value.status !== 'failed') timer = setTimeout(poll, 2000);
      } catch (reason) {
        if (!controller.signal.aborted) setPollError(errorMessage(reason));
      }
    }
    timer = setTimeout(poll, 2000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [preview?.previewId, preview?.status, pollRetry]);

  useEffect(() => {
    if (!ticket || ticket.expiresAt === null) return;
    const expiresAt = Date.parse(ticket.expiresAt);
    /** 到期移除 iframe；计时器不会申请新票据或重新构建。 */
    function checkExpiry() {
      if (expiresAt <= Date.now()) setExpired(true);
    }
    checkExpiry();
    const timer = setInterval(checkExpiry, 1000);
    return () => clearInterval(timer);
  }, [ticket]);

  /** 显式创建任务，入口由当前版本源码列表确定；双击不会重复提交。 */
  async function generate() {
    if (pending.current || building || !selectedEntry) return;
    lookup.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    pending.current = true;
    setChecking(false);
    setClosed(false);
    setBusy('generate');
    setError('');
    setPollError('');
    setTicket(null);
    setExpired(false);
    try {
      const value = await data<Preview>(`/versions/${id(versionId)}/previews`, {
        method: 'POST',
        body: JSON.stringify({ entryPath: selectedEntry }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setPreview(value);
        setTicketRevision((revision) => revision + 1);
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    } finally {
      if (!controller.signal.aborted) {
        pending.current = false;
        setBusy(null);
      }
    }
  }

  /** 手动刷新或重开只重取票据，不重新构建。 */
  function openPreview() {
    setClosed(false);
    setExpired(false);
    setTicket(null);
    setTicketRevision((value) => value + 1);
  }

  /** 关闭仅停止展示和票据申请，不取消后台构建。 */
  function closePreview() {
    setClosed(true);
    setTicket(null);
    setExpired(false);
    setBusy(null);
  }

  return (
    <section className="version-preview-panel" aria-label="已保存版本预览">
      <div className="version-preview-controls">
        <label>
          入口
          <select
            value={selectedEntry}
            disabled={!!busy || building || !entries.length}
            onChange={(event) => setEntryPath(event.target.value)}
          >
            <option value="" disabled>
              选择 TSX / JSX 源码
            </option>
            {entries.map((file) => (
              <option key={file.fileId} value={file.path}>
                {file.path}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="primary"
          icon={<Icon name="play" />}
          loading={busy === 'generate'}
          disabled={!!busy || checking || building || !selectedEntry}
          onClick={generate}
        >
          生成预览
        </Button>
      </div>
      {checking && <p role="status">正在查询已有预览…</p>}
      {(preview?.target ?? target) === 'rn' && (
        <p className="version-preview-note">RN Web 浏览器兼容预览，效果以原生端为准。</p>
      )}
      {!preview && !checking && !busy && !error && (
        <p className="version-preview-placeholder">
          {entries.length ? '暂无预览' : '该版本没有可预览的 TSX / JSX 源码。'}
        </p>
      )}
      {error && <Alert type="error" title={error} showIcon />}
      {preview && (
        <p role="status">
          {building ? '正在生成预览…' : preview.status === 'ready' ? '预览已就绪' : '预览生成失败'}
        </p>
      )}
      {preview?.status === 'failed' && (
        <Alert
          type="error"
          title={errorMessage(new Error(preview.error?.message || '预览生成失败，请重试'))}
          description={<PreviewErrorDetails error={preview.error} />}
          showIcon
        />
      )}
      {pollError && (
        <Alert
          type="error"
          title={pollError}
          showIcon
          action={<Button onClick={() => setPollRetry((value) => value + 1)}>重试查询</Button>}
        />
      )}
      {preview?.status === 'ready' && (
        <div className="version-preview-controls">
          <Button loading={busy === 'ticket'} disabled={!!busy} onClick={openPreview}>
            {closed ? '显示预览' : '刷新预览'}
          </Button>
          <PreviewInspectorButton inspector={inspector} />
          <PhonePreviewButton preview={phone} />
          {(ticket || busy === 'ticket') && <Button onClick={closePreview}>关闭预览</Button>}
        </div>
      )}
      <PreviewInspector inspector={inspector} />
      {ticket && expired && (
        <Alert type="warning" title="预览票据已到期，请手动点击刷新预览" showIcon />
      )}
      {ticket && !expired && (
        <PhonePreview preview={phone}>
          <div className="version-preview-viewport">
            <iframe
              key={`${ticket.url}:${width}`}
              ref={inspector.frameRef}
              title="已保存版本浏览器预览"
              src={ticket.url}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              style={{ width: width === 'auto' ? '100%' : width }}
            />
          </div>
        </PhonePreview>
      )}
    </section>
  );
}
