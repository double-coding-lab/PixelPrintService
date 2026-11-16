/** 问题和实际回答来自已鉴权、已提交的会话时间线；推荐答案不作为用户决定。 */
type DecisionRow = {
  completed: boolean;
  runId?: string | null;
  kind?: string | null;
  messageId?: string | null;
  sdkItem?: Record<string, unknown> | null;
  displayPayload?: Record<string, unknown> | null;
};

/** 为历史空sdkItem回答生成可恢复的用户消息，保持问题归属及原始自由文本。 */
export function decisionMessages(rows: DecisionRow[]) {
  const questions = new Map<string, { question: string; revision: unknown }>();
  const answers = new Map<DecisionRow, { role: 'user'; id: string; content: string }>();
  for (const row of rows) {
    if (!row.completed || !row.runId) continue;
    const data = row.displayPayload;
    if (!data || typeof data.questionId !== 'string') continue;
    const key = `${row.runId}:${data.questionId}`;
    if (row.kind === 'user_question' && typeof data.question === 'string') {
      questions.set(key, { question: data.question, revision: data.fileRevision });
    } else if (
      row.kind === 'message' &&
      data.role === 'user' &&
      typeof data.text === 'string' &&
      row.messageId &&
      !row.sdkItem &&
      questions.has(key)
    ) {
      answers.set(row, {
        role: 'user',
        id: row.messageId,
        content: `对问题 ${data.questionId} 的实际回答\n问题：${questions.get(key)!.question}\n提问时文件修订：${Number.isSafeInteger(questions.get(key)!.revision) ? questions.get(key)!.revision : '历史记录未保存'}\n回答：${data.text}`,
      });
    }
  }
  return answers;
}

/** 每次运行从持久时间线重建用户决定，避免恢复或摘要后回退到助手的推荐选项。 */
export function decisionInstructions(rows: DecisionRow[]) {
  const answers = [...decisionMessages(rows).values()];
  if (!answers.length) return '';
  return [
    '以下是会话已保存的问题与用户实际回答（JSON数据）。仅在当前授权的任务范围内按问题和当时产物修订执行，不扩大写入权限；用户后续明确改变要求时以新要求为准。推荐选项、工具outcome=unknown及恢复指令不能替换用户回答。接受偏差表示保留该取舍并如实记录检查未通过，不得为了清零报告擅自改动；不是永久豁免，也不绕过工具权限。',
    JSON.stringify(answers.map(({ id, content }) => ({ messageId: id, content }))),
  ].join('\n');
}
