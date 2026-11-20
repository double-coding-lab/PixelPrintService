import React, { useEffect, useRef, useState } from 'react';
import type {
  DiagnosticError,
  DiagnosticErrorCategory,
  ErrorDiagnostics,
  ErrorDiagnosticsQuery,
} from '../../../shared/errorDiagnostics';
import { data, id } from './api';

const categories: Record<DiagnosticErrorCategory, string> = {
  model: '模型调用异常',
  tool: '工具执行异常或纠正',
  subagent: '子 Agent 执行异常',
  storage: '保存或存储异常',
  preview: '预览构建或检查异常',
  database: '数据库操作异常',
  execution: '执行流程异常',
  rule: '规则检查未通过',
};
const scopes = { main: '主 Agent', subagent: '子 Agent', unknown: '归属未知' };
const recoveries = {
  retrying: '正在重试',
  subsequent_success: '后续已成功（保留本次错误）',
  unresolved: '尚未恢复',
  unknown: '恢复状态未知',
};
const roles: Record<string, string> = {
  main: '主 Agent',
  ui: 'UI 实现',
  rule_scan: '规则扫描',
  design: '设计专家',
  review: '审查专家',
};

type ErrorItem = Omit<DiagnosticError, 'category'> & {
  category: DiagnosticErrorCategory | 'unknown';
};
export type ErrorDiagnosticsSnapshot = Omit<ErrorDiagnostics, 'items'> & { items: ErrorItem[] };

/** 未知枚举只显示固定标签，不回显任意上游文案。 */
function label(labels: Record<string, string>, value: unknown, fallback: string): string {
  return typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value] : fallback;
}

/** 仅接收有界文本；不序列化对象、异常或额外私有字段。 */
function text(value: unknown, limit = 256): string | null {
  return typeof value === 'string' && value.trim() ? value.slice(0, limit) : null;
}

/** 计数或游标缺失时拒绝整个响应，避免把旧接口或坏数据当作零。 */
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('错误诊断响应无效');
  return value;
}

/** 白名单投影 DTO；message 是后端重建的固定说明，stack 及额外私有字段不进入 UI。 */
export function projectErrorDiagnostics(
  input: unknown,
  sessionId: string,
  query: ErrorDiagnosticsQuery = {},
): ErrorDiagnosticsSnapshot {
  if (!input || typeof input !== 'object') throw new Error('错误诊断响应无效');
  const value = input as Record<string, unknown>;
  const snapshotSeq = count(value.snapshotSeq);
  const snapshotToken = value.snapshotToken;
  if (typeof snapshotToken !== 'string' || !/^[a-f0-9]{64}$/.test(snapshotToken))
    throw new Error('错误诊断快照无效');
  if (
    value.sessionId !== sessionId ||
    (query.snapshotSeq !== undefined && query.snapshotSeq !== snapshotSeq) ||
    (query.snapshotToken !== undefined && query.snapshotToken !== snapshotToken)
  )
    throw new Error('错误诊断记录不匹配');
  if (!Array.isArray(value.items) || value.items.length > 50 || typeof value.hasMore !== 'boolean')
    throw new Error('错误诊断响应无效');
  const nextBefore = value.nextBefore === null ? null : count(value.nextBefore);
  if (value.hasMore && (nextBefore === null || nextBefore <= (query.before ?? 0)))
    throw new Error('错误诊断分页无效');
  const coverage = value.coverage as Record<string, unknown> | null;
  if (
    !coverage ||
    typeof coverage.complete !== 'boolean' ||
    coverage.historical !== 'saved_events_only'
  )
    throw new Error('错误诊断覆盖信息无效');
  const items = value.items.map((raw): ErrorItem => {
    if (!raw || typeof raw !== 'object') throw new Error('错误诊断记录无效');
    const item = raw as Record<string, unknown>;
    const itemId = text(item.id);
    const runId = text(item.runId);
    if (
      !itemId ||
      !runId ||
      (query.runId && item.runId !== query.runId) ||
      (query.category && item.category !== query.category) ||
      (query.scope && item.scope !== query.scope)
    )
      throw new Error('错误诊断记录不匹配');
    const seq = item.seq === null ? null : count(item.seq);
    if (seq !== null && seq > snapshotSeq) throw new Error('错误诊断分页无效');
    return {
      id: itemId,
      runId,
      seq,
      at: text(item.at),
      category:
        typeof item.category === 'string' && Object.hasOwn(categories, item.category)
          ? (item.category as DiagnosticErrorCategory)
          : 'unknown',
      scope: item.scope === 'main' || item.scope === 'subagent' ? item.scope : 'unknown',
      code:
        typeof item.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(item.code)
          ? item.code
          : 'UNKNOWN',
      message: text(item.message, 512) ?? label(categories, item.category, '执行异常（分类未知）'),
      stage: text(item.stage, 80),
      tool: text(item.tool, 128),
      command: text(item.command, 512),
      agentId: text(item.agentId),
      agentRole: label(roles, item.agentRole, '角色未知'),
      errorId: text(item.errorId),
      requestId: text(item.requestId),
      attempt: item.attempt === null ? null : count(item.attempt),
      recovery:
        typeof item.recovery === 'string' && Object.hasOwn(recoveries, item.recovery)
          ? (item.recovery as DiagnosticError['recovery'])
          : 'unknown',
    };
  });
  return {
    sessionId,
    observedAt: text(value.observedAt) ?? '',
    snapshotSeq,
    snapshotToken,
    total: count(value.total),
    executionErrors: count(value.executionErrors),
    toolCorrections: count(value.toolCorrections),
    ruleFailures: count(value.ruleFailures),
    filteredTotal: count(value.filteredTotal),
    items,
    nextBefore,
    hasMore: value.hasMore,
    coverage: {
      complete: coverage.complete,
      scannedEvents: count(coverage.scannedEvents),
      limit: count(coverage.limit),
      historical: 'saved_events_only',
    },
  };
}

/** GET 固定每页 50 条，分页携带首屏水位和内容 token；取消后不交付旧响应。 */
export async function readErrorDiagnostics(
  sessionId: string,
  query: ErrorDiagnosticsQuery,
  signal: AbortSignal,
): Promise<ErrorDiagnosticsSnapshot | null> {
  if (signal.aborted) return null;
  const params = new URLSearchParams();
  for (const key of [
    'runId',
    'category',
    'scope',
    'before',
    'snapshotSeq',
    'snapshotToken',
  ] as const) {
    if (query[key] !== undefined) params.set(key, String(query[key]));
  }
  params.set('pageSize', '50');
  const result = await data<unknown>(`/sessions/${id(sessionId)}/errors?${params}`, { signal });
  return signal.aborted ? null : projectErrorDiagnostics(result, sessionId, query);
}

/** 复制内容只包含已经投影的排查元数据，不包含异常原文。 */
export function errorDiagnosticText(sessionId: string, item: ErrorItem): string {
  return [
    ['sessionId', sessionId],
    ['id', item.id],
    ['时间', timeLabel(item.at)],
    ['说明', item.message],
    ['错误码', item.code],
    ['runId', item.runId],
    ['Agent', label(scopes, item.scope, '归属未知')],
    ['角色', item.agentRole],
    ['agentId', item.agentId],
    ['阶段', item.stage],
    ['工具', item.tool],
    ['命令', item.command],
    ['errorId', item.errorId],
    ['requestId', item.requestId],
    ['尝试次数', item.attempt],
    ['恢复状态', label(recoveries, item.recovery, '恢复状态未知')],
  ]
    .map(([key, value]) => `${key}: ${value ?? '未记录'}`)
    .join('\n');
}

/** 时间缺失或非法时保持未知。 */
function timeLabel(value: string | null): string {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString()
    : '时间未记录';
}

/** 单条原生详情可键盘展开，刷新通过稳定 id 保留用户选择。 */
function ErrorRecord({
  item,
  sessionId,
  expanded,
  onToggle,
}: {
  item: ErrorItem;
  sessionId: string;
  expanded: boolean;
  onToggle: (open: boolean) => void;
}) {
  const [copyStatus, setCopyStatus] = useState('');
  return (
    <li className="error-diagnostic-record">
      <div className="error-diagnostic-heading">
        <strong>{item.message}</strong>
        <span>{label(recoveries, item.recovery, '恢复状态未知')}</span>
      </div>
      <div className="error-diagnostic-meta">
        <span>{label(categories, item.category, '执行异常（分类未知）')}</span>
        <time dateTime={item.at && Number.isFinite(Date.parse(item.at)) ? item.at : undefined}>
          {timeLabel(item.at)}
        </time>
        <code>{item.code}</code>
      </div>
      <dl className="diagnostics-facts">
        {[
          ['runId', item.runId],
          ['Agent / 角色', `${label(scopes, item.scope, '归属未知')} · ${item.agentRole}`],
          ['工具 / 命令', [item.tool, item.command].filter(Boolean).join(' · ') || '未记录'],
          ['errorId', item.errorId ?? '未记录'],
          ['requestId', item.requestId ?? '未记录'],
        ].map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <details open={expanded} onToggle={(event) => onToggle(event.currentTarget.open)}>
        <summary aria-label={`错误 ${item.id} 的排查明细`}>排查明细</summary>
        <dl className="diagnostics-facts">
          {[
            ['记录 ID', item.id],
            ['agentId', item.agentId ?? '未记录'],
            ['阶段', item.stage ?? '未记录'],
            ['尝试次数', item.attempt ?? '未记录'],
          ].map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          className="error-diagnostic-button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(errorDiagnosticText(sessionId, item));
              setCopyStatus('排查信息已复制');
            } catch {
              setCopyStatus('复制失败，请选择页面上的排查信息复制');
            }
          }}
        >
          复制排查信息
        </button>
        <span role="status" className="diagnostics-caption">
          {copyStatus}
        </span>
      </details>
    </li>
  );
}

/** 统计只采用服务端值；读取期间或失败时不显示零，也不把当前页当成全部记录。 */
export function ErrorDiagnosticsResults({
  snapshot,
  loading,
  error,
  expanded,
  onToggle,
}: {
  snapshot: ErrorDiagnosticsSnapshot | null;
  loading: boolean;
  error: string;
  expanded: ReadonlySet<string>;
  onToggle: (id: string, open: boolean) => void;
}) {
  const available = snapshot && !loading && !error;
  return (
    <>
      <div className="diagnostics-metrics error-diagnostic-metrics" aria-label="错误统计">
        {[
          ['错误总数（不含规则未通过）', snapshot?.total],
          ['执行错误', snapshot?.executionErrors],
          ['工具纠正数', snapshot?.toolCorrections],
          ['规则未通过数', snapshot?.ruleFailures],
        ].map(([key, value]) => (
          <div key={key}>
            <span>{key}</span>
            <strong>{available ? value?.toLocaleString() : '—'}</strong>
          </div>
        ))}
      </div>
      <p className="diagnostics-note">
        历史按已保存事件统计，未保存的历史错误无法补回；不受最近 10
        轮或已加载聊天事件限制。错误总数包含执行错误和工具纠正，规则未通过单独计数、不计入错误总数。
      </p>
      {loading && <p role="status">正在读取错误诊断，统计尚未确认…</p>}
      {error && (
        <p role="alert" className="error-diagnostic-warning">
          {error}
        </p>
      )}
      {snapshot && (
        <>
          {(loading || error) && (
            <p className="error-diagnostic-warning">以下为上次读取记录，当前统计尚未确认。</p>
          )}
          {!snapshot.coverage.complete && (
            <p className="error-diagnostic-warning" role="note">
              覆盖不完整：已扫描 {snapshot.coverage.scannedEvents.toLocaleString()} 条事件（上限{' '}
              {snapshot.coverage.limit.toLocaleString()}
              ）。服务端计数仅涵盖已扫描记录，不能视为全部历史错误。
            </p>
          )}
          {available && (
            <p className="diagnostics-note">
              匹配记录数（含规则未通过） {snapshot.filteredTotal.toLocaleString()} · 已加载{' '}
              {snapshot.items.length.toLocaleString()} 条
            </p>
          )}
          <ol className="error-diagnostic-list" aria-label="错误记录">
            {snapshot.items.map((item) => (
              <ErrorRecord
                key={item.id}
                item={item}
                sessionId={snapshot.sessionId}
                expanded={expanded.has(item.id)}
                onToggle={(open) => onToggle(item.id, open)}
              />
            ))}
          </ol>
          {available && !snapshot.items.length && (
            <p>
              {snapshot.hasMore
                ? '本页暂无记录，请继续加载。'
                : snapshot.coverage.complete
                  ? '已保存事件中暂无匹配的错误记录。'
                  : '已扫描事件中暂无匹配记录，其他历史尚未覆盖。'}
            </p>
          )}
          {snapshot.hasMore && (
            <p className="diagnostics-note">还有更早记录，当前列表尚未完整加载。</p>
          )}
          {available && !snapshot.hasMore && (
            <p className="diagnostics-note">
              当前快照的可用记录已加载；历史范围仍以保存事件和覆盖情况为准。
            </p>
          )}
        </>
      )}
    </>
  );
}

type Props = { sessionId: string; runId: string | null; revision: number };
type State = {
  key: string;
  filterKey: string;
  snapshot: ErrorDiagnosticsSnapshot | null;
  loading: boolean;
  error: string;
  paging: boolean;
  pageError: string;
  pageExpired: boolean;
};

/** 会话或父级所选轮次切换时恢复会话全部统计，revision 更新不重建组件。 */
export function ErrorDiagnosticsPanel(props: Props) {
  return (
    <SessionErrorDiagnostics key={JSON.stringify([props.sessionId, props.runId])} {...props} />
  );
}

/** 单请求代次同时保护首屏和分页；卸载、筛选和刷新均取消旧请求。 */
function SessionErrorDiagnostics({ sessionId, runId, revision }: Props) {
  const [onlyRun, setOnlyRun] = useState(false);
  const [category, setCategory] = useState<DiagnosticErrorCategory | ''>('');
  const [scope, setScope] = useState<DiagnosticError['scope'] | ''>('');
  const [refresh, setRefresh] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const filterKey = JSON.stringify([sessionId, onlyRun ? runId : null, category, scope]);
  const key = JSON.stringify([filterKey, revision, refresh]);
  const query: ErrorDiagnosticsQuery = {
    ...(onlyRun && runId ? { runId } : {}),
    ...(category ? { category } : {}),
    ...(scope ? { scope } : {}),
  };
  const [state, setState] = useState<State>({
    key: '',
    filterKey: '',
    snapshot: null,
    loading: true,
    error: '',
    paging: false,
    pageError: '',
    pageExpired: false,
  });
  const active = useRef<{
    generation: number;
    controller: AbortController | null;
    paging: boolean;
  }>({ generation: 0, controller: null, paging: false });
  useEffect(() => {
    const generation = ++active.current.generation;
    const controller = new AbortController();
    active.current.controller = controller;
    active.current.paging = false;
    setState((current) => ({
      key,
      filterKey,
      snapshot: current.filterKey === filterKey ? current.snapshot : null,
      loading: true,
      error: '',
      paging: false,
      pageError: '',
      pageExpired: false,
    }));
    readErrorDiagnostics(sessionId, query, controller.signal)
      .then((snapshot) => {
        if (snapshot && !controller.signal.aborted && active.current.generation === generation)
          setState({
            key,
            filterKey,
            snapshot,
            loading: false,
            error: '',
            paging: false,
            pageError: '',
            pageExpired: false,
          });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && active.current.generation === generation)
          setState((current) => ({
            ...current,
            loading: false,
            error:
              (error as { status?: number })?.status === 404
                ? '错误诊断接口暂不可用（404），统计未能读取。'
                : '错误诊断读取失败，统计未能读取，请刷新重试。',
          }));
      });
    return () => {
      controller.abort();
      active.current.generation++;
    };
    // key includes the complete query, revision and manual refresh version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const snapshot = state.filterKey === filterKey ? state.snapshot : null;
  const loading = state.key !== key || state.loading;
  /** 翻页只使用已展示快照的水位和游标，不从条目数量推算。 */
  async function loadMore() {
    if (
      !snapshot?.hasMore ||
      snapshot.nextBefore === null ||
      loading ||
      state.error ||
      state.pageExpired ||
      active.current.paging
    )
      return;
    const { generation, controller } = active.current;
    if (!controller || controller.signal.aborted) return;
    active.current.paging = true;
    setState((current) => ({ ...current, paging: true, pageError: '' }));
    try {
      const page = await readErrorDiagnostics(
        sessionId,
        {
          ...query,
          snapshotSeq: snapshot.snapshotSeq,
          snapshotToken: snapshot.snapshotToken,
          before: snapshot.nextBefore,
        },
        controller.signal,
      );
      if (!page || controller.signal.aborted || active.current.generation !== generation) return;
      const ids = new Set(snapshot.items.map((item) => item.id));
      setState((current) => ({
        ...current,
        paging: false,
        snapshot: {
          ...snapshot,
          hasMore: page.hasMore,
          nextBefore: page.nextBefore,
          coverage: {
            ...snapshot.coverage,
            complete: snapshot.coverage.complete && page.coverage.complete,
          },
          items: [
            ...snapshot.items,
            ...page.items.filter((item) => {
              if (ids.has(item.id)) return false;
              ids.add(item.id);
              return true;
            }),
          ],
        },
      }));
    } catch (error: unknown) {
      const expired = (error as { status?: number })?.status === 409;
      if (!controller.signal.aborted && active.current.generation === generation)
        setState((current) => ({
          ...current,
          paging: false,
          pageExpired: expired,
          pageError: expired
            ? '错误诊断快照已变化，请刷新后重新查看；已加载记录仍保留。'
            : '更早错误记录读取失败，当前列表尚未完整加载，请重试。',
        }));
    } finally {
      if (active.current.generation === generation) active.current.paging = false;
    }
  }
  return (
    <section
      className="diagnostics-section error-diagnostics"
      aria-label="执行错误诊断"
      aria-busy={loading || state.paging}
    >
      <div className="diagnostics-section-heading">
        <h3>执行错误</h3>
        {(!loading || snapshot) && (
          <button
            type="button"
            className="error-diagnostic-button"
            onClick={() => setRefresh((value) => value + 1)}
            aria-label="刷新错误诊断"
          >
            刷新
          </button>
        )}
      </div>
      <div className="error-diagnostic-filters">
        <label>
          错误轮次
          <select
            aria-label="错误轮次"
            value={onlyRun ? 'current' : 'session'}
            onChange={(event) => setOnlyRun(event.target.value === 'current')}
          >
            <option value="session">会话全部轮次</option>
            <option value="current" disabled={!runId}>
              当前所选轮次{runId ? ` · ${runId}` : '（暂无轮次）'}
            </option>
          </select>
        </label>
        <label>
          错误分类
          <select
            aria-label="错误分类"
            value={category}
            onChange={(event) => setCategory(event.target.value as DiagnosticErrorCategory | '')}
          >
            <option value="">全部分类</option>
            {Object.entries(categories).map(([value, name]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Agent 范围
          <select
            aria-label="Agent 范围"
            value={scope}
            onChange={(event) => setScope(event.target.value as DiagnosticError['scope'] | '')}
          >
            <option value="">全部范围</option>
            {Object.entries(scopes).map(([value, name]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorDiagnosticsResults
        snapshot={snapshot}
        loading={loading}
        error={state.key === key ? state.error : ''}
        expanded={expanded}
        onToggle={(itemId, open) =>
          setExpanded((current) => {
            if (current.has(itemId) === open) return current;
            const next = new Set(current);
            if (open) next.add(itemId);
            else next.delete(itemId);
            return next;
          })
        }
      />
      {state.pageError && (
        <p role="alert" className="error-diagnostic-warning">
          {state.pageError}
        </p>
      )}
      {snapshot?.hasMore && (
        <button
          type="button"
          className="error-diagnostic-button"
          onClick={state.pageExpired ? () => setRefresh((value) => value + 1) : loadMore}
          disabled={loading || !!state.error || state.paging}
        >
          {state.paging
            ? '正在加载更早错误…'
            : state.pageExpired
              ? '刷新并重新读取错误'
              : state.pageError
                ? '重试加载更早错误'
                : '加载更早错误'}
        </button>
      )}
    </section>
  );
}

export default ErrorDiagnosticsPanel;
