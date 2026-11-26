import { useEffect, useState } from 'react';
import { App, Button, Dropdown, Tooltip } from 'antd';
import { redirectToLogin } from '../auth';
import { useHeaderPanel } from '../components/HeaderPanels';
import { useConfirm } from '../components/useConfirm';

type Account = {
  userId: string;
  name: string;
  provider: 'local' | 'github' | 'guest';
  expiresAt?: number;
  githubEnabled: boolean;
};

/** 展示经服务端验证的当前身份；退出访客前说明临时数据的可找回边界。 */
export default function AccountMenu() {
  const [account, setAccount] = useState<Account>();
  const { open, setOpen } = useHeaderPanel('account');
  const { message } = App.useApp();
  const confirm = useConfirm();
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/auth/me', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 401) {
          redirectToLogin();
          return;
        }
        if (!response.ok) throw new Error('身份信息暂不可用');
        setAccount(await response.json());
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  if (!account) return null;
  async function logout() {
    if (
      !(await confirm({
        title: account?.provider === 'guest' ? '退出访客体验？' : '退出登录？',
        content:
          account?.provider === 'guest'
            ? '退出后无法找回当前访客的工作区和凭据。未保存的编辑也会丢失。'
            : '请先保存当前编辑，退出后可以重新登录。',
        okText: '退出',
      }))
    )
      return;
    try {
      const response = await fetch('/logout', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error();
      window.location.assign('/login');
    } catch {
      void message.error('退出失败，请稍后重试');
    }
  }
  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      trigger={['click']}
      menu={{
        items: [
          { key: 'identity', label: `账号 ID：${account.userId}`, disabled: true },
          ...(account.provider === 'guest'
            ? [{ key: 'github', label: '使用 GitHub 账号登录', disabled: !account.githubEnabled }]
            : []),
          { type: 'divider' },
          { key: 'logout', label: '退出登录' },
        ],
        onClick: ({ key }) => {
          if (key === 'logout') void logout();
          else if (key === 'github') window.location.assign('/auth/github');
        },
      }}
    >
      <Tooltip title={account.provider === 'guest' ? '本浏览器的临时访客身份' : '当前登录账号'}>
        <Button data-header-panel-trigger="account" aria-expanded={open}>
          {account.provider === 'guest'
            ? '访客 · '
            : account.provider === 'github'
              ? 'GitHub · '
              : ''}
          {account.name} ▾
        </Button>
      </Tooltip>
    </Dropdown>
  );
}
