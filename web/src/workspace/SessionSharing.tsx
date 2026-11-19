import { useEffect, useState } from 'react';
import { Alert, Button } from 'antd';
import { data, errorMessage, id } from './api';
import type { Sharing } from './sharing';

/** 权限以服务端 canManage 为准，协作者没有发布入口。 */
export default function SessionSharing({ sessionId }: { sessionId: string }) {
  const [sharing, setSharing] = useState<Sharing | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setSharing(null);
    setError('');
    data<Sharing>(`/sessions/${id(sessionId)}/sharing`, { signal: controller.signal }).then(
      (value) => {
        if (!controller.signal.aborted) setSharing(value);
      },
      (reason) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      },
    );
    return () => controller.abort();
  }, [sessionId]);
  if (!sharing?.canManage) return error ? <span role="status">{error}</span> : null;
  return (
    <>
      <Button
        size="small"
        loading={pending}
        onClick={async () => {
          if (pending) return;
          setPending(true);
          setError('');
          try {
            setSharing(
              await data<Sharing>(`/sessions/${id(sessionId)}/sharing`, {
                method: 'PUT',
                body: JSON.stringify({ public: !sharing.public }),
              }),
            );
          } catch (reason) {
            setError(errorMessage(reason));
          } finally {
            setPending(false);
          }
        }}
      >
        {sharing.public ? '从广场下架' : '发布到广场'}
      </Button>
      {sharing.public && sharing.shareId && (
        <Button size="small" href={`/plaza/${id(sharing.shareId)}`}>
          查看公开会话
        </Button>
      )}
      {error && <Alert type="error" title={error} />}
    </>
  );
}
