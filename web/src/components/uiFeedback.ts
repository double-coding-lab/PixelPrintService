import type { AppProps } from 'antd';

/** 信息提示不截获鼠标和滚轮；确认、输入等交互继续由真实对话框承载。 */
export const nonBlockingMessages: NonNullable<AppProps['message']> = {
  styles: {
    list: { pointerEvents: 'none' },
    listContent: { pointerEvents: 'none' },
    root: { pointerEvents: 'none' },
  },
};
