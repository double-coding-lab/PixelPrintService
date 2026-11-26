import path from 'node:path';
import { applicationRoot } from '../../../paths';

/** 固定资源相对于服务模块定位，不受启动cwd、HOME或生成输入影响。 */
export const previewRuntimeRoot = applicationRoot;
export const previewTemplateRoot = path.join(applicationRoot, 'preview-template');
export const previewBrowserRoot = path.join(applicationRoot, 'preview-browser');
