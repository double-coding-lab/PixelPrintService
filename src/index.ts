import { createApp } from '@/app';
import { projectConfig } from '@/config/project';

/** 启动服务；关闭时等待正在执行的工具退出，释放数据库和缓存连接。 */
void createApp()
  .then(async (app) => {
    await app.listen({ host: projectConfig.server.host, port: projectConfig.server.port });
    console.log('PixelPrint: ' + projectConfig.server.publicUrl);
    let closing = false;
    /** 接收退出信号后释放应用连接，超时才强制结束。 */
    function shutdown() {
      if (closing) return;
      closing = true;
      const deadline = setTimeout(() => process.exit(1), 15000);
      deadline.unref();
      void app.close().then(
        () => {
          clearTimeout(deadline);
          process.exit(0);
        },
        () => process.exit(1),
      );
    }
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  })
  .catch((error: unknown) => {
    console.error('[startup]', error instanceof Error ? error.message : 'Startup failed');
    process.exitCode = 1;
  });
