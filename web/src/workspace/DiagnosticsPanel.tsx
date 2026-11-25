import { formatTime } from './time';
import React, { useEffect, useState } from 'react';
import { Alert, Button, Drawer, Empty, Select, Spin } from 'antd';
import Icon from '../components/Icon';
import { data, id } from './api';
import { getEventFailure } from './timeline';
import type { SessionDiagnostics } from './types';
import SubagentDiagnostics from './SubagentDiagnostics';
import { ErrorDiagnosticsPanel } from './ErrorDiagnostics';

/** 新增字段可缺省，兼容旧诊断接口；服务端只投影校验后的计时与编号。 */
type ModelTimingStep = SessionDiagnostics['steps'][number] & {
  gatewayRequestId?: string | null;
  firstChunkMs?: number | null;
  afterFirstChunkMs?: number | null;
};

const statuses: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  stopping: '正在停止',
  waiting_input: '等待回答',
  interrupted: '已中断',
  paused: '已暂停',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  completed: '已完成',
  unknown: '状态未知',
};

/** 仅使用固定状态映射，未知状态不回显任意服务端字段。 */
function statusLabel(status: string | null): string {
  return status && Object.hasOwn(statuses, status) ? statuses[status] : '状态未知';
}

/** 未报告时保留未知语义；只有明确数字才能显示零。 */
export function diagnosticNumber(value: number | null): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value.toLocaleString()
    : '未报告';
}

/** Token 用量按千、百万缩写，最多两位小数；缺失用量保持未报告。 */
export function diagnosticTokens(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1000)
    return diagnosticNumber(value);
  const divisor = value >= 1_000_000 ? 1_000_000 : 1000;
  return `${(value / divisor).toLocaleString('en-US', { maximumFractionDigits: 2, useGrouping: false })}${divisor === 1000 ? 'K' : 'M'}`;
}

/** 旧记录无耗时时不推测；有效毫秒转换为可读秒数。 */
export function diagnosticDuration(value: number | null): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `${(value / 1000).toFixed(1)} 秒`
    : '耗时未知';
}

/** 以服务端累计值为基准，只有仍在计时的轮次才递增，不触发额外请求。 */
export function sessionElapsed(snapshot: SessionDiagnostics, now: number): number | null {
  const value = snapshot.sessionElapsedMs;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const at = Date.parse(snapshot.observedAt);
  const count = snapshot.sessionRunningCount ?? 0;
  return value + (Number.isFinite(at) ? Math.max(0, now - at) * count : 0);
}

/** 累计和本轮耗时采用时分秒，省略不足的高位单位。 */
export function totalDuration(value: number | null): string {
  if (value === null) return '耗时未知';
  const seconds = Math.floor(value / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours ? `${hours} 小时 ` : ''}${hours || minutes ? `${minutes} 分 ` : ''}${seconds % 60} 秒`;
}

/** 无效或缺失时间保持空态，不显示 Invalid Date。 */
function timeLabel(value: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '未记录';
}

/** 正在运行的步骤可按本地时钟更新；不触发接口读取。 */
function stepDuration(step: SessionDiagnostics['steps'][number], now: number): number | null {
  if (step.durationMs !== null) return step.durationMs;
  if (step.type === 'tool' || step.status !== 'running' || !step.startedAt) return null;
  const start = Date.parse(step.startedAt);
  return Number.isFinite(start) ? Math.max(0, now - start) : null;
}

/** 展示公开执行元数据与固定错误分类，忽略异常原文和额外私有字段。 */
export function DiagnosticsContent({
  snapshot,
  now,
}: {
  snapshot: SessionDiagnostics;
  now: number;
}) {
  const failure = snapshot.failure
    ? getEventFailure({
        entryId: 'diagnostics',
        sessionId: snapshot.sessionId,
        seq: snapshot.timelineSeq,
        at: snapshot.observedAt,
        runId: snapshot.runId,
        kind: 'run_status',
        data: { status: 'failed', failure: snapshot.failure },
      })
    : null;
  const currentTypes = {
    model: '模型调用',
    tool: '等待/执行工具',
    summary: '上下文摘要',
    subagent: '专家执行',
  };
  const usage = snapshot.usage;
  const outcomes = [
    ['完成', usage.completedRequests],
    ['失败', usage.failedRequests],
    ['中断', usage.interruptedRequests],
    ['未结束', usage.pendingRequests],
  ] as const;
  return (
    <div className="diagnostics-content">
      <section className="diagnostics-overview" aria-label="执行概览">
        <div className="diagnostics-overview-heading">
          <div>
            <span className="diagnostics-eyebrow">{snapshot.runId ? '本轮执行' : '执行概览'}</span>
            <strong>{snapshot.modelName ?? '尚无模型记录'}</strong>
          </div>
          <span className="diagnostics-status" data-status={snapshot.status ?? 'unknown'}>
            {snapshot.runId ? statusLabel(snapshot.status) : '尚未执行'}
          </span>
        </div>
        <div className="diagnostics-metrics">
          <div>
            <span>累计执行时间</span>
            <strong>{totalDuration(sessionElapsed(snapshot, now))}</strong>
            <small>会话全部轮次</small>
          </div>
          <div>
            <span>本轮耗时</span>
            <strong>{totalDuration(snapshot.elapsedMs)}</strong>
            <small>含排队及等待回答</small>
          </div>
          <div>
            <span>模型请求</span>
            <strong>{diagnosticNumber(usage.requests)}</strong>
            <small>主模型、子 Agent 与摘要</small>
          </div>
          <div>
            <span>总 Token</span>
            <strong title={diagnosticNumber(usage.totalTokens)}>
              {diagnosticTokens(usage.totalTokens)}
            </strong>
            <small>{usage.usageComplete === true ? '用量已完整报告' : '以已报告用量为准'}</small>
          </div>
        </div>
        <p className="diagnostics-note">
          累计当前会话全部轮次，含排队和等待回答；不计两轮之间的空闲时间。
        </p>
      </section>
      <section className="diagnostics-section" aria-label="模型用量">
        <div className="diagnostics-section-heading">
          <h3>模型用量</h3>
          <span className="diagnostics-caption">
            已报告用量的请求 {diagnosticNumber(usage.reportedRequests)} /{' '}
            {diagnosticNumber(usage.requests)}
          </span>
        </div>
        <div className="diagnostics-token-grid">
          {[
            ['输入 Token', usage.inputTokens],
            ['输出 Token', usage.outputTokens],
            ['总 Token', usage.totalTokens],
          ].map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong title={diagnosticNumber(value as number | null)}>
                {diagnosticTokens(value as number | null)}
              </strong>
            </div>
          ))}
        </div>
        <div className="diagnostics-outcomes">
          {outcomes.map(([label, count]) => (
            <span key={label}>
              {label}
              <b>{diagnosticNumber(count ?? null)}</b>
            </span>
          ))}
        </div>
        <p className="diagnostics-note">
          {usage.usageComplete === false && '当前用量统计不完整，Token 数只包含网关已报告的部分。'}
          未报告用量不代表零消耗。
        </p>
      </section>
      {snapshot.failure && (
        <Alert
          className="diagnostics-failure"
          type="warning"
          showIcon
          title={failure?.message ?? '执行异常（分类未知）'}
          description={
            <div>
              <p>{failure?.suggestion ?? '请联系服务端排查。'}</p>
              <div>错误分类：{failure?.stage ?? '未知阶段'}</div>
              {failure?.databaseCode && (
                <div>
                  数据库错误：<code>{failure.databaseCode}</code>
                  {failure.databaseErrno ? ` · ${failure.databaseErrno}` : ''}
                  {failure.databaseSqlState ? ` · SQLSTATE ${failure.databaseSqlState}` : ''}
                </div>
              )}
              <div>
                排查编号：<code>{failure?.errorId ?? '未提供'}</code>
              </div>
            </div>
          }
        />
      )}
      <ErrorDiagnosticsPanel
        sessionId={snapshot.sessionId}
        runId={snapshot.runId}
        revision={snapshot.timelineSeq}
      />
      {!snapshot.runId && <Empty description="暂无执行轮次" />}
      <section className="diagnostics-section" aria-label="执行状态">
        <div className="diagnostics-section-heading">
          <h3>执行状态</h3>
          <Icon name="activity" />
        </div>
        <div className="diagnostics-current">
          <span className="diagnostics-current-dot" data-active={!!snapshot.current} />
          <span>
            {snapshot.current
              ? `${currentTypes[snapshot.current.type]} · ${snapshot.current.name}`
              : '暂无活跃步骤'}
          </span>
        </div>
        <dl className="diagnostics-facts">
          <div>
            <dt>创建时间</dt>
            <dd>{timeLabel(snapshot.createdAt)}</dd>
          </div>
          <div>
            <dt>结束时间</dt>
            <dd>{timeLabel(snapshot.finishedAt)}</dd>
          </div>
        </dl>
      </section>

      <SubagentDiagnostics
        diagnostics={snapshot.agentDiagnostics}
        observedAt={snapshot.observedAt}
        now={now}
      />
      <section className="diagnostics-section" aria-label="耗时步骤">
        <div className="diagnostics-section-heading">
          <h3>耗时步骤</h3>
          <span className="diagnostics-caption">{snapshot.steps.length} 条记录</span>
        </div>
        <p className="diagnostics-note">
          工具含排队时间；缺少开始或结果的记录显示耗时未知。模型分段以客户端收到首个实际输出为界，
          包括正文、思考或工具调用分片；无输出和旧记录保持未知。失败或中断的耗时截至请求结束。
          无法测量网关内部排队，不能从首块耗时直接推断排队时间。
        </p>
        {!snapshot.steps.length ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无步骤记录（旧记录可能未采集）"
          />
        ) : (
          <ol className="diagnostics-steps">
            {snapshot.steps.map((step: ModelTimingStep) => (
              <li key={step.id} data-status={step.status}>
                <span className="diagnostics-step-icon">
                  <Icon
                    name={
                      step.type === 'tool'
                        ? 'code'
                        : step.type === 'summary'
                          ? 'file'
                          : step.type === 'subagent'
                            ? 'chat'
                            : 'spark'
                    }
                  />
                </span>
                <div className="diagnostics-step-content">
                  <div className="diagnostics-step-heading">
                    <strong title={step.name}>{step.name}</strong>
                    <span className="diagnostics-step-status">
                      {step.type === 'tool' && step.status === 'running'
                        ? '等待/执行中'
                        : statusLabel(step.status)}
                    </span>
                  </div>
                  <span className="diagnostics-step-time">{timeLabel(step.startedAt)}</span>
                  {(step.requestedReasoningEffort === 'low' ||
                    step.requestedReasoningEffort === 'high') && (
                    <span
                      className="diagnostics-step-time"
                      title="表示提交给网关的请求参数，不保证网关采纳"
                    >
                      {step.requestedReasoningEffort === 'low' ? '请求低思考' : '请求高思考'}
                      {step.reasoningEscalated === true && ' · 校验后升级'}
                    </span>
                  )}
                  {step.type !== 'tool' && (
                    <dl className="diagnostics-model-timing">
                      <div>
                        <dt>请求开始→首块</dt>
                        <dd>{diagnosticDuration(step.firstChunkMs ?? null)}</dd>
                      </div>
                      <div>
                        <dt>首块→结束</dt>
                        <dd>{diagnosticDuration(step.afterFirstChunkMs ?? null)}</dd>
                      </div>
                      <div className="diagnostics-gateway-id">
                        <dt>网关请求编号</dt>
                        <dd>
                          <code>{step.gatewayRequestId ?? '未知'}</code>
                        </dd>
                      </div>
                    </dl>
                  )}
                  {typeof step.feedbackCode === 'string' && step.feedbackCode && (
                    <div className="diagnostics-feedback">
                      反馈分类：<code>{step.feedbackCode}</code>
                    </div>
                  )}
                </div>
                <span className="diagnostics-step-duration">
                  {step.type !== 'tool' && '总耗时 '}
                  {diagnosticDuration(stepDuration(step, now))}
                </span>
              </li>
            ))}
          </ol>
        )}
        {snapshot.hasMore && (
          <p className="diagnostics-note">仅展示部分步骤，更早记录未在此列出。</p>
        )}
      </section>
      <details className="diagnostics-details">
        <summary>
          <Icon name="chevron" />
          <span>会话最新保存记录</span>
          <span className="diagnostics-caption">保存与恢复</span>
        </summary>
        <dl className="diagnostics-facts">
          <div>
            <dt>保存状态</dt>
            <dd>{snapshot.checkpoint.available ? '已保存' : '暂无可用检查点'}</dd>
          </div>
          <div>
            <dt>保存时间</dt>
            <dd>{timeLabel(snapshot.checkpoint.savedAt)}</dd>
          </div>
          <div>
            <dt>租约</dt>
            <dd>
              {snapshot.lease.expired
                ? '已过期'
                : snapshot.lease.expiresAt
                  ? `有效至 ${timeLabel(snapshot.lease.expiresAt)}`
                  : '无活跃租约'}
            </dd>
          </div>
          <div className="diagnostics-fact-wide">
            <dt>可尝试操作</dt>
            <dd>
              {snapshot.checkpoint.continuation === 'answer'
                ? '可尝试回答：请返回会话回答当前问题'
                : snapshot.checkpoint.continuation === 'resume'
                  ? '可尝试继续：请返回会话核对状态后继续'
                  : '当前无可用回答或继续状态'}
            </dd>
          </div>
          {snapshot.runId && (
            <div className="diagnostics-fact-wide">
              <dt>runId</dt>
              <dd>
                <code>{snapshot.runId}</code>
              </dd>
            </div>
          )}
        </dl>
        <p className="diagnostics-note">
          保存记录属于整个会话，不代表所选历史轮次的检查点；可尝试操作不保证成功。
        </p>
      </details>
    </div>
  );
}

/** 单次只读查询核对归属和轮次；即使传输层忽略取消，也不交付旧数据。 */
export async function readDiagnostics(
  sessionId: string,
  runId: string | undefined,
  signal: AbortSignal,
): Promise<SessionDiagnostics | null> {
  if (signal.aborted) return null;
  const result = await data<SessionDiagnostics>(
    `/sessions/${id(sessionId)}/diagnostics${runId ? `?runId=${id(runId)}` : ''}`,
    { signal },
  );
  if (signal.aborted) return null;
  if (result.sessionId !== sessionId || (runId && result.runId !== runId))
    throw new Error('诊断记录不匹配');
  return result;
}

/** Drawer 关闭时不请求；切换轮次、会话或 revision 时中止并隔离旧响应。 */
export default function DiagnosticsPanel({
  sessionId,
  open,
  revision,
  onClose,
}: {
  sessionId: string;
  open: boolean;
  revision: number;
  onClose: () => void;
}) {
  const [runId, setRunId] = useState<string | undefined>();
  const [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<SessionDiagnostics | null>(null);
  const [runs, setRuns] = useState<SessionDiagnostics['runs']>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setSnapshot((current) =>
      current?.sessionId === sessionId && (!runId || current.runId === runId) ? current : null,
    );
    setError('');
    setLoading(true);
    /** 执行事件突发时合并一次读取，不做定时轮询。 */
    const timer = setTimeout(() => {
      readDiagnostics(sessionId, runId, controller.signal)
        .then((result) => {
          if (!result || controller.signal.aborted) return;
          setNow(Date.now());
          setSnapshot(result);
          setRuns(result.runs.slice(0, 10));
        })
        .catch(() => {
          if (!controller.signal.aborted) setError('执行诊断读取失败，请手动刷新重试。');
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 100);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [sessionId, open, runId, revision, refresh]);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);
  const visibleSnapshot =
    snapshot?.sessionId === sessionId && (!runId || snapshot.runId === runId) ? snapshot : null;
  return (
    <Drawer
      title={
        <div className="diagnostics-drawer-title">
          <div>
            <strong>执行诊断</strong>
          </div>
        </div>
      }
      rootClassName="diagnostics-drawer"
      open={open}
      onClose={onClose}
      size={640}
      styles={{ wrapper: { maxWidth: '100vw' }, body: { padding: 0 } }}
    >
      <div className="diagnostics-filterbar">
        <div className="diagnostics-run-selector">
          <label htmlFor="diagnostics-run">查看轮次</label>
          <Select
            id="diagnostics-run"
            aria-label="诊断轮次"
            value={runId ?? ''}
            onChange={(value) => {
              setSnapshot(null);
              setRunId(value || undefined);
            }}
            options={[
              { value: '', label: '当前或最新轮次' },
              ...runs.map((run) => ({
                value: run.runId,
                label: `${timeLabel(run.createdAt)} · ${statusLabel(run.status)} · ${run.runId.slice(0, 8)}`,
              })),
            ]}
          />
        </div>
        <Button
          className="diagnostics-refresh"
          icon={<Icon name="refresh" />}
          onClick={() => setRefresh((value) => value + 1)}
          loading={loading}
          aria-label="手动刷新执行诊断"
          title="手动刷新执行诊断"
        />
        <span className="diagnostics-updated" role="status">
          {loading
            ? '更新中…'
            : visibleSnapshot
              ? `更新于 ${formatTime(visibleSnapshot.observedAt)}`
              : '等待读取'}
        </span>
      </div>
      <div className="diagnostics-body">
        {error && <Alert type="error" showIcon title={error} />}
        {loading && !visibleSnapshot && (
          <div className="diagnostics-loading" role="status">
            <Spin />
            <span>读取执行诊断…</span>
          </div>
        )}
        {open && visibleSnapshot && <DiagnosticsContent snapshot={visibleSnapshot} now={now} />}
      </div>
    </Drawer>
  );
}
