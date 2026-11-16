import { formatTime } from './time';
import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Pagination, Tag } from 'antd';
import Icon from '../components/Icon';
import { data, errorMessage, id, type ApiError } from './api';
import type { VersionMetadata, VersionPage, VersionSaveRequest } from './types';

type PendingSave = {
  request: VersionSaveRequest;
  promise?: Promise<VersionMetadata>;
  error?: string;
};
/** 仅在页面内保留未确认的写入；切会话/组件重建不能丢失原幂等参数。 */
const pendingSaves = new Map<string, PendingSave>();

/** 同会话只允许一个未确认请求；重复点击共享在途 Promise，失败重试沿用原参数。 */
export function startVersionSave(sessionId: string, request: VersionSaveRequest): PendingSave {
  const prior = pendingSaves.get(sessionId);
  if (prior && prior.request.clientRequestId !== request.clientRequestId) {
    throw new Error('请先重试并确认上一笔版本暂存结果');
  }
  if (prior?.promise) return prior;
  const original = prior?.request ?? { ...request };
  const entry: PendingSave = { request: original };
  entry.promise = data<VersionMetadata>(`/sessions/${id(sessionId)}/versions`, {
    method: 'POST',
    body: JSON.stringify(original),
  }).then(
    (version) => {
      pendingSaves.delete(sessionId);
      return version;
    },
    (reason: unknown) => {
      /** 明确拒绝写入后释放请求；网络与服务异常保留原参数供幂等确认。 */
      const status = (reason as ApiError)?.status;
      if (status !== undefined && [400, 401, 403, 404, 409, 413, 422].includes(status)) {
        pendingSaves.delete(sessionId);
      } else pendingSaves.set(sessionId, { request: original, error: errorMessage(reason) });
      throw reason;
    },
  );
  /** React 尚未订阅或组件已卸载时也消费拒绝；原 Promise 仍向 UI 返回失败。 */
  void entry.promise.catch(() => undefined);
  pendingSaves.set(sessionId, entry);
  return entry;
}

/** 本人列表必须返回原请求 ID；缺失时不能创建新 ID 冒充同一版本重试。 */
export function versionRetryRequest(version: VersionMetadata): VersionSaveRequest | null {
  if (!version.clientRequestId) return null;
  return {
    clientRequestId: version.clientRequestId,
    name: version.name,
    baseFileRevision: version.sourceFileRevision,
  };
}

/** 仅明确的 passed 表示规则检查通过；未知/缺失结果不能由保存成功推断。 */
export function versionValidationLabel(summary: VersionMetadata['validationSummary']): string {
  switch (summary?.status) {
    case 'passed':
      return '规则检查：通过';
    case 'failed':
      return '规则检查：未通过';
    case 'stale':
      return '规则检查：已过期';
    case 'not_checked':
    case undefined:
      return '规则检查：未检查';
    default:
      return `规则检查：未知（${summary?.status}）`;
  }
}

/** 展示冻结版本的元数据；ZIP 由同源链接携带浏览器登录态下载。 */
export function VersionEntry({
  sessionId,
  version,
  disabled,
  retry,
}: {
  sessionId: string;
  version: VersionMetadata;
  disabled: boolean;
  retry: (request: VersionSaveRequest) => void;
}) {
  const request = versionRetryRequest(version);
  return (
    <li className="version-entry">
      <div className="version-entry-heading">
        <strong>{version.name}</strong>
        <Tag
          color={
            version.status === 'ready' ? 'green' : version.status === 'failed' ? 'red' : 'gold'
          }
        >
          {version.status === 'ready'
            ? '已暂存'
            : version.status === 'failed'
              ? '暂存失败'
              : '暂存中'}
        </Tag>
      </div>
      <div className="version-entry-meta">
        <span>
          {version.target.toUpperCase()} · 文件修订 {version.sourceFileRevision}
        </span>
        <time dateTime={version.createdAt}>{formatTime(version.createdAt)}</time>
        <span>{versionValidationLabel(version.validationSummary)}</span>
      </div>
      {version.error?.message && <p className="version-error">{version.error.message}</p>}
      <div className="version-entry-actions">
        {version.status === 'ready' && (
          <Button
            size="small"
            href={`?view=works&version=${id(version.versionId)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            查看版本
          </Button>
        )}
        {version.status === 'ready' ? (
          <Button
            size="small"
            href={`/api/d2c/sessions/${id(sessionId)}/versions/${id(version.versionId)}/archive`}
          >
            下载 ZIP
          </Button>
        ) : (
          <Button
            size="small"
            disabled={disabled || !request}
            onClick={() => request && retry(request)}
          >
            {version.status === 'saving' ? '重试暂存' : '重试'}
          </Button>
        )}
        {version.status !== 'ready' && !request && <small>缺少原请求编号，请刷新列表后重试</small>}
      </div>
    </li>
  );
}

/** 按SSE通知或手动操作刷新列表；写入只等待冻结快照，打包由服务端继续。 */
export default function VersionsPanel({
  sessionId,
  refresh = 0,
}: {
  sessionId: string;
  refresh?: number;
}) {
  /** 外层 key 隔离会话状态；内部查询仍使用 AbortSignal 清理过期结果。 */
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [list, setList] = useState<VersionPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [notice, setNotice] = useState<VersionMetadata | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(() => pendingSaves.get(sessionId));
  const posting = !!pending?.promise;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    data<VersionPage>(`/sessions/${id(sessionId)}/versions?page=${page}&pageSize=10`, {
      signal: controller.signal,
    }).then(
      (value) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(value?.rows) || !Number.isFinite(value.total)) {
          setReadError('版本列表响应无效，请检查服务版本');
        } else if (value.page !== page || value.pageSize !== 10) {
          setReadError('版本分页响应无效，请刷新重试');
        } else if (page > 1 && !value.rows.length) {
          setPage(Math.max(1, Math.ceil(value.total / 10)));
        } else {
          setList(value);
          setNotice((prior) =>
            prior ? (value.rows.find((row) => row.versionId === prior.versionId) ?? prior) : prior,
          );
          setReadError('');
        }
        setLoading(false);
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        setReadError(errorMessage(reason));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [sessionId, page, reload, refresh]);

  useEffect(() => {
    if (!pending?.promise) return;
    let active = true;
    pending.promise.then(
      (version) => {
        if (!active) return;
        setPending(undefined);
        setSaveError('');
        setOpen(false);
        setName('');
        setNotice(version);
        setPage(1);
        setReload((value) => value + 1);
      },
      (reason: unknown) => {
        if (!active) return;
        setPending(pendingSaves.get(sessionId));
        setSaveError(
          (reason as ApiError)?.status === 409
            ? `${errorMessage(reason)}。请关闭弹窗并刷新文件列表后重新暂存。`
            : errorMessage(reason),
        );
      },
    );
    return () => {
      active = false;
    };
  }, [pending, sessionId]);

  /** 保留请求结果不确定时的名称、修订与 ID，写入同步锁由共享请求表提供。 */
  function submit(request: VersionSaveRequest) {
    try {
      setPending(startVersionSave(sessionId, request));
      setOpen(false);
      setSaveError('');
    } catch (reason) {
      setSaveError(errorMessage(reason));
    }
  }

  /** 暂存提交时由服务端冻结最新已保存文件；弹窗期间Agent可继续执行。 */
  function openSave() {
    setOpen(true);
  }

  return (
    <details className="versions-disclosure">
      <summary>
        <Icon name="arrow" />
        <span className="versions-heading">版本</span>
        <span
          className="versions-actions"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Button
            size="small"
            icon={<Icon name="refresh" />}
            aria-label="刷新版本列表"
            title="刷新版本列表"
            loading={loading}
            onClick={() => setReload((value) => value + 1)}
          />
          <Button size="small" type="primary" disabled={!!pending} onClick={openSave}>
            暂存版本
          </Button>
        </span>
        <span className="versions-expand-label">展开</span>
        <span className="versions-collapse-label">收起</span>
      </summary>
      <section className="versions-panel" aria-label="暂存版本">
        {readError && <Alert type="error" showIcon title={readError} />}
        {(saveError || pending?.error) && (
          <Alert type="error" showIcon title={saveError || pending?.error} />
        )}
        {pending && (
          <div className="versions-pending" role="status">
            <span>
              {posting ? '正在提交后台暂存' : '暂存请求未确认'}：
              {pending.request.name.trim() || '自动命名'}（
              {pending.request.baseFileRevision === undefined
                ? '提交时已保存文件'
                : `文件修订 ${pending.request.baseFileRevision}`}
              ）
            </span>
            {!posting && (
              <Button size="small" disabled={posting} onClick={() => submit(pending.request)}>
                重试同一次暂存
              </Button>
            )}
          </div>
        )}
        {notice && (
          <Alert
            type={
              notice.status === 'failed' ? 'error' : notice.status === 'ready' ? 'success' : 'info'
            }
            showIcon
            title={`${notice.name}：${notice.status === 'ready' ? '已暂存' : notice.status === 'failed' ? '暂存失败' : '后台暂存中，可继续操作'}`}
            description={notice.error?.message || versionValidationLabel(notice.validationSummary)}
          />
        )}
        <div className="versions-scroll" aria-busy={loading}>
          {loading && !list && <p className="versions-hint">正在加载版本…</p>}
          {!loading && list?.rows.length === 0 && <p className="versions-hint">暂无暂存版本。</p>}
          {list && (
            <ul className="versions-list">
              {list.rows.map((version) => (
                <VersionEntry
                  key={version.versionId}
                  sessionId={sessionId}
                  version={version}
                  disabled={!!pending}
                  retry={submit}
                />
              ))}
            </ul>
          )}
        </div>
        {!!list?.total && (
          <Pagination
            size="small"
            current={list.page}
            pageSize={10}
            total={list.total}
            showSizeChanger={false}
            disabled={loading}
            onChange={setPage}
          />
        )}
        <Modal
          title="暂存版本"
          open={open}
          okText={pending ? '重试同一次暂存' : '暂存'}
          cancelText="关闭"
          maskClosable={false}
          okButtonProps={{ disabled: posting }}
          onCancel={() => {
            setOpen(false);
          }}
          onOk={() => {
            if (pending) submit(pending.request);
            else {
              submit({
                clientRequestId: crypto.randomUUID(),
                name: name.trim(),
              });
            }
          }}
        >
          <label htmlFor="version-name">版本名称（可选）</label>
          <Input
            id="version-name"
            placeholder="留空按会话名、文件修订和版本序号自动命名"
            autoFocus
            value={pending?.request.name ?? name}
            disabled={!!pending}
            onChange={(event) => setName(event.target.value)}
          />

          <p className="versions-hint">
            暂存提交时已保存的文件，AI可继续执行；未生成或尚未保存的内容不包含在此版本中。
          </p>
          {(saveError || pending?.error) && (
            <Alert type="error" showIcon title={saveError || pending?.error} />
          )}
        </Modal>
      </section>
    </details>
  );
}
