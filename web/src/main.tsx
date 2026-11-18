import CommunityPanel from './workspace/CommunityPanel';
import './components/fileTypeIcon.css';
import './workspace/editorSearch.css';
import './workspace/editableFileTree.css';
import { StrictMode, useEffect, useState } from 'react';
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
import './workspace/previewInspector.css';
import './workspace/subagents.css';
import './workspace/team.css';

/** 地址栏只保存定位 ID，私有源码、凭据与会话内容不会写入浏览器持久存储。 */
function initialSelection() {
  const query = new URLSearchParams(window.location.search);
  const workspaceId = query.get('workspace') ?? '';
  return { workspaceId, sessionId: workspaceId ? (query.get('session') ?? '') : '' };
}

/** 工作台统一组织导航、会话和凭据入口；业务操作继续使用同源接口。 */
function App() {
  const confirm = useConfirm();
  const [selection, setSelection] = useState(initialSelection);
  const [works, setWorks] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    return {
      active:
        ['works', 'plaza', 'my-works'].includes(query.get('view') ?? '') || !!query.get('version'),
      view: query.get('view') ?? 'works',
      resourceId:
        query.get('view') === 'plaza' ? (query.get('share') ?? '') : (query.get('work') ?? ''),
      versionId: query.get('version') ?? '',
    };
  });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
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

  /** 使用 replaceState 记录刷新入口，不创建无法保护草稿的客户端返回栈。 */
  async function select(workspaceId: string, sessionId = '') {
    if (!works.active && selection.workspaceId === workspaceId && selection.sessionId === sessionId)
      return;
    if (busy) return;
    if (
      dirty &&
      !(await confirm({
        title: '放弃未保存的修改？',
        content: '当前文件的修改尚未保存。切换后这些修改将丢失，请确认已保存或复制草稿。',
        okText: '放弃并切换',
        danger: true,
      }))
    )
      return;
    navigate(workspaceId, sessionId);
  }

  /** 删除确认已包含草稿提醒，成功后直接清理失效定位，不重复弹窗。 */
  function navigate(workspaceId: string, sessionId = '') {
    setWorks({ active: false, versionId: '', view: 'works', resourceId: '' });
    setDirty(false);
    setSelection({ workspaceId, sessionId });
    const url = new URL(window.location.href);
    url.searchParams.delete('view');
    url.searchParams.delete('version');
    url.searchParams.delete('share');
    url.searchParams.delete('work');
    if (workspaceId) url.searchParams.set('workspace', workspaceId);
    else url.searchParams.delete('workspace');
    if (sessionId) url.searchParams.set('session', sessionId);
    else url.searchParams.delete('session');
    window.history.replaceState(null, '', url);
  }

  /** 切入作品页前沿用未保存草稿保护，独立链接只保存版本ID。 */
  async function openWorks(versionId = '', view = 'works', resourceId = '') {
    if (busy) return;
    if (
      dirty &&
      !(await confirm({
        title: '放弃未保存的修改？',
        content: '进入作品库后当前未保存的修改将丢失。',
        okText: '放弃并进入',
        danger: true,
      }))
    )
      return;
    setDirty(false);
    setWorks({ active: true, versionId, view, resourceId });
    const url = new URL(window.location.href);
    url.searchParams.delete('workspace');
    url.searchParams.delete('session');
    url.searchParams.set('view', view);
    url.searchParams.delete('share');
    url.searchParams.delete('work');
    if (resourceId) url.searchParams.set(view === 'plaza' ? 'share' : 'work', resourceId);
    if (versionId) url.searchParams.set('version', versionId);
    else url.searchParams.delete('version');
    window.history.replaceState(null, '', url);
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
          <WorkspaceSwitcher
            selected={selection.workspaceId}
            onSelect={(workspaceId) => select(workspaceId)}
            blocked={busy}
            onBusy={setBusy}
            onDeleted={(workspaceId) => {
              if (selection.workspaceId === workspaceId) navigate('');
            }}
          />
        </div>
        <div className="header-actions">
          <button className="quiet" disabled={busy} onClick={() => void openWorks('', 'plaza')}>
            广场
          </button>
          <button
            className="quiet"
            disabled={busy}
            onClick={() =>
              works.active
                ? select(selection.workspaceId, selection.sessionId)
                : openWorks('', 'my-works')
            }
          >
            {works.active ? '返回工作台' : '作品库'}
          </button>
          <CredentialSettings />
          <TeamSettings />
        </div>
      </header>
      <div className="app-layout">
        {works.active ? (
          works.view === 'plaza' || works.view === 'my-works' ? (
            <CommunityPanel
              key={works.view}
              kind={works.view}
              resourceId={works.resourceId}
              onSelect={(value) => void openWorks('', works.view, value)}
              onVersions={() => void openWorks()}
            />
          ) : (
            <WorksPanel
              versionId={works.versionId}
              onSelect={openWorks}
              onPersonal={() => void openWorks('', 'my-works')}
            />
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
