import React from 'react';
import { Alert, Button } from 'antd';
import type { QueuedMessage } from './useMessageQueue';
import Icon from '../components/Icon';

/** 待发送列表独立于聊天历史，消费成功后由服务端通知移出列表。 */
export default function MessageQueue({
  items,
  pending,
  error,
  onRemove,
  onSendNow,
  onRetry,
}: {
  items: QueuedMessage[];
  pending: boolean;
  error: string;
  onRemove: (queueId: string) => void;
  onSendNow: (queueId: string) => void;
  onRetry: () => void;
}) {
  if (!items.length && !error) return null;
  return (
    <section className="message-queue" aria-label="待发送消息" aria-busy={pending}>
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          action={
            <Button size="small" onClick={onRetry}>
              重试
            </Button>
          }
        />
      )}
      {!!items.length && (
        <div className="message-queue-heading">
          <span>待发送</span>
          <span className="message-queue-count">{items.length}</span>
        </div>
      )}
      <ol>
        {items.map((item) => (
          <li
            key={item.queueId}
            className={item.status === 'guidance_pending' ? 'is-guidance' : undefined}
          >
            <div className="queued-message-content">
              <span title={item.content}>{item.content || '图片消息'}</span>
              {(!!item.attachmentIds?.length || item.status === 'guidance_pending') && (
                <div className="queued-message-meta">
                  {!!item.attachmentIds?.length && (
                    <small>
                      <Icon name="file" />
                      {item.attachmentIds.length} 张图片
                    </small>
                  )}
                  {item.status === 'guidance_pending' && (
                    <small role="status" className="queued-message-status">
                      引导待接收
                    </small>
                  )}
                </div>
              )}
            </div>
            <div className="queued-message-actions">
              {item.status === 'queued' && (
                <Button
                  size="small"
                  type="text"
                  className="queued-message-send"
                  disabled={pending}
                  aria-label="立即发送"
                  title="立即发送，作为当前任务引导"
                  icon={<Icon name="arrow" style={{ transform: 'rotate(-90deg)' }} />}
                  onClick={() => onSendNow(item.queueId)}
                />
              )}
              <Button
                size="small"
                type="text"
                disabled={pending}
                aria-label={`删除待发送消息：${item.content || '图片消息'}`}
                title="删除"
                icon={<Icon name="trash" />}
                onClick={() => onRemove(item.queueId)}
              />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
