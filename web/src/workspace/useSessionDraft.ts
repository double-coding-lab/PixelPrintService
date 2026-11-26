import { useEffect, useMemo, useReducer, useRef } from 'react';
import { createSessionDraft } from './sessionDraft';

/** 每次进入会话重新核对当前身份；查询失败时保留可输入的内存草稿。 */
async function currentActor(signal: AbortSignal): Promise<string | undefined> {
  const response = await fetch('/auth/me', {
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
  });
  if (!response.ok) return;
  const user = (await response.json()) as { userId?: string };
  return typeof user?.userId === 'string' ? user.userId : undefined;
}

/** 输入即保存，无卸载写回或永久事件监听；只接收聊天文本，不接收凭据或图片。 */
export function useSessionDraft(workspaceId: string, sessionId: string) {
  const draft = useMemo(() => createSessionDraft(workspaceId, sessionId), [workspaceId, sessionId]);
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const current = useRef<typeof draft | null>(draft);
  current.current = draft;
  useEffect(() => {
    current.current = draft;
    const controller = new AbortController();
    currentActor(controller.signal).then(
      (actor) => {
        if (controller.signal.aborted || !actor) return;
        draft.bindActor(actor);
        refresh();
      },
      () => {},
    );
    return () => {
      controller.abort();
      if (current.current === draft) current.current = null;
    };
  }, [draft]);
  return {
    text: draft.text,
    setText(value: string) {
      draft.setText(value);
      refresh();
    },
    /** 请求前捕获版本；成功可清旧会话缓存，绝不清除后来输入或新会话。 */
    capture() {
      const revision = draft.snapshot();
      return () => {
        if (draft.clearIfUnchanged(revision) && current.current === draft) refresh();
      };
    },
  };
}
