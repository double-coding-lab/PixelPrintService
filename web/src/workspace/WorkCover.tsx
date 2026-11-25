import { useState } from 'react';
import { safeMarkdownImageUrl } from '../components/MarkdownMessage';
import './workCover.css';

/** 封面只显示服务端提供的安全地址；失败回退占位，点击与键盘均打开对应作品。 */
export default function WorkCover({
  url,
  fallbackUrl,
  name,
  onOpen,
  kind = 'runtime',
  className = '',
}: {
  url?: string | null;
  fallbackUrl?: string | null;
  name: string;
  onOpen: () => void;
  kind?: 'runtime' | 'work';
  className?: string;
}) {
  const [failed, setFailed] = useState<{ key: string; urls: string[] } | null>(null);
  const key = `${url ?? ''}\n${fallbackUrl ?? ''}`;
  const failedUrls = failed?.key === key ? failed.urls : [];
  const src = [safeMarkdownImageUrl(url), safeMarkdownImageUrl(fallbackUrl)].find(
    (value) => value && !failedUrls.includes(value),
  );
  const label = kind === 'work' ? '作品图片' : '运行截图';
  return (
    <button
      type="button"
      className={`work-cover ${className}`.trim()}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(event.key))
          return;
        const image = event.currentTarget.querySelector<HTMLElement>('.work-cover-image');
        if (!image || image.scrollHeight <= image.clientHeight) return;
        event.preventDefault();
        const direction = event.key === 'ArrowUp' || event.key === 'PageUp' ? -1 : 1;
        image.scrollTop =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? image.scrollHeight
              : image.scrollTop +
                direction * (event.key.startsWith('Page') ? image.clientHeight * 0.9 : 48);
      }}
      aria-label={`打开作品：${name}`}
      title="滚动或用方向键查看长图，点击打开作品"
    >
      {src ? (
        <>
          <span className="work-cover-image">
            <img
              src={src}
              alt={`${name}${label}`}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() =>
                setFailed((prior) => ({
                  key,
                  urls: [...(prior?.key === key ? prior.urls : []), src],
                }))
              }
            />
          </span>
          {kind === 'work' && <span className="work-cover-label">作品图片</span>}
        </>
      ) : (
        <span className="work-cover-placeholder community-cover-placeholder">
          <span aria-hidden="true">▧</span>
          <span>暂无{label}</span>
        </span>
      )}
    </button>
  );
}
