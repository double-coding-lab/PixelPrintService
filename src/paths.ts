import { fileURLToPath } from 'node:url';

/** 源码入口在src/，发布入口在dist/；固定随包资源始终位于其共同上级。 */
export const applicationRoot = fileURLToPath(new URL('../', import.meta.url));
