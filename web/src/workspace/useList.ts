import { useEffect, useState } from 'react';
import { errorMessage, page } from './api';

/** 分页请求按页面及刷新序号取消，切换时清空旧结果，避免显示错误归属的数据。 */
export function useList<T>(path: string) {
  const [number, setNumber] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState({ rows: [] as T[], total: 0, loading: true, error: '' });
  useEffect(() => {
    const controller = new AbortController();
    setState({ rows: [], total: 0, loading: true, error: '' });
    page<T>(`${path}?page=${number}&pageSize=20`, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setState({ ...result, loading: false, error: '' });
      },
      (error) => {
        if (!controller.signal.aborted)
          setState({ rows: [], total: 0, loading: false, error: errorMessage(error) });
      },
    );
    return () => controller.abort();
  }, [path, number, refresh]);
  return {
    ...state,
    number,
    setNumber,
    updateRow: (matches: (row: T) => boolean, patch: Partial<T>) =>
      setState((current) => ({
        ...current,
        rows: current.rows.map((row) => (matches(row) ? { ...row, ...patch } : row)),
      })),
    reload: () => setRefresh((value) => value + 1),
    first: () => {
      setNumber(1);
      setRefresh((value) => value + 1);
    },
  };
}
