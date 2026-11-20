import React from 'react';
import type {
  AgentDiagnostics,
  AgentRuleCheck,
  AgentToolDiagnostic,
  AgentUsage,
  SubagentDiagnostic,
} from '../../../shared/agentDiagnostics';

const roles: Record<SubagentDiagnostic['role'], string> = {
  design: '设计专家',
  review: '审查专家',
  rule_scan: '规则扫描',
  ui: 'UI 实现',
};
const statuses: Record<SubagentDiagnostic['status'], string> = {
  queued: '排队中',
  running: '执行中',
  waiting_model: '等待模型',
  completed: '已完成',
  handed_off: '已交接',
  failed: '失败',
  interrupted: '已中断',
  unknown: '状态未知',
};

/** 缺失与无效计数保持未知，明确上报的零值才显示零。 */
function number(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value.toLocaleString()
    : '未报告';
}

/** 累计耗时只来自服务端计量，不从其他时长相减推断。 */
function duration(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `${(value / 1000).toFixed(1)} 秒`
    : '耗时未知';
}

/** 无效历史时间不渲染 Invalid Date。 */
function time(value: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '未报告';
}

/** 沿用 Drawer 的本地秒表，只递增服务端明确标记仍在计时的生命周期。 */
export function subagentElapsed(
  agent: SubagentDiagnostic,
  observedAt: string,
  now: number,
): number | null {
  const elapsed = agent.elapsedMs;
  if (typeof elapsed !== 'number' || !Number.isFinite(elapsed) || elapsed < 0) return null;
  const at = Date.parse(observedAt);
  const active = ['queued', 'running', 'waiting_model'].includes(agent.status);
  return (
    elapsed +
    (active &&
    !agent.endedAt &&
    agent.runningSince &&
    Number.isFinite(Date.parse(agent.runningSince)) &&
    Number.isFinite(at) &&
    Number.isFinite(now)
      ? Math.max(0, now - at)
      : 0)
  );
}

/** 用量完整度和请求覆盖分开展示，不把已报告部分当作完整消耗。 */
function UsageSummary({ usage }: { usage: AgentUsage }) {
  const metrics = [
    ['请求数', usage.requests],
    ['输入 Token', usage.inputTokens],
    ['输出 Token', usage.outputTokens],
    ['总 Token', usage.totalTokens],
  ] as const;
  return (
    <>
      <dl className="subagent-usage">
        {metrics.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{number(value)}</dd>
          </div>
        ))}
      </dl>
      <p className="subagent-coverage">
        用量完整度：
        {usage.usageComplete === true
          ? '完整'
          : usage.usageComplete === false
            ? '不完整'
            : '未知 / 未报告'}
        <span>
          已报告请求 {number(usage.reportedRequests)} / {number(usage.requests)}
        </span>
      </p>
    </>
  );
}

/** 空清单保留无记录语义，不能据此声称文件交付成功。 */
function Paths({ paths }: { paths: string[] }) {
  return paths.length ? (
    <ul className="subagent-paths">
      {paths.map((path, index) => (
        <li key={index}>
          <code>{path}</code>
        </li>
      ))}
    </ul>
  ) : (
    <span>未报告 / 无记录</span>
  );
}

/** 逐轮展示服务端违规与数量；是否无改善只认服务端 unchanged 字段。 */
function RuleChecks({ checks, truncated }: { checks: AgentRuleCheck[]; truncated: boolean }) {
  return (
    <div className="subagent-checks">
      <h4>区块规则检查</h4>
      {truncated && (
        <p className="subagent-warning">检查记录已截断，数量变化仅对应下列已报告轮次。</p>
      )}
      {!checks.length && <p className="diagnostics-note">未报告规则检查。</p>}
      {checks.length > 0 && (
        <p className="subagent-check-trend">
          违规数量变化：{checks.map((check) => number(check.count)).join(' → ')}
        </p>
      )}
      <ol className="subagent-check-list">
        {checks.map((check, index) => (
          <li key={`${check.seq}-${index}`}>
            <div className="subagent-check-heading">
              <strong title={`事件编号 ${check.seq}`}>第 {index + 1} 次检查</strong>
              <span>
                {check.passed === true ? '通过' : check.passed === false ? '未通过' : '结果未知'}
              </span>
            </div>
            <p>
              违规数量：{index > 0 && <>{number(checks[index - 1].count)} → </>}
              {number(check.count)}
            </p>
            <p>
              {check.unchanged === true
                ? '违规未改善'
                : check.unchanged === false
                  ? '违规有变化'
                  : '改善情况未知 / 未报告'}
            </p>
            <p className="diagnostics-caption">
              {time(check.at)} · {check.path ?? '检查路径未报告'}
            </p>
            {check.violations.length ? (
              <table className="subagent-rules">
                <caption>规则 / nodeId 明细</caption>
                <thead>
                  <tr>
                    <th scope="col">规则</th>
                    <th scope="col">nodeId</th>
                  </tr>
                </thead>
                <tbody>
                  {check.violations.map((violation, violationIndex) => (
                    <tr key={violationIndex}>
                      <td>
                        <code>{violation.rule}</code>
                      </td>
                      <td>
                        <code>{violation.nodeId}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="diagnostics-note">无已报告违规明细。</p>
            )}
            {check.omittedViolations > 0 && (
              <p className="subagent-warning">
                另有 {number(check.omittedViolations)} 条违规明细未列出。
              </p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** 仅展示公开工具元数据，缺起止配对时不以本地秒表推测工具耗时。 */
function ToolRecords({ tools, truncated }: { tools?: AgentToolDiagnostic[]; truncated?: boolean }) {
  return (
    <details className="subagent-tools">
      <summary>工具记录{tools ? ` · ${tools.length} 条` : ''}</summary>
      {truncated && (
        <p className="subagent-warning">工具记录已截断，仅展示最近部分记录（最多 60 条）。</p>
      )}
      {!tools ? (
        <p className="diagnostics-note">旧记录未采集工具明细。</p>
      ) : !tools.length ? (
        <p className="diagnostics-note">当前范围无工具记录。</p>
      ) : (
        <>
          <p className="diagnostics-note">
            工具耗时含排队与等待；缺少起止时间或服务端计时则保持未知。
          </p>
          <ul className="subagent-tool-list">
            {tools.map((tool) => (
              <li key={tool.id}>
                <div className="subagent-check-heading">
                  <strong>{tool.name}</strong>
                  <span>
                    {tool.status === 'running'
                      ? '等待/执行中'
                      : (statuses[tool.status] ?? '状态未知')}
                  </span>
                </div>
                {tool.detail && <p className="diagnostics-caption">{tool.detail}</p>}
                <dl className="diagnostics-facts">
                  <div>
                    <dt>开始时间</dt>
                    <dd>{time(tool.startedAt)}</dd>
                  </div>
                  <div>
                    <dt>结束时间</dt>
                    <dd>{time(tool.endedAt)}</dd>
                  </div>
                  <div>
                    <dt>耗时（含等待）</dt>
                    <dd>
                      {duration(
                        tool.startedAt &&
                          tool.endedAt &&
                          Number.isFinite(Date.parse(tool.startedAt)) &&
                          Number.isFinite(Date.parse(tool.endedAt))
                          ? tool.durationMs
                          : null,
                      )}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}

/** 任务以 agentId 独立展示，保持同角色多任务及 details 展开状态。 */
function AgentCard({
  agent,
  observedAt,
  now,
}: {
  agent: SubagentDiagnostic;
  observedAt: string;
  now: number;
}) {
  const usage = agent.usage;
  const outcomes = [
    ['成功请求', usage.completedRequests],
    ['失败请求', usage.failedRequests],
    ['中断请求', usage.interruptedRequests],
    ['未结束请求', usage.pendingRequests],
    ['重试请求', usage.retryRequests],
    ['摘要请求', usage.summaryRequests],
  ] as const;
  return (
    <article
      className="subagent-card"
      aria-label={`${roles[agent.role] ?? '未知角色'}：${agent.agentId}`}
    >
      <div className="subagent-card-heading">
        <h4>{roles[agent.role] ?? '未知角色'}</h4>
        <span className="diagnostics-status" data-status={agent.status}>
          {statuses[agent.status] ?? '状态未知'}
        </span>
      </div>
      <div className="subagent-scope">
        <span>负责区块</span>
        <Paths paths={agent.writePaths} />
        {agent.nodeId && (
          <p>
            nodeId：<code>{agent.nodeId}</code>
          </p>
        )}
      </div>
      <p className="subagent-task">{agent.task ?? '任务摘要未报告'}</p>
      <p className="subagent-elapsed">
        任务耗时（含排队） <strong>{duration(subagentElapsed(agent, observedAt, now))}</strong>
      </p>
      <UsageSummary usage={usage} />
      <details className="subagent-details">
        <summary>
          <span className="subagent-chevron" aria-hidden="true">
            ›
          </span>
          诊断详情
          <span className="diagnostics-caption">
            <span className="subagent-expand-hint">展开查看</span>
            <span className="subagent-collapse-hint">收起详情</span>
          </span>
        </summary>
        <dl className="diagnostics-facts">
          <div className="diagnostics-fact-wide">
            <dt>agentId</dt>
            <dd>
              <code>{agent.agentId}</code>
            </dd>
          </div>
          <div>
            <dt>模型名</dt>
            <dd>{agent.modelName ?? '未报告'}</dd>
          </div>
          <div>
            <dt>交付结果</dt>
            <dd>
              {agent.delivery.success === true
                ? '成功'
                : agent.delivery.success === false
                  ? '未成功'
                  : '未知 / 未报告'}
            </dd>
          </div>
          <div>
            <dt>入队时间</dt>
            <dd>{time(agent.queuedAt)}</dd>
          </div>
          <div>
            <dt>开始时间</dt>
            <dd>{time(agent.startedAt)}</dd>
          </div>
          <div>
            <dt>结束时间</dt>
            <dd>{time(agent.endedAt)}</dd>
          </div>
          <div>
            <dt>排队耗时</dt>
            <dd>{duration(agent.queueDurationMs)}</dd>
          </div>
          <div>
            <dt>工具累计耗时（含等待）</dt>
            <dd>{duration(agent.toolDurationMs)}</dd>
          </div>
          <div>
            <dt>工具调用 / 失败数</dt>
            <dd>
              {number(agent.toolCalls)} / {number(agent.toolFailures)}
            </dd>
          </div>
          <div>
            <dt>模型累计耗时</dt>
            <dd>
              {duration(usage.modelDurationMs)}
              <small>
                采样覆盖 {number(usage.durationRequests)} / {number(usage.requests)} 请求
              </small>
            </dd>
          </div>
          <div>
            <dt>首块累计等待</dt>
            <dd>
              {duration(usage.firstChunkMs)}
              <small>
                采样覆盖 {number(usage.firstChunkRequests)} / {number(usage.requests)} 请求
              </small>
            </dd>
          </div>
        </dl>
        <p className="diagnostics-note">
          工具耗时含排队与等待；首块等待不等同网关排队。模型累计耗时和首块累计等待仅覆盖已采样请求。
        </p>
        <dl className="subagent-outcomes">
          {outcomes.map(([label, count]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{number(count)}</dd>
            </div>
          ))}
        </dl>
        <ToolRecords tools={agent.tools} truncated={agent.toolsTruncated} />
        <dl className="diagnostics-facts">
          <div className="diagnostics-fact-wide">
            <dt>实际已保存文件</dt>
            <dd>
              <Paths paths={agent.files} />
            </dd>
          </div>
          <div className="diagnostics-fact-wide">
            <dt>缺失文件</dt>
            <dd>
              <Paths paths={agent.missingFiles} />
            </dd>
          </div>
          <div className="diagnostics-fact-wide">
            <dt>交接原因</dt>
            <dd>{agent.delivery.reason ?? '未报告'}</dd>
          </div>
        </dl>
        <RuleChecks checks={agent.checks} truncated={agent.checksTruncated} />
      </details>
    </article>
  );
}

/** 仅消费公开元数据；旧接口明确提示未采集，不增加网络请求。 */
export default function SubagentDiagnostics({
  diagnostics,
  observedAt,
  now,
}: {
  diagnostics?: AgentDiagnostics;
  observedAt: string;
  now: number;
}) {
  return (
    <section className="diagnostics-section subagent-diagnostics" aria-label="Agent 诊断">
      <div className="diagnostics-section-heading">
        <h3>Agent 诊断</h3>
      </div>
      {!diagnostics ? (
        <p className="diagnostics-note">
          旧记录未采集 Agent 诊断，主 Agent 与子 Agent 的用量和任务详情未知。
        </p>
      ) : (
        <>
          {!diagnostics.complete && (
            <p className="subagent-warning" role="status">
              诊断数据已截断：仅覆盖部分事件元数据，可能缺少任务、请求或检查记录。
            </p>
          )}
          {diagnostics.historicalAttribution && (
            <p className="subagent-warning" role="status">
              部分历史请求无法归属到主 Agent 或具体子任务，单独列入未归属历史请求。
            </p>
          )}
          <div className="subagent-attribution">
            <section aria-label="主 Agent 用量">
              <h4>主 Agent</h4>
              <UsageSummary usage={diagnostics.main} />
            </section>
            {(diagnostics.historicalAttribution || (diagnostics.unassigned.requests ?? 0) > 0) && (
              <section aria-label="未归属历史请求用量">
                <h4>未归属历史请求</h4>
                <UsageSummary usage={diagnostics.unassigned} />
              </section>
            )}
          </div>
          <p className="diagnostics-note">
            并行任务的耗时存在重叠，不能相加作为本轮耗时。未报告用量不代表零消耗。
          </p>
          <div className="subagent-cards">
            {diagnostics.agents.map((agent) => (
              <AgentCard key={agent.agentId} agent={agent} observedAt={observedAt} now={now} />
            ))}
          </div>
          {!diagnostics.agents.length && (
            <p className="diagnostics-note">当前范围无子任务诊断记录。</p>
          )}
        </>
      )}
    </section>
  );
}
