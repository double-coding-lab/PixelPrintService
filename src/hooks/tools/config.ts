import { projectConfig } from '@/config/project';

/** 读取启动时验证过的项目运行配置，不连接远程配置服务。 */
export class RuntimeConfig {
  async load(): Promise<void> {}
  get<T = unknown>(key?: string): T | undefined {
    return key === undefined || key === 'runtime' ? (projectConfig.runtime as T) : undefined;
  }
  all() {
    return projectConfig.runtime;
  }
  get size() {
    return 1;
  }
}
