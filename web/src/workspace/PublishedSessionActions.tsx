import { useState } from 'react';
import { App, Button } from 'antd';
import Icon from '../components/Icon';
import { appPath } from './appRoutes';
import { data, errorMessage, id } from './api';
import type { SharedSession, Sharing } from './sharing';

/** 发布者复用原下线接口；来源导航保留修饰键和现有页面离开保护。 */
export default function PublishedSessionActions({
  session,
  onOpenSession,
  onUnpublished,
  compact = false,
}: {
  session: SharedSession;
  onOpenSession?: (workspaceId: string, sessionId: string) => void;
  onUnpublished?: () => void;
  compact?: boolean;
}) {
  const { message } = App.useApp();
  const [pending, setPending] = useState(false);
  const source = session.sourceSession;
  return (
    <>
      {source && (
        <Button
          className={compact ? 'work-action-session' : undefined}
          aria-label="进入会话"
          title="进入来源会话"
          icon={<Icon name="chat" />}
          disabled={pending}
          href={appPath({ view: 'workbench', ...source })}
          onClick={(event) => {
            if (
              onOpenSession &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              !event.altKey &&
              event.button === 0
            ) {
              event.preventDefault();
              onOpenSession(source.workspaceId, source.sessionId);
            }
          }}
        >
          {compact ? null : '进入会话'}
        </Button>
      )}
      {session.canManage && onUnpublished && (
        <Button
          className="work-action-unpublish"
          icon={<Icon name="offline" />}
          title="从广场下线，保留会话和已保存作品"
          aria-busy={pending}
          loading={pending}
          disabled={pending}
          aria-label={`下线作品：${session.name}`}
          onClick={async () => {
            if (pending) return;
            setPending(true);
            try {
              await data<Sharing>(`/sessions/${id(session.sessionId)}/sharing`, {
                method: 'PUT',
                body: JSON.stringify({ public: false }),
              });
              void message.success('作品已下线');
              onUnpublished();
            } catch (reason) {
              void message.error(errorMessage(reason));
            } finally {
              setPending(false);
            }
          }}
        >
          下线
        </Button>
      )}
    </>
  );
}
