import { useEffect, useState, type FormEvent } from 'react';
import { Alert, App, Modal, Popover } from 'antd';
import { data, errorMessage, id } from './api';
import { useConfirm } from '../components/useConfirm';
import {
  openTeamCreation,
  TeamSelect,
  useTeams,
  useWorkspaceList,
  WorkspaceScopeSelect,
  WorkspaceAttribution,
} from './TeamSettings';
import type { Workspace } from './types';
import Icon from '../components/Icon';
import { useHeaderPanel, useCloseHeaderPanels } from '../components/HeaderPanels';

/** 顶部工作区切换器保留分页、创建和删除入口，页面仅常驻会话导航。 */
export default function WorkspaceSwitcher({
  selected,
  onSelect,
  blocked,
  onBusy,
  onDeleted,
}: {
  selected: string;
  onSelect: (workspaceId: string) => void;
  blocked: boolean;
  onBusy: (busy: boolean) => void;
  onDeleted: (workspaceId: string) => void;
}) {
  const { message } = App.useApp();
  const confirm = useConfirm();
  const list = useWorkspaceList();
  const directory = useTeams();
  const [teamId, setTeamId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const { open, setOpen } = useHeaderPanel('workspace');
  const closeHeaderPanels = useCloseHeaderPanels();
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(null);
  const currentWorkspace =
    list.rows.find((workspace) => workspace.workspaceId === selected) ??
    (selectedWorkspace?.workspaceId === selected ? selectedWorkspace : null);
  useEffect(() => {
    if (!selected) {
      setSelectedWorkspace(null);
      return;
    }
    const controller = new AbortController();
    /** 翻页后仍保留当前工作区名称与归属，不将名称写入地址栏。 */
    data<Workspace>(`/workspaces/${id(selected)}`, { signal: controller.signal }).then(
      (workspace) => {
        if (!controller.signal.aborted) setSelectedWorkspace(workspace);
      },
      () => {},
    );
    return () => controller.abort();
  }, [selected, directory.workspaceRevision]);
  const [search, setSearch] = useState('');
  useEffect(() => {
    /** 欢迎页入口只打开本地创建表单，不触发业务写入。 */
    const open = () => {
      closeHeaderPanels();
      setOpen(false);
      setTeamId(
        directory.workspaceScope.startsWith('team:') ? directory.workspaceScope.slice(5) : null,
      );
      setCreating(true);
    };
    window.addEventListener('pixelprint:create-workspace', open);
    return () => window.removeEventListener('pixelprint:create-workspace', open);
  }, [directory.workspaceScope, closeHeaderPanels]);
  useEffect(() => {
    if (
      !directory.loading &&
      !directory.error &&
      teamId &&
      !directory.teams.some((team) => team.teamId === teamId)
    )
      setTeamId(null);
  }, [directory.loading, directory.error, directory.teams, teamId]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  /** 软删除隐藏工作区和下属会话，删除失败不清空当前页面与草稿。 */
  async function remove(workspace: Workspace) {
    if (pending || blocked) return;
    setPending(true);
    onBusy(true);
    setError('');
    try {
      if (
        !(await confirm({
          title: `删除工作区「${workspace.name}」？`,
          content:
            '工作区及下属会话将从列表隐藏，已保存的文件和历史仍保留。当前工作区未保存的草稿会丢失。有未结束任务时不能删除，暂不提供恢复入口。',
          okText: '删除工作区',
          danger: true,
        }))
      )
        return;
      await data(`/workspaces/${id(workspace.workspaceId)}`, { method: 'DELETE' });
      onDeleted(workspace.workspaceId);
      directory.workspaceChanged();
      list.first();
      void message.success('工作区已删除，数据保留');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
      onBusy(false);
    }
  }

  /** 创建成功才进入工作区；失败保留名称，不自动重试可能已产生副作用的请求。 */
  async function create(event: FormEvent) {
    event.preventDefault();
    if (pending || blocked || directory.loading || (teamId && directory.error)) return;
    setPending(true);
    onBusy(true);
    setError('');
    let created: Workspace | undefined;
    try {
      const workspace = await data<Workspace>('/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), teamId }),
      });
      setName('');
      setCreating(false);
      list.first();
      directory.workspaceChanged();
      created = workspace;
      void message.success('工作区已创建');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
      onBusy(false);
    }
    if (created) onSelect(created.workspaceId);
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger="click"
        placement="bottomLeft"
        arrow={false}
        styles={{ container: { padding: 0 } }}
        content={
          <div className="workspace-switcher-panel">
            <button
              type="button"
              className="quiet workspace-list-link"
              aria-label="返回工作区列表"
              onClick={() => {
                setOpen(false);
                onSelect('');
              }}
            >
              全部工作区 <Icon name="arrow" />
            </button>
            <div className="section-heading">
              <h2>
                工作区 <span className="count">{list.total}</span>
              </h2>
              <button
                className="icon-button"
                aria-label="刷新工作区列表"
                title="刷新工作区列表"
                onClick={list.reload}
                disabled={list.loading}
              >
                <Icon name="refresh" />
              </button>
            </div>
            <button
              className="create-button"
              disabled={blocked || pending}
              onClick={() => {
                setOpen(false);
                setTeamId(
                  directory.workspaceScope.startsWith('team:')
                    ? directory.workspaceScope.slice(5)
                    : null,
                );
                setCreating(true);
              }}
            >
              <Icon name="plus" /> 新建工作区
            </button>

            <WorkspaceScopeSelect />

            <label className="nav-search">
              <Icon name="search" />
              <input
                type="search"
                aria-label="筛选当前页工作区"
                placeholder="查找工作区"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            {(error || list.error || directory.error) && (
              <Alert
                type="error"
                showIcon
                title={error || list.error || directory.error}
                className="feedback-alert"
              />
            )}
            {list.loading && (
              <p className="muted" role="status">
                正在加载工作区…
              </p>
            )}
            {!list.loading && !list.error && list.rows.length === 0 && (
              <p className="empty">暂无工作区</p>
            )}
            <nav className="item-list" aria-label="工作区列表">
              {list.rows
                .filter((workspace) => workspace.name.toLowerCase().includes(search.toLowerCase()))
                .map((workspace) => (
                  <div className="list-row" key={workspace.workspaceId}>
                    <button
                      className={
                        selected === workspace.workspaceId ? 'list-item selected' : 'list-item'
                      }
                      aria-current={selected === workspace.workspaceId ? 'page' : undefined}
                      disabled={blocked || pending}
                      onClick={() => {
                        setOpen(false);
                        onSelect(workspace.workspaceId);
                      }}
                    >
                      <strong>
                        <Icon name="folder" />
                        <span className="nav-item-name" title={workspace.name}>
                          {workspace.name}
                          <WorkspaceAttribution workspace={workspace} />
                        </span>
                      </strong>
                    </button>
                    <button
                      className="row-delete icon-button"
                      title="删除工作区"
                      disabled={blocked || pending}
                      aria-label={`删除工作区：${workspace.name}`}
                      onClick={() => void remove(workspace)}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                ))}
            </nav>
            <div className="pager">
              <button
                className="quiet"
                disabled={list.loading || list.number === 1}
                onClick={() => list.setNumber(list.number - 1)}
              >
                上一页
              </button>
              <span>
                {list.number} / {Math.max(1, Math.ceil(list.total / 20))}
              </span>
              <button
                className="quiet"
                disabled={list.loading || list.number * 20 >= list.total}
                onClick={() => list.setNumber(list.number + 1)}
              >
                下一页
              </button>
            </div>
            {search && <p className="muted search-hint">仅筛选当前页工作区</p>}
          </div>
        }
      >
        <button
          type="button"
          className="workspace-switcher-trigger"
          data-header-panel-trigger="workspace"
          aria-label="切换工作区"
          aria-expanded={open}
        >
          <Icon name="folder" />
          <span>
            {currentWorkspace?.name ?? (selected ? '当前工作区' : '选择工作区')}
            {currentWorkspace && <WorkspaceAttribution workspace={currentWorkspace} />}
          </span>
          <Icon name="chevron" />
        </button>
      </Popover>
      <Modal
        title="新建工作区"
        open={creating}
        onCancel={() => !pending && setCreating(false)}
        footer={null}
        width={440}
        destroyOnHidden={false}
      >
        <form className="compact-form" onSubmit={create}>
          <label htmlFor="workspace-name">工作区名称</label>
          <input
            id="workspace-name"
            required
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：营销活动页"
            disabled={pending}
          />
          <label>工作区归属</label>
          <div className="workspace-team-choice">
            <TeamSelect
              value={teamId}
              onChange={setTeamId}
              disabled={pending || !!directory.error}
            />
            <button
              type="button"
              className="quiet"
              disabled={pending}
              onClick={() => {
                setCreating(false);
                openTeamCreation((team) => {
                  if (team) setTeamId(team.teamId);
                  setCreating(true);
                });
              }}
            >
              新建团队
            </button>
          </div>
          <button
            disabled={
              pending ||
              blocked ||
              directory.loading ||
              !!(teamId && directory.error) ||
              !name.trim()
            }
          >
            {pending ? '创建中…' : '创建'}
          </button>
          {directory.error && (
            <button type="button" className="quiet" onClick={directory.reload}>
              刷新团队
            </button>
          )}
        </form>
        {(error || directory.error) && (
          <Alert type="error" showIcon title={error || directory.error} />
        )}
      </Modal>
    </>
  );
}
