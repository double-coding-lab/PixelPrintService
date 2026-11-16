import { useId, type ReactNode } from 'react';
import Icon from './Icon';

/** 只隐藏导航内容，保留表单、列表及其请求生命周期；折叠按钮始终可用。 */
export default function CollapsibleNav({
  className,
  label,
  current,
  collapsed,
  onToggle,
  children,
}: {
  className: string;
  label: string;
  current: string;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const contentsId = useId();
  const action = `${collapsed ? '展开' : '折叠'}${label}`;

  return (
    <div className={`collapsible-nav ${className}`} data-collapsed={collapsed}>
      <div className="nav-toggle-bar">
        <button
          type="button"
          className="nav-toggle"
          aria-label={action}
          aria-expanded={!collapsed}
          aria-controls={contentsId}
          title={`${action} · ${current}`}
          onClick={onToggle}
        >
          <Icon name="arrow" />
          <span>{label}</span>
        </button>
      </div>
      <div id={contentsId} className="nav-contents" hidden={collapsed}>
        {children}
      </div>
    </div>
  );
}
