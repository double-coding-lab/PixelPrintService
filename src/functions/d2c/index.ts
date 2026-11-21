import { installContentStorage } from './content/install';
import sharingRoutes from './sharing/routes';
import { registerAuthGuard } from '@/hooks/http/auth';
import type { FastifyInstance } from 'fastify';
import uploadRoutes from './upload';
import workspaceRoutes from './workspace';
import credentialRoutes from './credential';
import sessionRoutes from './session';
import pluginRoutes from './plugin';
import teamRoutes from './team';

/** 注册工作区 D2C 接口；统一前缀 /api/d2c 由 app.ts 提供。 */
export default async function d2cRoutes(
  app: FastifyInstance,
  options: { templateRoot: string; environment: string },
) {
  /** 本模块及下属接口统一要求用户登录。 */
  registerAuthGuard(app);
  installContentStorage(app);
  /** 团队及成员管理沿用当前用户登录，权限在服务端复查。 */
  app.register(teamRoutes);
  /** 上传授权：为图片上传申请 Storage 令牌。 */
  app.register(uploadRoutes);
  /** 工作区管理：创建、查询、配置编辑、模板升级与软删除。 */
  app.register(workspaceRoutes, {
    templateRoot: options.templateRoot,
    environment: options.environment,
  });
  /** 凭据管理：加密保存本人 Figma Token，查询配置状态。 */
  app.register(credentialRoutes);
  /** 会话入口：消息入队、后台执行、文件管理及时间线 SSE。 */
  app.register(sessionRoutes);
  app.register(pluginRoutes);
  app.register(sharingRoutes);
}
