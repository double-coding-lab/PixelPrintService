import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Tooltip } from 'antd';
import Icon from '../components/Icon';
import type { Session } from './types';

const runLabels: Record<string, string> = {
  queued: '等待执行',
  running: '执行中',
  stopping: '正在停止',
  paused: '已暂停',
  interrupted: '执行中断',
  waiting_user: '等待回复',
};

/** 按实际溢出距离滚动标题，悬停概述只读取现有会话列表信息。 */
export default function SessionMenuItem({
  session,
  selected,
  disabled,
  onSelect,
}: {
  session: Session;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const viewport = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);

  useEffect(() => {
    const container = viewport.current;
    const content = text.current;
    if (!container || !content) return;
    /** 导航展开、窗口缩放或标题变化后，重新测量可见范围。 */
    function measure() {
      setDistance(Math.max(0, content!.scrollWidth - container!.clientWidth));
    }
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(content);
    measure();
    return () => observer.disconnect();
  }, [session.name]);

  const style = {
    '--title-scroll-distance': `${-distance}px`,
    '--title-scroll-duration': `${Math.max(4, distance / 35 + 2)}s`,
  } as CSSProperties;
  const status = session.activeRunId
    ? (runLabels[session.activeRunStatus ?? ''] ?? '有未结束任务')
    : '空闲';

  return (
    <Tooltip
      placement="right"
      mouseEnterDelay={0.5}
      title={
        <div className="session-menu-summary">
          <div className="session-menu-summary-name">{session.name}</div>
          <div>目标：{session.target === 'h5' ? 'H5 / React' : 'React Native'}</div>
          <div>状态：{status}</div>
          <div>文件修订：r{session.fileRevision}</div>
          <div>设计稿：{session.figmaUrl ? '已关联 Figma' : '未设置'}</div>
        </div>
      }
    >
      <button
        aria-current={selected ? 'page' : undefined}
        disabled={disabled}
        onClick={onSelect}
        className={selected ? 'list-item selected' : 'list-item'}
      >
        <strong>
          <Icon name="chat" />
          <span
            ref={viewport}
            className="nav-item-name session-title-viewport"
            data-overflow={distance > 0}
            style={style}
          >
            <span ref={text} className="session-title-text">
              {session.name}
            </span>
          </span>
        </strong>
        <span>
          {session.target.toUpperCase()}
          {session.activeRunId ? ` · ${status}` : ''}
        </span>
      </button>
    </Tooltip>
  );
}
