/** 页面定位使用路径；接口、预览票据和下载地址继续使用各自接口协议。 */
export type AppRoute = {
  view: 'workbench' | 'works' | 'my-works' | 'plaza';
  workspaceId?: string;
  sessionId?: string;
  versionId?: string;
  resourceId?: string;
};

export function appPath(route: AppRoute): string {
  const id = encodeURIComponent;
  if (route.view === 'plaza') return `/plaza${route.resourceId ? `/${id(route.resourceId)}` : ''}`;
  if (route.view === 'my-works')
    return `/works/saved${route.resourceId ? `/${id(route.resourceId)}` : ''}`;
  if (route.view === 'works')
    return route.versionId ? `/works/versions/${id(route.versionId)}` : '/works';
  return `/workbench${route.workspaceId ? `/${id(route.workspaceId)}${route.sessionId ? `/sessions/${id(route.sessionId)}` : ''}` : ''}`;
}

/** 旧分享和会话链接只在入口解析，首次进入即替换为规范路径。 */
export function readAppRoute(url: URL): AppRoute {
  let parts: string[];
  try {
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return { view: 'workbench' };
  }
  if (parts[0] === 'plaza' && parts.length <= 2)
    return { view: 'plaza', resourceId: parts[1] ?? '' };
  if (parts[0] === 'works') {
    if (parts.length === 1) return { view: 'works' };
    if (parts[1] === 'saved' && parts.length <= 3)
      return { view: 'my-works', resourceId: parts[2] ?? '' };
    if (parts[1] === 'versions' && parts.length === 3)
      return { view: 'works', versionId: parts[2] };
  }
  if (
    parts[0] === 'workbench' &&
    (parts.length <= 2 || (parts.length === 4 && parts[2] === 'sessions'))
  )
    return { view: 'workbench', workspaceId: parts[1] ?? '', sessionId: parts[3] ?? '' };
  // 只有历史入口解析查询参数，避免错误路径误切到另一个会话。
  if (parts.length && !(parts.length === 1 && parts[0] === 'slbhealthcheck.html'))
    return { view: 'workbench' };
  const q = url.searchParams;
  const view = q.get('view');
  if (view === 'plaza') return { view, resourceId: q.get('share') ?? '' };
  if (view === 'my-works') return { view, resourceId: q.get('work') ?? '' };
  if (view === 'works' || q.has('version'))
    return { view: 'works', versionId: q.get('version') ?? '' };
  const workspaceId = q.get('workspace') ?? '';
  return { view: 'workbench', workspaceId, sessionId: workspaceId ? (q.get('session') ?? '') : '' };
}

const key = 'pixelprintNavigationIndex';

/** popstate 发生时地址已改变：受保护时先退回原条目，再确认是否重放目标跳转。 */
export function createAppHistory(
  browser: Window,
  options: {
    onRoute: (route: AppRoute) => void;
    isBlocked: () => boolean;
    canLeave: () => Promise<boolean>;
  },
) {
  let current = readAppRoute(new URL(browser.location.href));
  let index = 0;
  let restoring: number | null = null;
  let replay = false;
  let checking = false;
  let disposed = false;
  const state = () => ({ ...browser.history.state, [key]: index });
  browser.history.replaceState(state(), '', appPath(current));
  function apply(route: AppRoute, nextIndex: number) {
    current = route;
    index = nextIndex;
    options.onRoute(route);
  }
  function pop(event: PopStateEvent) {
    if (disposed) return;
    const nextIndex = event.state?.[key];
    if (!Number.isSafeInteger(nextIndex)) return;
    if (restoring !== null) {
      const delta = restoring;
      restoring = null;
      void options.canLeave().then((allowed) => {
        checking = false;
        if (allowed && !disposed) {
          replay = true;
          browser.history.go(delta);
        }
      });
      return;
    }
    const next = readAppRoute(new URL(browser.location.href));
    if (replay || !options.isBlocked()) {
      replay = false;
      apply(next, nextIndex);
      return;
    }
    const delta = nextIndex - index;
    if (!delta) return;
    checking = true;
    restoring = delta;
    browser.history.go(-delta);
  }
  browser.addEventListener('popstate', pop);
  return {
    async navigate(route: AppRoute, replace = false, force = false) {
      if (disposed || checking || appPath(route) === appPath(current)) return false;
      checking = true;
      try {
        if (!force && !(await options.canLeave())) return false;
        if (disposed) return false;
        if (!replace) index += 1;
        browser.history[replace ? 'replaceState' : 'pushState'](state(), '', appPath(route));
        apply(route, index);
        return true;
      } finally {
        checking = false;
      }
    },
    dispose() {
      disposed = true;
      browser.removeEventListener('popstate', pop);
    },
  };
}
