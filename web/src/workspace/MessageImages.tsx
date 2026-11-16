import React from 'react';
import { Image } from 'antd';
import type { MessageAttachment } from './attachments';

/** 附件地址只接受可展示的 HTTP(S) 或同源路径，不解释任意协议。 */
export function safeImageUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (/^https?:\/\/[^\s]+$/i.test(value) || /^\/(?!\/)[^\s\\]+$/.test(value))
  );
}

/** 持久消息使用服务端投影附件，图片无正文也可独立展示。 */
export default function MessageImages({
  attachments,
  onLoad,
}: {
  attachments?: MessageAttachment[];
  onLoad?: () => void;
}) {
  if (!Array.isArray(attachments)) return null;
  const images = attachments.filter((item) => item && safeImageUrl(item.url));
  if (!images.length) return null;
  return (
    <Image.PreviewGroup>
      <div className="message-images">
        {images.map((item) => (
          <Image
            key={item.attachmentId}
            src={item.url}
            alt="聊天图片"
            loading="lazy"
            onLoad={onLoad}
            preview={{ mask: '放大查看' }}
          />
        ))}
      </div>
    </Image.PreviewGroup>
  );
}
