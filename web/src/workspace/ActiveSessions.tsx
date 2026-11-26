import { useEffect, useId, useRef, useState } from 'react';
import { Alert, Popover, Spin } from 'antd';
import { page as readPage, errorMessage } from './api';
import type { ActiveSessionSummary } from '../../../shared/activeSessions';
import { useTeams } from './TeamSettings';
import Icon from '../components/Icon';
import { useHeaderPanel } from '../components/HeaderPanels';
import './activeSessions.css';

const labels = {
  queued: '排队中',
  running: '执行中',
  waiting_input: '等待回答',
  stopping: '正在停止',
};

/** 全局快捷入口按需读取元信息；导航仍由父级统一检查未保存草稿。 */
export default function ActiveSessions({
  blocked,
  currentSessionId,
  onSelect,
}: {
  blocked: boolean;
  currentSessionId: string;
  onSelect: (workspaceId: string, sessionId: string) => Promise<boolean>;
}) {
  const { open, setOpen } = useHeaderPanel('active');
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [rows, setRows] = useState<ActiveSessionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [entering, setEntering] = useState('');
  const { teams } = useTeams();
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let reading = false;
    async function load() {
      if (reading || document.hidden || controller.signal.aborted) return;
      reading = true;
      setLoading(true);
      try {
        const result = await readPage<ActiveSessionSummary>(
          `/sessions/active?page=${page}&pageSize=20`,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setRows(result.rows);
        setTotal(result.total);
        setError('');
        if (page > Math.max(1, Math.ceil(result.total / 20))) setPage(1);
      } catch (reason) {
        if (!controller.signal.aborted) {
          setRows([]);
          setError(errorMessage(reason));
        }
      } finally {
        reading = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    const visible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', visible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('focus', visible);
    };
  }, [open, page, refresh]);

  async function enter(row: ActiveSessionSummary) {
    if (blocked || entering || loading) return;
    if (row.sessionId === currentSessionId) {
      setOpen(false);
      return;
    }
    setEntering(row.sessionId);
    try {
      if (await onSelect(row.workspaceId, row.sessionId)) setOpen(false);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setEntering('');
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        if (value) setPage(1);
        setOpen(value);
      }}
      trigger="click"
      placement="bottomRight"
      arrow={false}
      styles={{ container: { padding: 0 } }}
      content={
        <section
          id={panelId}
          className="active-sessions-panel"
          aria-label="进行中会话"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          <div className="active-sessions-heading">
            <h2>
              进行中会话 <span>{loading ? '…' : total}</span>
            </h2>
            <button
              type="button"
              className="icon-button"
              disabled={loading}
              onClick={() => setRefresh((n) => n + 1)}
              aria-label="刷新进行中会话"
            >
              <Icon name="refresh" />
            </button>
          </div>
          <p className="active-sessions-hint">直接进入你有权限查看的活动会话</p>
          {error && <Alert type="error" showIcon title={error} />}
          {loading && (
            <div className="active-sessions-loading" role="status">
              <Spin size="small" /> 正在更新…
            </div>
          )}
          {!loading && !error && !rows.length && (
            <div className="active-sessions-empty">暂无进行中的会话</div>
          )}
          <div className="active-sessions-list">
            {rows.map((row) => (
              <button
                type="button"
                key={row.sessionId}
                className="active-session-row"
                disabled={blocked || loading || !!entering}
                aria-current={currentSessionId === row.sessionId ? 'page' : undefined}
                onClick={() => void enter(row)}
              >
                <span className="active-session-copy">
                  <strong>{row.name || '未命名会话'}</strong>
                  <span className="active-session-workspace">
                    {row.workspaceName}（
                    {row.teamId
                      ? teams.find((team) => team.teamId === row.teamId)?.name || '团队'
                      : '个人'}
                    ） · {row.target === 'rn' ? 'RN' : 'H5'}
                  </span>
                </span>
                <span className={`active-session-status is-${row.status}`}>
                  {entering === row.sessionId ? '正在进入' : labels[row.status]}
                </span>
                <Icon name="arrow" />
              </button>
            ))}
          </div>
          {!error && total > 20 && (
            <div className="active-sessions-pagination">
              <button
                type="button"
                disabled={loading || page <= 1}
                onClick={() => setPage((n) => n - 1)}
              >
                上一页
              </button>
              <span>
                {page} / {Math.ceil(total / 20)}
              </span>
              <button
                type="button"
                disabled={loading || page * 20 >= total}
                onClick={() => setPage((n) => n + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </section>
      }
    >
      <button
        ref={trigger}
        data-header-panel-trigger="active"
        type="button"
        className="active-sessions-trigger"
        disabled={blocked}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
      >
        <Icon name="activity" />
        进行中会话
      </button>
    </Popover>
  );
}
