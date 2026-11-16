import { createRoot } from 'react-dom/client';
import Page from '@preview-entry';

/** 直接挂载生成页面，不注入工作台样式或外层布局，避免影响设计稿还原。 */
const root = document.getElementById('root');
if (!root) throw new Error('预览页面缺少 #root 挂载节点');
createRoot(root).render(<Page />);
