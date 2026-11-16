import type { FastifyInstance } from 'fastify';
import { registerAccessLog } from './accessLog';
import { registerIdentity } from './identity';

/** 注册本地会话身份和结构化访问日志。 */
export function registerHttpHooks(app: FastifyInstance) {
  registerIdentity(app);
  registerAccessLog(app);
}
