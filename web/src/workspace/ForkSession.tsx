import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Alert, Button, Input, Modal } from 'antd';
import { data, errorMessage, id, page } from './api';
import type { Credential, Session, Workspace } from './types';

type ForkSessionProps = {
  shareId: string;
  sourceName: string;
  disabled?: boolean;
  requireModelCredential?: boolean;
  onBusy?: (value: boolean) => void;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
};

/** 每次打开新建请求标识；关闭后卸载表单，失败重试保留同一标识与输入。 */
export default function ForkSession(props: ForkSessionProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button disabled={props.disabled} onClick={() => setOpen(true)}>
        创建分支并继续
      </Button>
      {open && <ForkDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 仅选择本人就绪个人工作区，复制后沿工作台现有导航进入空闲会话。 */
function ForkDialog({
  shareId,
  sourceName,
  disabled,
  requireModelCredential = false,
  onBusy,
  onOpenSession,
  onClose,
}: ForkSessionProps & { onClose: () => void }) {
  const [clientRequestId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState(() => `${sourceName.slice(0, 197)} 分支`);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [credential, setCredential] = useState<Credential | null>(null);
  const [modelCredential, setModelCredential] = useState<Credential | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const pendingRef = useRef(false);
  const mounted = useRef(false);
  const busyCallback = useRef(onBusy);
  busyCallback.current = onBusy;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pendingRef.current) busyCallback.current?.(false);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    /** 工作区分页使用顶层 rows/total；筛选在遍历全部个人工作区之后进行。 */
    async function readWorkspaces() {
      const rows: Workspace[] = [];
      for (let current = 1; ; current++) {
        const result = await page<Workspace>(
          `/workspaces?scope=personal&page=${current}&pageSize=20`,
          controller.signal,
        );
        rows.push(...result.rows);
        if (current * 20 >= result.total) break;
        if (!result.rows.length) throw new Error('工作区列表不完整，请重试');
      }
      return rows.filter(
        (workspace) =>
          workspace.isOwner !== false && !workspace.teamId && workspace.status === 'ready',
      );
    }
    void Promise.all([
      readWorkspaces(),
      data<Credential>('/credentials/figma/status', { signal: controller.signal }),
      requireModelCredential
        ? data<Credential>('/credentials/model/status', { signal: controller.signal })
        : Promise.resolve(null),
    ]).then(
      ([rows, status, modelStatus]) => {
        if (controller.signal.aborted) return;
        setWorkspaces(rows);
        setWorkspaceId((selected) =>
          rows.some((workspace) => workspace.workspaceId === selected)
            ? selected
            : (rows[0]?.workspaceId ?? ''),
        );
        setCredential(status);
        setModelCredential(modelStatus);
        setLoading(false);
      },
      (reason) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(reason));
        setCredential(null);
        setModelCredential(null);
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [reload, requireModelCredential]);

  /** 提交前重取本人的凭据 ID，服务端仍须核对工作区、凭据归属和源公开状态。 */
  async function submit() {
    if (
      pendingRef.current ||
      disabled ||
      loading ||
      !workspaceId ||
      !credential?.configured ||
      (requireModelCredential && !modelCredential?.configured)
    )
      return;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      setError('分支名称须为 1–200 个字符，且不能包含控制字符');
      return;
    }
    pendingRef.current = true;
    setPending(true);
    onBusy?.(true);
    setError('');
    let created: Pick<Session, 'workspaceId' | 'sessionId'>;
    try {
      const status = await data<Credential>('/credentials/figma/status');
      if (!mounted.current) return;
      setCredential(status);
      if (!status.configured || !status.credentialId) {
        throw new Error('请先在页面顶部配置本人的 Figma 凭据，再重新检查');
      }
      if (requireModelCredential) {
        const modelStatus = await data<Credential>('/credentials/model/status');
        if (!mounted.current) return;
        setModelCredential(modelStatus);
        if (!modelStatus.configured || !modelStatus.credentialId) {
          throw new Error('请先在页面顶部的「模型凭据」中保存本人的模型 Token，再重新检查');
        }
      }
      created = await data<typeof created>(`/plaza/sessions/${id(shareId)}/forks`, {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          name: trimmed,
          credentialId: status.credentialId,
          clientRequestId,
        }),
      });
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
      return;
    } finally {
      pendingRef.current = false;
      if (mounted.current) {
        // 父级导航保护在 render 时读取 busy，必须先提交清除状态再导航。
        flushSync(() => {
          setPending(false);
          onBusy?.(false);
        });
      }
    }
    if (!mounted.current) return;
    onClose();
    onOpenSession(created.workspaceId, created.sessionId);
  }

  return (
    <Modal
      title="创建分支并继续"
      open
      onCancel={() => {
        if (!pendingRef.current) onClose();
      }}
      closable={!pending}
      keyboard={!pending}
      mask={{ closable: !pending }}
      cancelButtonProps={{ disabled: pending }}
      okText="创建分支"
      cancelText="取消"
      confirmLoading={pending}
      okButtonProps={{
        disabled:
          disabled ||
          loading ||
          pending ||
          !workspaceId ||
          !credential?.configured ||
          (requireModelCredential && !modelCredential?.configured),
      }}
      onOk={() => void submit()}
    >
      <div className="compact-form">
        {error && <Alert type="error" showIcon title={error} />}
        <label htmlFor="fork-workspace">个人工作区</label>
        <select
          id="fork-workspace"
          disabled={loading || pending || disabled}
          value={workspaceId}
          onChange={(event) => setWorkspaceId(event.target.value)}
        >
          <option value="" disabled>
            {loading ? '正在读取全部个人工作区…' : '请选择工作区'}
          </option>
          {workspaces.map((workspace) => (
            <option key={workspace.workspaceId} value={workspace.workspaceId}>
              {workspace.name}
            </option>
          ))}
        </select>
        {!loading && !error && !workspaces.length && (
          <Alert
            type="info"
            showIcon
            title="暂无就绪的个人工作区，请先前往工作台创建或准备工作区。"
          />
        )}
        <label htmlFor="fork-name">分支名称</label>
        <Input
          id="fork-name"
          maxLength={200}
          value={name}
          disabled={pending || disabled}
          onChange={(event) => setName(event.target.value)}
          onPressEnter={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            event.preventDefault();
            void submit();
          }}
        />
        {!loading && credential && !credential.configured && (
          <Alert
            type="info"
            showIcon
            title="需要本人的 Figma 凭据"
            description="请取消此窗口，在页面顶部的「Figma 凭据」中配置；配置后重新打开窗口，或点击重新检查。"
          />
        )}
        {!loading && requireModelCredential && modelCredential && !modelCredential.configured && (
          <Alert
            type="info"
            showIcon
            title="需要本人的模型 Token"
            description="请取消此窗口，在页面顶部的「模型凭据」中保存自己的模型 Token；保存后重新打开窗口，或点击重新检查。"
          />
        )}
        <Button disabled={pending || loading} onClick={() => setReload((value) => value + 1)}>
          重新检查工作区和凭据
        </Button>
        <p className="muted">
          将复制公开聊天和当前代码，在你的工作区独立继续，使用你自己的 Figma 凭据
          {requireModelCredential ? '和模型 Token' : ''}。源作品保持不变。
        </p>
      </div>
    </Modal>
  );
}
