import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

const HeaderPanelsContext = createContext<{
  active: string | null;
  change: (id: string, open: boolean) => void;
  close: () => void;
} | null>(null);

/** 顶栏浮层互斥；旧浮层晚到的关闭事件不能关闭新打开的浮层。 */
export function HeaderPanelsProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<string | null>(null);
  const change = useCallback((id: string, open: boolean) => {
    setActive((current) => (open ? id : current === id ? null : current));
  }, []);
  const close = useCallback(() => setActive(null), []);
  useEffect(() => {
    if (!active) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      close();
      document.querySelector<HTMLElement>(`[data-header-panel-trigger="${active}"]`)?.focus();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [active, close]);
  const value = useMemo(() => ({ active, change, close }), [active, change, close]);
  return <HeaderPanelsContext.Provider value={value}>{children}</HeaderPanelsContext.Provider>;
}

/** 独立嵌入组件保持本地开关，完整工作台共享同一个顶栏开关。 */
export function useHeaderPanel(id: string) {
  const group = useContext(HeaderPanelsContext);
  const [local, setLocal] = useState(false);
  const change = group?.change;
  const setOpen = useCallback(
    (open: boolean) => {
      if (change) change(id, open);
      else setLocal(open);
    },
    [change, id],
  );
  return { open: group ? group.active === id : local, setOpen };
}

const noop = () => {};
export function useCloseHeaderPanels() {
  return useContext(HeaderPanelsContext)?.close ?? noop;
}
