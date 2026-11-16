import { App } from 'antd';
import { useEffect, useRef } from 'react';

/** 统一中文确认框；同一组件只打开一个，卸载按取消处理，避免迟到确认继续操作。 */
export function useConfirm() {
  const { modal } = App.useApp();
  const active = useRef<{ cancel: () => void } | null>(null);
  useEffect(() => () => active.current?.cancel(), []);

  return (options: { title: string; content: string; okText: string; danger?: boolean }) => {
    if (active.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      /** 确认、取消及卸载只结算一次，不保留后续操作回调。 */
      function finish(accepted: boolean) {
        if (active.current !== current) return;
        active.current = null;
        resolve(accepted);
      }
      const dialog = modal.confirm({
        title: options.title,
        content: options.content,
        okText: options.okText,
        cancelText: '取消',
        okButtonProps: { danger: options.danger },
        autoFocusButton: 'cancel',
        centered: true,
        mask: { closable: false },
        onOk: () => finish(true),
        onCancel: () => finish(false),
        afterClose: () => finish(false),
      });
      const current = {
        cancel() {
          finish(false);
          dialog.destroy();
        },
      };
      active.current = current;
    });
  };
}
