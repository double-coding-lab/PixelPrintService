import React from 'react';
import { Tooltip } from 'antd';

/** 在文件标题旁简洁展示检查状态，详细原因和报告位置收进悬停提示。 */
export default function ValidationNotice({ state }: { state: Record<string, unknown> }) {
  const status = state.status;
  const label =
    status === 'passed'
      ? '检查通过'
      : status === 'failed'
        ? '未通过'
        : status === 'stale'
          ? '待复查'
          : '未检查';
  const detail =
    status === 'passed'
      ? '代码检查通过'
      : status === 'failed'
        ? '产物未通过代码检查，可继续调整'
        : status === 'stale'
          ? '文件已修改，代码检查需要更新'
          : '代码尚未检查';
  const report = typeof state.reportPath === 'string' ? `\n检查报告：${state.reportPath}` : '';
  return (
    <Tooltip
      placement="bottom"
      mouseEnterDelay={0.15}
      trigger={['hover', 'focus', 'click']}
      title={
        <div style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
          {`${detail}${report}`}
        </div>
      }
    >
      <span
        className="file-validation-status"
        data-status={typeof status === 'string' ? status : 'not_checked'}
        aria-label={`${detail}${report}`}
        tabIndex={0}
      >
        {label}
      </span>
    </Tooltip>
  );
}
