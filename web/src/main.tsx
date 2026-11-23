import { createAppHistory, readAppRoute, type AppRoute } from './workspace/appRoutes';
import CommunityPanel from './workspace/CommunityPanel';
import './components/fileTypeIcon.css';
import './workspace/editorSearch.css';
import './workspace/editableFileTree.css';
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useConfirm } from './components/useConfirm';
import WorkspaceSwitcher from './workspace/WorkspaceSwitcher';
import WorkspacePanel from './workspace/WorkspacePanel';
import WorkspaceHome from './workspace/WorkspaceHome';
import CredentialSettings from './workspace/CredentialSettings';
import TeamSettings, { TeamProvider } from './workspace/TeamSettings';
import Icon from './components/Icon';
import WorksPanel from './workspace/WorksPanel';
import './workspace/works.css';
import './styles.css';
import './workspace/navigation.css';
import './workspace/diagnostics.css';
import './workspace/versions.css';
import './workspace/designReference.css';
import './workspace/messageQueue.css';
import './workspace/conversationRound.css';
import './workspace/previewPanel.css';
import './workspace/phonePreview.css';
import './workspace/previewInspector.css';
import './workspace/subagents.css';
import './workspace/team.css';
import './workspace/appNavigation.css';

/** 工作台统一组织导航、会话和凭据入口；业务操作继续使用同源接口。 */
function App() {
  const confirm = useConfirm();
  const [initialRoute] = useState(() => readAppRoute(new URL(window.location.href)));
  const [selection, setSelection] = useState({
    workspaceId: initialRoute.workspaceId ?? '',
    sessionId: initialRoute.sessionId ?? '',
  });
  function workSelection(route: AppRoute) {
    return {
      active: route.view !== 'workbench',
      view: route.view === 'workbench' ? 'works' : route.view,
      versionId: route.versionId ?? '',
      resourceId: route.resourceId ?? '',
    };
  }
  const [works, setWorks] = useState(() => workSelection(initialRoute));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [plazaScope, setPlazaScope] = useState<'all' | 'mine'>('all');
  useEffect(() => {
    /** 浏览器刷新或关闭时保护未保存源码，任务生命周期与此提醒无关。 */
    function beforeUnload(event: BeforeUnloadEvent) {
      if (dirty || busy) {
        event.preventDefault();
        event.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, busy]);

  const navigation = useRef<ReturnType<typeof createAppHistory> | null>(null);
  const guard = useRef({ dirty, busy, confirm });
  guard.current = { dirty, busy, confirm };
  useEffect(() => {
    const history = createAppHistory(window, {
      isBlocked: () => guard.current.dirty || guard.current.busy,
      canLeave: async () => {
        const current = guard.current;
        if (current.busy) return false;
        return (
          !current.dirty ||
          current.confirm({
            title: '放弃未保存的修改？',
            content: '离开当前页面后，尚未应用或保存为作品的修改将丢失。',
            okText: '放弃并进入',
            danger: true,
          })
        );
      },
      onRoute: (route) => {
        if (route.view === 'workbench')
          setSelection({ workspaceId: route.workspaceId ?? '', sessionId: route.sessionId ?? '' });
        setWorks(workSelection(route));
        setDirty(false);
      },
    });
    navigation.current = history;
    return () => {
      history.dispose();
      navigation.current = null;
    };
  }, []);

  async function select(workspaceId: string, sessionId = '') {
    await navigation.current?.navigate({ view: 'workbench', workspaceId, sessionId });
  }

  /** 删除确认已包含草稿提醒，直接替换失效定位。 */
  function navigate(workspaceId: string, sessionId = '') {
    void navigation.current?.navigate({ view: 'workbench', workspaceId, sessionId }, true, true);
  }

  async function openWorks(versionId = '', view = 'works', resourceId = '') {
    if (view !== 'works' && view !== 'plaza' && view !== 'my-works') return;
    await navigation.current?.navigate({ view, versionId, resourceId });
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="header-leading">
          <button
            type="button"
            className="brand"
            disabled={busy}
            onClick={() => void select('')}
            aria-label="返回工作区列表"
          >
            <span className="brand-mark">
              <Icon name="code" />
            </span>
            <div>
              <strong>PixelPrint</strong>
            </div>
          </button>
          <nav className="primary-navigation" aria-label="主导航">
            <button
              type="button"
              disabled={busy}
              aria-current={!works.active ? 'page' : undefined}
              onClick={() => void select(selection.workspaceId, selection.sessionId)}
            >
              工作台
            </button>
            <button
              type="button"
              disabled={busy}
              aria-current={works.active && works.view === 'works' ? 'page' : undefined}
              onClick={() => void openWorks()}
            >
              作品库
            </button>
            <button
              type="button"
              disabled={busy}
              aria-current={
                works.active && (works.view === 'plaza' || works.view === 'my-works')
                  ? 'page'
                  : undefined
              }
              onClick={() => void openWorks('', 'plaza')}
            >
              广场
            </button>
          </nav>
          {!works.active && (
            <WorkspaceSwitcher
              selected={selection.workspaceId}
              onSelect={(workspaceId) => select(workspaceId)}
              blocked={busy}
              onBusy={setBusy}
              onDeleted={(workspaceId) => {
                if (selection.workspaceId === workspaceId) navigate('');
              }}
            />
          )}
        </div>
        <div className="header-actions">
          <CredentialSettings />
          <TeamSettings />
        </div>
      </header>
      <div className="app-layout">
        {works.active ? (
          works.view === 'plaza' || works.view === 'my-works' ? (
            <div className="plaza-layout">
              <CommunityPanel
                key={works.view}
                kind={works.view}
                plazaScope={plazaScope}
                onScopeChange={setPlazaScope}
                onKindChange={(kind) => void openWorks('', kind)}
                navigationDisabled={busy}
                resourceId={works.resourceId}
                onDirty={setDirty}
                onBusy={setBusy}
                onSelect={(value) => void openWorks('', works.view, value)}
                onOpenSession={(workspaceId, sessionId) => void select(workspaceId, sessionId)}
                onDeleted={
                  works.view === 'my-works'
                    ? () => void navigation.current?.navigate({ view: 'my-works' }, true, true)
                    : undefined
                }
              />
            </div>
          ) : (
            <div className="library-layout">
              <WorksPanel
                versionId={works.versionId}
                onSelect={(value) => void openWorks(value)}
                onOpenSession={(workspaceId, sessionId) => void select(workspaceId, sessionId)}
              />
            </div>
          )
        ) : selection.workspaceId ? (
          <WorkspacePanel
            key={selection.workspaceId}
            workspaceId={selection.workspaceId}
            sessionId={selection.sessionId}
            onSelect={(sessionId) => select(selection.workspaceId, sessionId)}
            onDirty={setDirty}
            onBusy={setBusy}
            blocked={busy}
            onDeleted={(sessionId) => {
              if (selection.sessionId === sessionId) navigate(selection.workspaceId);
            }}
          />
        ) : (
          <WorkspaceHome
            disabled={busy}
            onSelect={(workspaceId) => void select(workspaceId)}
            onCreate={() => window.dispatchEvent(new Event('pixelprint:create-workspace'))}
          />
        )}
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      button={{ autoInsertSpace: false }}
      theme={{
        components: {
          Tree: {
            directoryNodeSelectedBg: '#edf2fc',
            directoryNodeSelectedColor: '#365b9d',
            nodeSelectedBg: '#edf2fc',
          },
        },
        token: {
          colorPrimary: '#426ec9',
          colorText: '#25272b',
          borderRadius: 6,
          colorBorder: '#dedfe2',
          colorBgLayout: '#f7f7f8',
          controlHeight: 34,
          fontSize: 13,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
      }}
    >
      <AntApp>
        <TeamProvider>
          <App />
        </TeamProvider>
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);
import './workspace/editWorkspace.css';
