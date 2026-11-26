import { useEffect, useState, type FormEvent } from 'react';
import { Alert, App } from 'antd';
import { data, errorMessage } from './api';
import Icon from '../components/Icon';

type Credential = {
  configured: boolean;
  credentialId?: string;
  baseUrl?: string;
  modelName: string;
};

/** Token 仅在密码输入框短暂保留，成功后清空；浏览器不持久化和回显凭据。 */
export default function ModelCredentialSettings() {
  const { message } = App.useApp();
  const [status, setStatus] = useState<Credential | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [modelName, setModelName] = useState('');
  const [token, setToken] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    data<Credential>('/credentials/model/status', { signal: controller.signal }).then(
      (value) => {
        if (controller.signal.aborted) return;
        setStatus(value);
        setBaseUrl(value.baseUrl ?? '');
        setModelName(value.configured ? value.modelName : '');
        setLoading(false);
      },
      (reason) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(reason));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [refresh]);

  /** 保存新凭据修订，旧会话已关联的凭据不会由页面悄悄替换。 */
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending || loading || !token.trim() || !baseUrl.trim() || !modelName.trim()) return;
    setPending(true);
    setError('');
    try {
      const value = await data<Credential>('/credentials/model', {
        method: 'POST',
        body: JSON.stringify({ token, baseUrl: baseUrl.trim(), modelName: modelName.trim() }),
      });
      setStatus(value);
      setBaseUrl(value.baseUrl ?? '');
      setModelName(value.configured ? value.modelName : '');
      setToken('');
      void message.success('个人模型配置已保存，Token 已加密保存');
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
              ? `已配置模型：${status.modelName}`
              : '尚未配置个人模型'
            : loading
              ? '正在查询模型配置'
              : '模型配置查询失败，可重试或填写后保存'}
        </span>
        <button
          type="button"
          disabled={loading || pending}
          onClick={() => {
            setError('');
            setLoading(true);
            setRefresh((value) => value + 1);
          }}
        >
          {loading ? '查询中…' : '刷新模型配置'}
        </button>
        <p className="muted">
          每个人的模型设置独立，凭据加密保存，仅本人可用。新建会话采用当前凭据，既有会话继续绑定旧修订。
        </p>
        <label htmlFor="model-base-url">模型 Base URL</label>
        <input
          id="model-base-url"
          type="text"
          autoComplete="off"
          placeholder="https://api.example.com/v1"
          maxLength={2048}
          required
          disabled={loading || pending}
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        <label htmlFor="model-name">模型名称</label>
        <input
          id="model-name"
          type="text"
          autoComplete="off"
          placeholder="model-name"
          maxLength={200}
          required
          disabled={loading || pending}
          value={modelName}
          onChange={(event) => setModelName(event.target.value)}
        />
        <label htmlFor="model-token">模型 Token</label>
        <div className="inline">
          <input
            id="model-token"
            type="password"
            autoComplete="off"
            maxLength={8192}
            required
            disabled={loading || pending}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <button
            disabled={pending || loading || !token.trim() || !baseUrl.trim() || !modelName.trim()}
          >
            {pending ? '保存中…' : '保存凭据'}
          </button>
        </div>
        {error && <Alert type="error" showIcon title={error} className="feedback-alert" />}
      </form>
    </details>
  );
}
