import { useState } from 'react';
import { Alert, Button, Input, Pagination } from 'antd';
import Icon from '../components/Icon';
import {
  useTeams,
  useWorkspaceList,
  WorkspaceScopeSelect,
  WorkspaceAttribution,
} from './TeamSettings';

/** 首页与顶部切换器共享归属范围，工作区切换仍由父组件保护草稿。 */
export default function WorkspaceHome({
  onSelect,
  onCreate,
  disabled,
}: {
  onSelect: (workspaceId: string) => void;
  onCreate: () => void;
  disabled: boolean;
}) {
  const list = useWorkspaceList();
  const directory = useTeams();
  const [search, setSearch] = useState('');
  const rows = list.rows.filter((row) => row.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <section className="workspace-home" aria-label="工作区">
      <div className="workspace-home-heading">
        <h1>工作区</h1>
        <Button type="primary" icon={<Icon name="plus" />} disabled={disabled} onClick={onCreate}>
          新建工作区
        </Button>
      </div>
      <div className="workspace-home-toolbar">
        <WorkspaceScopeSelect />
        <Input.Search
          placeholder="筛选本页工作区"
          aria-label="筛选本页工作区"
          allowClear
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button
          type="text"
          icon={<Icon name="refresh" />}
          aria-label="刷新工作区"
          loading={list.loading}
          onClick={list.reload}
        />
      </div>
      {(list.error || directory.error) && (
        <Alert type="error" showIcon title={list.error || directory.error} />
      )}
      <div className="workspace-home-list" aria-busy={list.loading}>
        {list.loading ? (
          <p className="empty" role="status">
            正在加载工作区…
          </p>
        ) : !rows.length ? (
          <p className="empty">{search ? '没有匹配的工作区' : '暂无工作区'}</p>
        ) : (
          rows.map((workspace) => (
            <button
              className="workspace-home-row"
              key={workspace.workspaceId}
              disabled={disabled}
              onClick={() => onSelect(workspace.workspaceId)}
            >
              <Icon name="folder" />
              <span className="workspace-home-name">
                {workspace.name}
                <WorkspaceAttribution workspace={workspace} />
              </span>
              {workspace.status !== 'ready' && (
                <span className="workspace-home-status">
                  {workspace.status === 'preparing'
                    ? '准备中'
                    : workspace.status === 'failed'
                      ? '准备失败'
                      : workspace.status}
                </span>
              )}
              <Icon name="chevron" />
            </button>
          ))
        )}
      </div>
      {list.total > 20 && (
        <Pagination
          current={list.number}
          total={list.total}
          pageSize={20}
          showSizeChanger={false}
          onChange={list.setNumber}
        />
      )}
    </section>
  );
}
