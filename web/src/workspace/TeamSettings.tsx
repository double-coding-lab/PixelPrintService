import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Alert, App, Button, Modal, Select } from 'antd';
import { data, errorMessage, id, page } from './api';
import { useConfirm } from '../components/useConfirm';
import Icon from '../components/Icon';
import { useCloseHeaderPanels } from '../components/HeaderPanels';
import type { Team, TeamDetail, Workspace, WorkspaceScope } from './types';

/** 完整读取可访问团队，不能因分页漏项而误判当前团队已失效。 */
export async function loadTeams(signal?: AbortSignal): Promise<Team[]> {
  const teams = new Map<string, Team>();
  let count = 0;
  for (let number = 1; ; number++) {
    const result = await page<Team>(`/teams?page=${number}&pageSize=100`, signal);
    for (const team of result.rows) teams.set(team.teamId, team);
    count += result.rows.length;
    if (count >= result.total) return [...teams.values()];
    if (!result.rows.length) throw new Error('团队列表不完整，请刷新重试');
  }
}

/** 工作区列表的归属只影响查询，不改变当前会话及地址栏定位。 */
export function workspaceListPath(scope: WorkspaceScope, number: number) {
  const query = new URLSearchParams({ page: String(number), pageSize: '20' });
  if (scope === 'personal') query.set('scope', 'personal');
  else if (scope.startsWith('team:')) query.set('teamId', scope.slice(5));
  return `/workspaces?${query}`;
}

/** 已失去访问权的团队回退到全部；正常刷新保留有效选择。 */
export function availableWorkspaceScope(scope: WorkspaceScope, teams: Team[]): WorkspaceScope {
  return scope.startsWith('team:') && !teams.some((team) => team.teamId === scope.slice(5))
    ? 'all'
    : scope;
}

type TeamDirectory = {
  teams: Team[];
  loading: boolean;
  error: string;
  revision: number;
  reload: () => void;
  workspaceScope: WorkspaceScope;
  setWorkspaceScope: (scope: WorkspaceScope) => void;
  workspaceRevision: number;
  workspaceChanged: () => void;
};
const TeamContext = createContext<TeamDirectory | null>(null);

/** 首页、切换器和设置共享团队目录；刷新失败保留选择，成功后才剔除失效团队。 */
export function TeamProvider({ children }: { children: ReactNode }) {
  const [directory, setDirectory] = useState({
    teams: [] as Team[],
    loading: true,
    error: '',
    revision: 0,
  });
  const [refresh, setRefresh] = useState(0);
  const [workspaceScope, setWorkspaceScope] = useState<WorkspaceScope>('all');
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const reload = useCallback(() => {
    setDirectory((value) => ({ ...value, loading: true, error: '' }));
    setRefresh((value) => value + 1);
  }, []);
  const workspaceChanged = useCallback(() => setWorkspaceRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    loadTeams(controller.signal).then(
      (teams) => {
        if (controller.signal.aborted) return;
        setDirectory((value) => ({
          teams,
          loading: false,
          error: '',
          revision: value.revision + 1,
        }));
        setWorkspaceScope((scope) => availableWorkspaceScope(scope, teams));
      },
      (reason) => {
        if (!controller.signal.aborted)
          setDirectory((value) => ({ ...value, loading: false, error: errorMessage(reason) }));
      },
    );
    return () => controller.abort();
  }, [refresh]);
  const value = useMemo(
    () => ({
      ...directory,
      reload,
      workspaceScope,
      setWorkspaceScope,
      workspaceRevision,
      workspaceChanged,
    }),
    [directory, reload, workspaceScope, workspaceRevision, workspaceChanged],
  );
  return <TeamContext.Provider value={value}>{children}</TeamContext.Provider>;
}

/** 团队状态只在本次页面中共享，不新增浏览器持久配置。 */
export function useTeams() {
  const value = useContext(TeamContext);
  if (!value) throw new Error('团队组件需要 TeamProvider');
  return value;
}

/** 归属过滤的真实分页请求，切换范围从首页加载并取消旧响应。 */
export function useWorkspaceList() {
  const { workspaceScope: scope, workspaceRevision, revision, reload: reloadTeams } = useTeams();
  const [pagination, setPagination] = useState({ scope, number: 1 });
  const number = pagination.scope === scope ? pagination.number : 1;
  const [refresh, setRefresh] = useState(0);
  const path = workspaceListPath(scope, number);
  const [state, setState] = useState({
    path: '',
    rows: [] as Workspace[],
    total: 0,
    loading: true,
    error: '',
  });
  useEffect(() => {
    const controller = new AbortController();
    setPagination((value) => (value.scope === scope ? value : { scope, number: 1 }));
    setState({ path, rows: [], total: 0, loading: true, error: '' });
    page<Workspace>(path, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        const last = Math.max(1, Math.ceil(result.total / 20));
        if (number > last) setPagination({ scope, number: last });
        else setState({ path, ...result, loading: false, error: '' });
      },
      (reason) => {
        if (!controller.signal.aborted)
          setState({ path, rows: [], total: 0, loading: false, error: errorMessage(reason) });
      },
    );
    return () => controller.abort();
  }, [path, scope, number, refresh, workspaceRevision, revision]);
  return {
    ...(state.path === path
      ? state
      : { rows: [] as Workspace[], total: 0, loading: true, error: '' }),
    number,
    setNumber: (value: number) => setPagination({ scope, number: value }),
    reload: () => {
      setRefresh((value) => value + 1);
      reloadTeams();
    },
    first: () => {
      setPagination({ scope, number: 1 });
      setRefresh((value) => value + 1);
    },
  };
}

/** 两处工作区入口使用同一个范围选择，筛选不会卸载正在编辑的会话。 */
export function WorkspaceScopeSelect() {
  const { teams, workspaceScope, setWorkspaceScope, loading } = useTeams();
  return (
    <Select
      className="workspace-scope-select"
      aria-label="工作区范围"
      value={workspaceScope}
      onChange={setWorkspaceScope}
      options={[
        { value: 'all', label: '全部工作区' },
        { value: 'personal', label: '个人工作区' },
        ...teams.map((team) => ({
          value: `team:${team.teamId}`,
          label: team.name,
          disabled: loading,
        })),
      ]}
    />
  );
}

/** 归属选择只提供可访问的团队，个人工作区使用 null 提交。 */
export function TeamSelect({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const { teams, loading } = useTeams();
  const available = value && teams.some((team) => team.teamId === value) ? value : '';
  return (
    <Select
      aria-label="工作区归属"
      value={available}
      onChange={(teamId) => onChange(teamId || null)}
      disabled={disabled || loading}
      options={[
        { value: '', label: '个人' },
        ...teams.map((team) => ({ value: team.teamId, label: team.name })),
      ]}
    />
  );
}

/** 名称后统一括号标注归属，仅使用当前可访问团队目录，未知团队保留兜底。 */
export function WorkspaceAttribution({ workspace }: { workspace: Workspace }) {
  const { teams } = useTeams();
  const team = workspace.teamId
    ? teams.find((team) => team.teamId === workspace.teamId)?.name || '团队'
    : '个人';
  return <span className="workspace-attribution">（{team}）</span>;
}

/** 团队成员只向创建者提供管理入口；服务端仍负责最终鉴权。 */
export function TeamMembers({
  team,
  pending,
  onRemove,
}: {
  team: TeamDetail;
  pending: boolean;
  onRemove: (userId: string) => void;
}) {
  return (
    <ul className="team-members" aria-label="团队成员">
      {team.members.map((member) => (
        <li key={member.userId}>
          <span>{member.userId}</span>
          {member.role === 'owner' ? (
            <span className="muted">创建者</span>
          ) : team.isOwner ? (
            <Button
              type="text"
              danger
              disabled={pending}
              aria-label={`移除成员 ${member.userId}`}
              onClick={() => onRemove(member.userId)}
            >
              移除
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

type TeamCreationReturn = (team: Team | null) => void;
/** 工作区表单可暂存本地输入，借用团队创建后再带回新归属。 */
export function openTeamCreation(onCreated?: TeamCreationReturn) {
  window.dispatchEvent(new CustomEvent('pixelprint:create-team', { detail: { onCreated } }));
}

/** 团队管理保留当前工作台，通过账号添加成员，不展示或修改其他人的凭据。 */
export default function TeamSettings() {
  const closeHeaderPanels = useCloseHeaderPanels();
  const creationReturn = useRef<TeamCreationReturn | null>(null);
  const directory = useTeams();
  const { message } = App.useApp();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [reading, setReading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [userId, setUserId] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const active = useRef(false);
  useEffect(() => {
    const openCreation = (event: Event) => {
      if (active.current) return;
      closeHeaderPanels();
      creationReturn.current =
        (event as CustomEvent<{ onCreated?: TeamCreationReturn }>).detail?.onCreated ?? null;
      setError('');
      setCreating(true);
      setOpen(true);
      directory.reload();
    };
    window.addEventListener('pixelprint:create-team', openCreation);
    return () => window.removeEventListener('pixelprint:create-team', openCreation);
  }, [closeHeaderPanels, directory.reload]);
  function close() {
    if (pending) return;
    setOpen(false);
    const done = creationReturn.current;
    creationReturn.current = null;
    done?.(null);
  }
  const team = !directory.loading && detail?.teamId === selected ? detail : null;
  useEffect(() => {
    if (directory.loading || directory.error) return;
    setSelected((value) =>
      directory.teams.some((team) => team.teamId === value)
        ? value
        : (directory.teams[0]?.teamId ?? ''),
    );
  }, [directory.teams, directory.loading, directory.error]);
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setError('');
    setUserId('');
    setReading(open && !!selected && !directory.error);
    if (open && selected && !directory.loading && !directory.error)
      data<TeamDetail>(`/teams/${id(selected)}`, { signal: controller.signal }).then(
        (value) => {
          if (!controller.signal.aborted) {
            setDetail(value);
            setReading(false);
          }
        },
        (reason) => {
          if (!controller.signal.aborted) {
            setError(errorMessage(reason));
            setReading(false);
          }
        },
      );
    return () => controller.abort();
  }, [open, selected, directory.loading, directory.error, directory.revision, refresh]);

  /** 成员变动后刷新目录及详情，服务端拒绝时保留输入供修正。 */
  async function mutate(path: string, method: string, body?: object) {
    if (active.current) return;
    active.current = true;
    setPending(true);
    setError('');
    try {
      await data(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      setUserId('');
      directory.reload();
      setRefresh((value) => value + 1);
      void message.success('团队成员已更新');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      active.current = false;
      setPending(false);
    }
  }

  /** 新团队成功返回后再选中，刷新期间不让旧目录清除新选择。 */
  async function create(event: FormEvent) {
    event.preventDefault();
    if (active.current || !name.trim()) return;
    active.current = true;
    setPending(true);
    setError('');
    try {
      const created = await data<Team>('/teams', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      directory.reload();
      setSelected(created.teamId);
      setName('');
      setCreating(false);
      void message.success('团队已创建');
      const done = creationReturn.current;
      creationReturn.current = null;
      if (done) {
        setOpen(false);
        done(created);
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      active.current = false;
      setPending(false);
    }
  }

  /** 确认后移除单个成员，创建者本人的行不提供移除入口。 */
  async function remove(userId: string) {
    if (pending || !team?.isOwner) return;
    setPending(true);
    const accepted = await confirm({
      title: `移除成员 ${userId}？`,
      content: '移除后，该成员将无法继续访问此团队的工作区。',
      okText: '移除',
      danger: true,
    });
    setPending(false);
    if (accepted) await mutate(`/teams/${id(team.teamId)}/members/${id(userId)}`, 'DELETE');
  }

  return (
    <>
      <Button
        type="text"
        onClick={() => {
          closeHeaderPanels();
          setOpen(true);
          directory.reload();
        }}
      >
        团队管理
      </Button>
      <Modal title="团队管理" open={open} onCancel={close} footer={null} width={520}>
        <div className="team-toolbar">
          <Select
            aria-label="选择团队"
            placeholder="选择团队"
            value={directory.teams.some((team) => team.teamId === selected) ? selected : undefined}
            options={directory.teams.map((team) => ({ value: team.teamId, label: team.name }))}
            onChange={setSelected}
            disabled={pending || directory.loading}
          />
          <Button
            aria-label="刷新团队"
            loading={directory.loading || reading}
            disabled={pending}
            onClick={() => {
              directory.reload();
              setRefresh((value) => value + 1);
            }}
            icon={<Icon name="refresh" />}
          />
          <Button disabled={pending} onClick={() => setCreating((value) => !value)}>
            新建团队
          </Button>
        </div>
        {creating && (
          <form className="compact-form team-create" onSubmit={create}>
            <label htmlFor="team-name">团队名称</label>
            <div className="inline">
              <input
                id="team-name"
                required
                maxLength={200}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={pending}
              />
              <button disabled={pending || !name.trim()}>创建团队</button>
            </div>
          </form>
        )}
        {(error || directory.error) && (
          <Alert type="error" showIcon title={error || directory.error} />
        )}
        {reading ? (
          <p role="status">正在加载团队…</p>
        ) : team ? (
          <>
            <div className="team-heading">
              <strong>{team.name}</strong>
              <span className="muted">{team.memberCount} 人</span>
            </div>
            <TeamMembers team={team} pending={pending} onRemove={(userId) => void remove(userId)} />
            {team.isOwner && (
              <form
                className="compact-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (userId.trim())
                    void mutate(`/teams/${id(team.teamId)}/members`, 'POST', {
                      userId: userId.trim(),
                    });
                }}
              >
                <label htmlFor="team-member-userId">成用户号</label>
                <div className="inline">
                  <input
                    id="team-member-userId"
                    required
                    value={userId}
                    onChange={(event) => setUserId(event.target.value)}
                    disabled={pending}
                  />
                  <button disabled={pending || !userId.trim()}>添加成员</button>
                </div>
              </form>
            )}
          </>
        ) : !directory.loading && !directory.error && !error && !directory.teams.length ? (
          <p className="empty">暂无团队</p>
        ) : null}
      </Modal>
    </>
  );
}
