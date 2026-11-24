import { useEffect, useState, type FormEvent } from 'react';
import { Alert, App } from 'antd';
import { data, errorMessage } from './api';
import Icon from '../components/Icon';

type Credential = { configured: boolean; credentialId?: string; modelName: string };

/** Token 仅在密码输入框短暂保留，成功后清空；浏览器不持久化和回显凭据。 */
export default function ModelCredentialSettings() {
  const { message } = App.useApp();
  const [status, setStatus] = useState<Credential | null>(null);
  const [token, setToken] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    data<Credential>('/credentials/model/status', { signal: controller.signal }).then(
      (value) => {
        if (!controller.signal.aborted) setStatus(value);
      },
      (reason) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      },
    );
    return () => controller.abort();
  }, []);

  /** 保存新凭据修订，旧会话已关联的凭据不会由页面悄悄替换。 */
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    try {
      setStatus(
        await data<Credential>('/credentials/model', {
          method: 'POST',
          body: JSON.stringify({ token }),
        }),
      );
      setToken('');
      void message.success('模型凭据已加密保存');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  }

  return (
    <details
      className="credential"
      onToggle={(event) => {
        if (!event.currentTarget.open) setToken('');
      }}
    >
      <summary>
        <Icon name="key" /> 模型凭据
        <span className={status?.configured ? 'credential-dot ready' : 'credential-dot'} />
      </summary>
      <form className="compact-form" onSubmit={save}>
        <h3>连接模型</h3>
        <span className="muted">
          {status
            ? status.configured
              ? `已保存 ${status.modelName} Token`
              : '尚未配置凭据'
            : '正在查询凭据'}
        </span>
        <p className="muted">
          仅用于管理员配置的默认模型。凭据加密保存，仅本人可用；新分支绑定当前修订，旧分支继续使用原修订。
        </p>
        {status && <p className="muted">默认模型：{status.modelName}</p>}
        <label htmlFor="model-token">模型 Token</label>
        <div className="inline">
          <input
            id="model-token"
            type="password"
            autoComplete="off"
            maxLength={8192}
            required
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <button disabled={pending || !token.trim()}>{pending ? '保存中…' : '保存凭据'}</button>
        </div>
        {error && <Alert type="error" showIcon title={error} className="feedback-alert" />}
      </form>
    </details>
  );
}
