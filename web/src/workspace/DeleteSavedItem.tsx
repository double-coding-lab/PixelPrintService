import { useState } from 'react';
import { Button } from 'antd';
import { useConfirm } from '../components/useConfirm';
import { data, errorMessage, id } from './api';
import Icon from '../components/Icon';

/** 已保存记录的删除入口；身份和修订由服务端核对，确认后只发送一次写请求。 */
export default function DeleteSavedItem({
  kind,
  itemId,
  name,
  revision,
  onDeleted,
  onRefresh,
  disabled = false,
  hasUnsavedChanges = false,
}: {
  kind: 'version' | 'work';
  itemId: string;
  name: string;
  revision?: number;
  onDeleted: () => void;
  onRefresh?: () => void;
  disabled?: boolean;
  hasUnsavedChanges?: boolean;
}) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const label = kind === 'version' ? '会话版本' : '作品';
  async function remove() {
    if (
      busy ||
      disabled ||
      !(await confirm({
        title: `删除${label}？`,
        content: `确定删除“${name}”？该保存记录及对应预览将被移除，源会话和其他作品保持不变。${hasUnsavedChanges ? '当前尚未保存的编辑也会丢弃。' : ''}`,
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
        type="text"
        className="work-action-delete"
        icon={<Icon name="trash" />}
        title={`删除${label}`}
        loading={busy}
        disabled={busy || disabled}
        aria-label={`删除${label}：${name}`}
        onClick={() => void remove()}
      />
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
