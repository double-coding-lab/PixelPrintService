import { projectConfig } from './project';

/** 本地与对象存储统一使用部署配置中的公开访问来源。 */
export const appConfig = {
  storage: { imagePreviewBaseUrl: projectConfig.storage.publicUrl.replace(/\/$/, '') + '/' },
};

/** 外网可选通用 HTTP 代理，留空时直接连接。 */
export function getProxyUrl(_environment?: string) {
  return projectConfig.network.proxyUrl;
}
