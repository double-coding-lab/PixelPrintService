import { decisionMessages } from './decisions';
import type { StoredAgentMessage } from './types';
import { Op, type Sequelize, type Transaction } from 'sequelize';
import type { D2cRun } from '@/models/D2cRun';
import type { D2cSession } from '@/models/D2cSession';
import type { D2cTimeline } from '@/models/D2cTimeline';
import { appendSessionEvent } from '../session/service';
import { RunExecutionError } from './errors';

type HistoryRow = {
  completed: boolean;
  sdkItem: Record<string, unknown> | null;
  runId?: string | null;
  kind?: string | null;
  toolCallId?: string | null;
  messageId?: string | null;
  displayPayload?: Record<string, unknown> | null;
};
const toolNames = new Set([
  'prepare_slices',
  'list_files',
  'read_file',
  'write_file',
  'edit_file',
  'delete_file',
  'figma',
  'check_rules',
  'build_preview',
  'inspect_preview',
  'delegate_agent',
  'wait_subagents',
  'ask_user',
]);
const unknownResult = JSON.stringify({
  success: false,
  outcome: 'unknown',
  message:
    '工具执行未正常完成，结果未知。可能已产生部分产物，请先检查已保存文件，再决定是否重试；本记录不表示工具成功，也没有重新执行工具。',
});

/** 真正损坏的历史保持阻断，禁止用恢复逻辑吞掉重复、孤立或跨轮次结果。 */
function invalid(): never {
  throw new RunExecutionError('HISTORY_INVALID', { stage: 'prepare' });
}

/** 只有平台固定格式的补记结果允许跨过后来到达的用户消息重新配对。 */
function isRecovery(row: HistoryRow, call: HistoryRow) {
  const item = row.sdkItem!;
  const output = item.output as { type?: unknown; text?: unknown } | undefined;
  return (
    row.kind === 'tool_result' &&
    !!row.runId &&
    row.runId === call.runId &&
    row.displayPayload?.recovered === true &&
    ['failed', 'interrupted'].includes(String(row.displayPayload.status)) &&
    row.displayPayload.callId === item.callId &&
    row.toolCallId === item.callId &&
    item.name === call.sdkItem!.name &&
    item.status === 'completed' &&
    output?.type === 'text' &&
    output.text === unknownResult
  );
}

/** 检查配对与归属但暂不拒绝缺失结果，供事务修复先验证全部候选。 */
function inspect(rows: HistoryRow[]) {
  const items = rows.filter((row) => row.completed && row.sdkItem);
  const calls = new Map<string, HistoryRow>();
  const results = new Map<string, HistoryRow>();
  const pending = new Set<string>();
  const crossed = new Set<string>();
  for (const row of items) {
    const item = row.sdkItem!;
    if (item.type === 'function_call' || item.type === 'function_call_result') {
      if (
        typeof item.callId !== 'string' ||
        !item.callId ||
        item.callId.length > 200 ||
        /[\u0000-\u001f\u007f]/u.test(item.callId)
      )
        invalid();
      const id = item.callId;
      if (row.toolCallId != null && row.toolCallId !== id) invalid();
      if (item.type === 'function_call') {
        if (calls.has(id) || (row.kind != null && row.kind !== 'tool_call')) invalid();
        calls.set(id, row);
        pending.add(id);
      } else {
        const call = calls.get(id);
        if (
          !call ||
          results.has(id) ||
          (row.kind != null && row.kind !== 'tool_result') ||
          (row.runId !== call.runId && (row.runId != null || call.runId != null)) ||
          (typeof item.name === 'string' &&
            typeof call.sdkItem!.name === 'string' &&
            item.name !== call.sdkItem!.name)
        )
          invalid();
        if (crossed.has(id) && !isRecovery(row, call)) invalid();
        results.set(id, row);
        pending.delete(id);
      }
    } else if (item.role === 'user' || item.role === 'assistant') {
      for (const id of pending) crossed.add(id);
    } else invalid();
  }
  return { items, calls, results, missing: [...pending].map((id) => calls.get(id)!) };
}

/**
 * 回放保持工具批次完整；审计记录不改序，只将可信补记结果放回原调用组后、后续消息前。
 * 缺失、重复、孤立、跨轮次或非平台格式的跨消息结果仍拒绝回放。
 */
export function replayHistory(rows: HistoryRow[]): StoredAgentMessage[] {
  const { results, missing } = inspect(rows);
  if (missing.length) invalid();
  const decisions = decisionMessages(rows);
  const replayItems = rows.filter((row) => row.completed && (row.sdkItem || decisions.has(row)));
  const ordered: Record<string, unknown>[] = [];
  for (let index = 0; index < replayItems.length; index++) {
    const row = replayItems[index];
    const item: Record<string, unknown> = row.sdkItem ?? decisions.get(row)!;
    if (item.type === 'function_call_result') continue;
    if (item.type !== 'function_call') {
      ordered.push(item);
      continue;
    }
    const group = [item];
    while (replayItems[index + 1]?.sdkItem?.type === 'function_call')
      group.push(replayItems[++index].sdkItem!);
    ordered.push(...group, ...group.map((call) => results.get(call.callId as string)!.sdkItem!));
  }
  return structuredClone(ordered) as StoredAgentMessage[];
}

/**
 * 调用方已按工作区→会话→轮次持锁；仅为已失败/中断轮次补记固定的未知结果。
 * 全部候选验证后才写入，同事务保证幂等和回滚；不修改原调用、文件或执行任何工具。
 * @param scopeRunId 结算时只处理当前轮次；准备下一轮时检查本会话全部历史。
 * @returns 已补齐的回放记录和新增条数，通知由调用方在事务提交后统一发送。
 */
export async function repairToolHistory(
  mysql: Sequelize,
  session: D2cSession,
  transaction: Transaction,
  scopeRunId?: string,
) {
  const entries = await (mysql.models.D2cTimeline as typeof D2cTimeline).findAll({
    where: { sessionId: session.sessionId, ...(scopeRunId ? { runId: scopeRunId } : {}) },
    order: [['seq', 'ASC']],
    transaction,
  });
  const { missing } = inspect(entries);
  if (!missing.length) return { entries, repaired: 0 };
  const runs = await (mysql.models.D2cRun as typeof D2cRun).findAll({
    where: { sessionId: session.sessionId, status: { [Op.in]: ['failed', 'interrupted'] } },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const ended = new Map(runs.map((run) => [run.runId, run.status]));
  for (const row of missing) {
    const item = row.sdkItem!;
    if (
      !row.runId ||
      !ended.has(row.runId) ||
      row.kind !== 'tool_call' ||
      row.toolCallId !== item.callId ||
      typeof item.name !== 'string' ||
      !toolNames.has(item.name)
    )
      invalid();
  }
  const recovered: HistoryRow[] = [...entries];
  for (const row of missing) {
    const item = row.sdkItem!;
    const sdkItem = {
      type: 'function_call_result',
      name: item.name,
      callId: item.callId,
      status: 'completed',
      output: { type: 'text', text: unknownResult },
    };
    const displayPayload = {
      callId: item.callId,
      name: item.name,
      status: ended.get(row.runId!)!,
      recovered: true,
    };
    await appendSessionEvent(mysql, session, transaction, {
      runId: row.runId!,
      kind: 'tool_result',
      toolCallId: item.callId as string,
      sdkItem,
      displayPayload,
    });
    recovered.push({
      completed: true,
      runId: row.runId,
      kind: 'tool_result',
      toolCallId: item.callId as string,
      sdkItem,
      displayPayload,
    });
  }
  replayHistory(recovered);
  return { entries: recovered, repaired: missing.length };
}
