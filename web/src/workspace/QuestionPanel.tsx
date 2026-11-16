import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input } from 'antd';
import { data, errorMessage, id } from './api';
import { useConfirm } from '../components/useConfirm';
import type { PendingQuestion } from './types';

export type AnswerRequest = {
  runId: string;
  questionId: string;
  clientRequestId: string;
  answer: string;
};

/** 同一个问题的相同答案沿用请求标识；编辑答案后创建新的幂等请求。 */
export function answerRequest(
  previous: AnswerRequest | null,
  runId: string,
  questionId: string,
  answer: string,
): AnswerRequest {
  return previous?.runId === runId &&
    previous.questionId === questionId &&
    previous.answer === answer
    ? previous
    : { runId, questionId, answer, clientRequestId: crypto.randomUUID() };
}

/** 当前问题独立保存草稿和请求；历史问题永远不挂载回答控件。 */
export default function QuestionPanel({
  sessionId,
  runId,
  question,
  onDirty,
  onBusy,
  onRefresh,
}: {
  sessionId: string;
  runId: string;
  question: PendingQuestion;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
  onRefresh: () => Promise<void>;
}) {
  const confirm = useConfirm();
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AnswerRequest | null>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  const path = `/sessions/${id(sessionId)}`;
  useEffect(() => {
    onDirty(!!answer && !accepted);
  }, [answer, accepted, onDirty]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onDirty(false);
      onBusy(false);
    };
  }, [onDirty, onBusy]);

  /** 同步加锁抵御连点；202 后只刷新可信摘要，不自行制造用户消息或排队状态。 */
  async function submit(end: boolean) {
    if (locked.current || (!accepted && !end && !answer.trim())) return;
    locked.current = true;
    setBusy(true);
    setError('');
    onBusy(true);
    try {
      if (accepted) {
        await onRefresh();
        return;
      }
      if (
        end &&
        !(await confirm({
          title: '结束本轮？',
          content: '已有文件和对话历史会保留，本轮业务问题将不再可回答。',
          okText: '结束本轮',
          danger: true,
        }))
      )
        return;
      if (!mounted.current) return;
      if (!end)
        pending.current = answerRequest(pending.current, runId, question.questionId, answer);
      await data(`${path}/${end ? 'end-waiting' : 'answer'}`, {
        method: 'POST',
        body: JSON.stringify(end ? { runId, questionId: question.questionId } : pending.current),
      });
      if (!mounted.current) return;
      setAccepted(true);
      await onRefresh();
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
    } finally {
      locked.current = false;
      if (mounted.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  }

  return (
    <section className="composer" aria-label="回答业务问题">
      <strong>Agent 需要你的回答</strong>
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{question.question}</p>
      {question.recommendedAnswer && (
        <Alert
          type="info"
          title="推荐答案"
          description={
            <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {question.recommendedAnswer}
            </span>
          }
          action={
            <Button
              disabled={busy || accepted}
              onClick={() => setAnswer(question.recommendedAnswer!)}
            >
              采用推荐答案
            </Button>
          }
          style={{ marginBottom: 12 }}
        />
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {question.options.map((option, index) => (
          <Button
            key={index}
            disabled={busy || accepted}
            onClick={() => setAnswer(option)}
            style={{ whiteSpace: 'normal', height: 'auto' }}
          >
            {option}
            {option === question.recommendedAnswer ? '（推荐）' : ''}
          </Button>
        ))}
      </div>
      <Input.TextArea
        aria-label="业务问题的回答"
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        disabled={busy || accepted}
        autoSize={{ minRows: 2, maxRows: 8 }}
        maxLength={65536}
        placeholder="选择选项或自由输入答案，确认后继续"
      />
      {error && <Alert type="error" showIcon title={error} className="feedback-alert" />}
      <div className="composer-toolbar">
        <span className="muted">
          {accepted ? '回答已处理，正在同步执行状态' : '选择选项只填入答案'}
        </span>
        <div className="composer-actions">
          <Button disabled={busy || accepted} onClick={() => void submit(true)}>
            结束本轮
          </Button>
          <Button
            type="primary"
            loading={busy}
            disabled={busy || (accepted ? !error : !answer.trim())}
            onClick={() => void submit(false)}
          >
            {accepted ? '重新同步状态' : '回答并继续'}
          </Button>
        </div>
      </div>
    </section>
  );
}
