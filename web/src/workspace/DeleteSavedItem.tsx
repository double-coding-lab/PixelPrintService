import { useState } from 'react';
import { Button } from 'antd';
import { useConfirm } from '../components/useConfirm';
import { data, errorMessage, id } from './api';

/** 已保存记录的删除入口；身份和修订由服务端核对，确认后只发送一次写请求。 */
export default function DeleteSavedItem({
  kind,
  itemId,
  name,
  revision,
  onDeleted,
  onRefresh,
}: {
  kind: 'version' | 'work';
  itemId: string;
  name: string;
  revision?: number;
  onDeleted: () => void;
  onRefresh?: () => void;
}) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const label = kind === 'version' ? '会话版本' : '作品';
  async function remove() {
    if (
      busy ||
      !(await confirm({
        title: `删除${label}？`,
        content: `确定删除“${name}”？该保存记录及对应预览将被移除，源会话和其他作品保持不变。`,
        okText: '删除',
        danger: true,
      }))
    )
      return;
    setBusy(true);
    setError('');
    try {
      await data(`/${kind === 'version' ? 'versions' : 'my-works'}/${id(itemId)}`, {
        method: 'DELETE',
        ...(kind === 'work' ? { body: JSON.stringify({ expectedRevision: revision }) } : {}),
      });
      onDeleted();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        danger
        type="text"
        loading={busy}
        disabled={busy}
        aria-label={`删除${label}：${name}`}
        onClick={() => void remove()}
      >
        删除
      </Button>
      {error && (
        <span role="alert" className="saved-item-delete-error">
          {error}
          {onRefresh && (
            <Button type="link" onClick={onRefresh}>
              刷新
            </Button>
          )}
        </span>
      )}
    </>
  );
}
