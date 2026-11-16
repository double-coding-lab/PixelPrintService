import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, App, Button, Input, Modal } from 'antd';
import { data, errorMessage, id } from './api';
import { useList } from './useList';
import { useConfirm } from '../components/useConfirm';
import SessionPanel from './SessionPanel';
import type { Credential, Session, Target, Workspace } from './types';
import Icon from '../components/Icon';
import CollapsibleNav from '../components/CollapsibleNav';
import SessionMenuItem from './SessionMenuItem';
import { TeamSelect, useTeams, WorkspaceAttribution } from './TeamSettings';

/** 工作区切换由父组件 key 隔离，过期请求不能覆盖另一个工作区的界面。 */
export default function WorkspacePanel({
  workspaceId,
  sessionId,
  onSelect,
  onDirty,
  onBusy,
  blocked,
  onDeleted,
}: {
  workspaceId: string;
  sessionId: string;
  onSelect: (sessionId: string) => void;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
  blocked: boolean;
  onDeleted: (sessionId: string) => void;
}) {
  const { message } = App.useApp();
  const confirm = useConfirm();
  const path = `/workspaces/${id(workspaceId)}`;
  const list = useList<Session>(`${path}/sessions`);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState('');
  const nameSaving = useRef(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<Target>('h5');
  const [figmaUrl, setFigmaUrl] = useState('');
  const [useCredential, setUseCredential] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const directory = useTeams();
  const [editingTeam, setEditingTeam] = useState(false);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [teamPending, setTeamPending] = useState(false);
  const [teamError, setTeamError] = useState('');
  useEffect(() => {
    if (
      !directory.loading &&
      !directory.error &&
      teamId &&
      !directory.teams.some((team) => team.teamId === teamId)
    )
      setTeamId(null);
  }, [directory.loading, directory.error, directory.teams, teamId]);

  /** 保存工作区名称后通知共享列表刷新，不重建会话或清空聊天草稿。 */
  async function renameWorkspace(event: FormEvent) {
    event.preventDefault();
    if (nameSaving.current || !workspace) return;
    if (!nameDraft.trim()) {
      setNameError('请输入工作区名称');
      return;
    }
    nameSaving.current = true;
    setSavingName(true);
    setNameError('');
    onBusy(true);
    try {
      const updated = await data<Workspace>(path, {
        method: 'PATCH',
        body: JSON.stringify({ name: nameDraft.trim() }),
      });
      setWorkspace((current) => (current ? { ...current, name: updated.name } : current));
      setEditingName(false);
      directory.workspaceChanged();
    } catch (reason) {
      setNameError(errorMessage(reason));
    } finally {
      nameSaving.current = false;
      setSavingName(false);
      onBusy(false);
    }
  }

  /** 仅原创建者调整归属，更新元数据不会重建会话或清空编辑草稿。 */
  async function changeTeam(event: FormEvent) {
    event.preventDefault();
    if (teamPending || blocked || !workspace?.isOwner) return;
    setTeamPending(true);
    onBusy(true);
    setTeamError('');
    try {
      await data(`${path}/team`, { method: 'PUT', body: JSON.stringify({ teamId }) });
      setWorkspace((value) => (value ? { ...value, teamId } : value));
      setEditingTeam(false);
      setRefresh((value) => value + 1);
      directory.workspaceChanged();
      void message.success('工作区归属已更新');
    } catch (reason) {
      setTeamError(errorMessage(reason));
    } finally {
      setTeamPending(false);
      onBusy(false);
    }
  }

  /** 会话仅隐藏不清理产物；后端事务保证不会删除仍在执行的会话。 */
  async function remove(session: Session) {
    if (pending || blocked) return;
    setPending(true);
    onBusy(true);
    setError('');
    try {
      if (
        !(await confirm({
          title: `删除会话「${session.name}」？`,
          content:
            '会话将从列表隐藏，已保存的文件和对话历史仍保留。当前会话未保存的草稿会丢失。有未结束任务时不能删除，暂不提供恢复入口。',
          okText: '删除会话',
          danger: true,
        }))
      )
        return;
      await data(`/sessions/${id(session.sessionId)}`, { method: 'DELETE' });
      onDeleted(session.sessionId);
      list.first();
      void message.success('会话已删除，数据保留');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
      onBusy(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    data<Workspace>(path, { signal: controller.signal }).then(
      (value) => {
        if (!controller.signal.aborted) {
          setWorkspace(value);
          setError('');
        }
      },
      (reason) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      },
    );
    return () => controller.abort();
  }, [path, refresh]);

  /** 创建只建立独立会话；读取最新凭据状态，避免引用已过期的页面缓存。 */
  async function create(event: FormEvent) {
    event.preventDefault();
    if (pending || blocked) return;
    setPending(true);
    onBusy(true);
    setError('');
    try {
      const credential = useCredential ? await data<Credential>('/credentials/figma/status') : null;
      if (useCredential && !credential?.configured)
        throw new Error('请先在顶部保存 Figma 凭据，或取消关联凭据');
      const session = await data<Session>(`${path}/sessions`, {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          target,
          ...(figmaUrl.trim() ? { figmaUrl: figmaUrl.trim() } : {}),
          ...(credential?.credentialId ? { credentialId: credential.credentialId } : {}),
        }),
      });
      setName('');
      setCreating(false);
      setFigmaUrl('');
      list.first();
      onSelect(session.sessionId);
      void message.success('会话已创建');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
      onBusy(false);
    }
  }

  return (
    <section className="workspace-body">
      <div className="workspace-context">
        <div>
          <Icon name="folder" />
          {editingName ? (
            <form className="session-name-edit" onSubmit={renameWorkspace}>
              <Input
                autoFocus
                aria-label="工作区名称"
                maxLength={200}
                value={nameDraft}
                disabled={savingName}
                onChange={(event) => setNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && !savingName) setEditingName(false);
                }}
              />
              <Button size="small" type="primary" htmlType="submit" loading={savingName}>
                保存
              </Button>
              <Button size="small" disabled={savingName} onClick={() => setEditingName(false)}>
                取消
              </Button>
              {nameError && (
                <span role="alert" className="session-name-error">
                  {nameError}
                </span>
              )}
            </form>
          ) : (
            <button
              type="button"
              className="session-name-button workspace-name-button"
              aria-label="修改工作区名称"
              title="点击修改工作区名称"
              disabled={!workspace}
              onClick={() => {
                setNameDraft(workspace?.name ?? '');
                setNameError('');
                setEditingName(true);
              }}
            >
              <strong>{workspace?.name ?? '工作区'}</strong>
            </button>
          )}
          <span className="context-slash">/</span>
          <span>会话</span>
          {workspace && <WorkspaceAttribution workspace={workspace} />}
          {workspace?.isOwner && (
            <Button
              type="text"
              size="small"
              disabled={blocked || teamPending}
              onClick={() => {
                setTeamId(workspace.teamId ?? null);
                setTeamError('');
                setEditingTeam(true);
                directory.reload();
              }}
            >
              修改归属
            </Button>
          )}
        </div>
        <span className="workspace-revision">
          配置 r{workspace?.configRevision ?? '—'} <span>·</span> Skill{' '}
          {workspace?.resource?.sourceVersion ?? '准备中'}
        </span>
      </div>
      <Modal
        title="修改工作区归属"
        open={editingTeam}
        footer={null}
        width={440}
        onCancel={() => !teamPending && setEditingTeam(false)}
      >
        <form className="compact-form" onSubmit={changeTeam}>
          <label>工作区归属</label>
          <TeamSelect
            value={teamId}
            onChange={setTeamId}
            disabled={teamPending || !!directory.error}
          />
          <button
            disabled={
              teamPending ||
              blocked ||
              directory.loading ||
              !!directory.error ||
              teamId === (workspace?.teamId ?? null)
            }
          >
            {teamPending ? '保存中…' : '保存归属'}
          </button>
        </form>
        {(teamError || directory.error) && (
          <Alert type="error" showIcon title={teamError || directory.error} />
        )}
        {directory.error && <Button onClick={directory.reload}>刷新团队</Button>}
      </Modal>
      {error && <Alert type="error" showIcon title={error} className="feedback-alert" />}
      <div className={navCollapsed ? 'session-layout nav-collapsed' : 'session-layout'}>
        <CollapsibleNav
          className="session-navigation"
          label="会话导航"
          current={
            sessionId
              ? `当前会话：${list.rows.find((session) => session.sessionId === sessionId)?.name ?? sessionId}`
              : '尚未选择会话'
          }
          collapsed={navCollapsed}
          onToggle={() => setNavCollapsed((value) => !value)}
        >
          <aside className="sessions">
            <div className="section-heading">
              <h2>
                会话 <span className="count">{list.total}</span>
              </h2>
              <button
                className="quiet icon-button"
                aria-label="刷新会话列表"
                title="刷新会话列表"
                onClick={() => {
                  setRefresh((value) => value + 1);
                  list.reload();
                }}
              >
                <Icon name="refresh" />
              </button>
            </div>
            <button
              className="create-button session-create"
              disabled={blocked || pending}
              onClick={() => setCreating(true)}
            >
              <Icon name="plus" /> 新建会话
            </button>
            <Modal
              title="新建会话"
              open={creating}
              onCancel={() => !pending && setCreating(false)}
              footer={null}
              width={480}
            >
              <form className="compact-form" onSubmit={create}>
                <label htmlFor="session-name">会话名称（可选）</label>
                <input
                  id="session-name"
                  placeholder="留空后自动使用 Figma 根节点名称"
                  maxLength={200}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <label htmlFor="session-target">目标</label>
                <select
                  id="session-target"
                  value={target}
                  onChange={(event) => setTarget(event.target.value as Target)}
                >
                  <option value="h5">H5 / React</option>
                  <option value="rn">React Native</option>
                </select>
                <label htmlFor="session-figma">Figma 地址（可选）</label>
                <input
                  id="session-figma"
                  type="url"
                  value={figmaUrl}
                  onChange={(event) => setFigmaUrl(event.target.value)}
                  placeholder="https://www.figma.com/design/…"
                />
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={useCredential}
                    onChange={(event) => setUseCredential(event.target.checked)}
                  />
                  关联我的 Figma 凭据
                </label>
                <button disabled={pending || blocked || workspace?.status !== 'ready'}>
                  {pending ? '创建中…' : '创建会话'}
                </button>
              </form>
              {error && <Alert type="error" showIcon title={error} />}
            </Modal>
            <label className="nav-search">
              <Icon name="search" />
              <input
                type="search"
                aria-label="筛选当前页会话"
                placeholder="查找会话"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            {list.error && (
              <Alert type="error" showIcon title={list.error} className="feedback-alert" />
            )}
            {list.loading && (
              <p role="status" className="muted">
                正在加载会话…
              </p>
            )}
            {!list.loading && !list.error && !list.rows.length && (
              <p className="empty">还没有会话。</p>
            )}
            <nav className="item-list" aria-label="会话列表">
              {list.rows
                .filter((session) => session.name.toLowerCase().includes(search.toLowerCase()))
                .map((session) => (
                  <div
                    className="list-row"
                    key={session.sessionId}
                    title={
                      session.creatorName || session.createdUserId
                        ? `创建人：${session.creatorName || session.createdUserId}`
                        : undefined
                    }
                  >
                    <SessionMenuItem
                      session={session}
                      selected={sessionId === session.sessionId}
                      disabled={blocked || pending}
                      onSelect={() => onSelect(session.sessionId)}
                    />
                    <button
                      className="row-delete icon-button"
                      title="删除会话"
                      disabled={blocked || pending}
                      aria-label={`删除会话：${session.name}`}
                      onClick={() => void remove(session)}
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
              <span>{list.number}</span>
              <button
                className="quiet"
                disabled={list.loading || list.number * 20 >= list.total}
                onClick={() => list.setNumber(list.number + 1)}
              >
                下一页
              </button>
            </div>
          </aside>
        </CollapsibleNav>
        {sessionId ? (
          <SessionPanel
            key={sessionId}
            sessionId={sessionId}
            workspaceId={workspaceId}
            onDirty={onDirty}
            onBusy={onBusy}
            onNameChange={(id, name) => list.updateRow((row) => row.sessionId === id, { name })}
          />
        ) : (
          <div className="workspace-empty">
            <button className="welcome-cta" disabled={blocked} onClick={() => setCreating(true)}>
              <Icon name="plus" /> 新建会话
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
