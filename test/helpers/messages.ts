import fs from 'node:fs';
import { createMessageService } from '../../src/functions/d2c/session/messages';
import { createSessionService } from '../../src/functions/d2c/session/service';
import { createTimelineNotifications } from '../../src/functions/d2c/session/notifications';
import { sessionStore } from './sessionStore';

/** 使用仓库模板与虚构平台参数，仅构造离线数据库，不连接模型或对象存储。 */
export async function messageFixture() {
  const store = sessionStore();
  const configs = {
    h5: JSON.parse(
      fs.readFileSync(
        new URL('../../pixelprint/templates/pp-d2c.config.json', import.meta.url),
        'utf8',
      ),
    ),
    rn: JSON.parse(
      fs.readFileSync(
        new URL('../../pixelprint/templates/pp-d2c.rn.config.json', import.meta.url),
        'utf8',
      ),
    ),
  };
  Object.assign(store.tables.D2cWorkspace[0], { configRevision: 1, configJson: configs });
  store.tables.D2cWorkspaceRevision.push({
    workspaceId: 'workspace-a',
    resourceRevisionId: 'resource-a',
    status: 'ready',
    bundleHash: 'a'.repeat(64),
    bundleObject: { provider: 'fake-storage', fileName: 'fixed-resource' },
  });
  const runtime = {
    modelConfigs: [
      {
        MODEL_BASE_URL: 'http://model.example.internal/v1',
        MODEL_NAME: 'internal-model',
        MODEL_API_KEY: 'test-model-key-not-for-production',
        contextBudgetTokens: 16000,
      },
    ],
    d2c: {
      execution: {
        workRoot: '/tmp/pixelprint-message-test',
        concurrency: 2,
        pollIntervalMs: 1000,
        heartbeatMs: 10000,
        leaseMs: 60000,
        runTimeoutMs: 900000,
        maxTurns: 60,
      },
      network: { allowedExternalHosts: ['api.figma.com'] },
      limits: { textFileBytes: 2097152, filesPerSession: 500, uploadBytes: 30000000 },
    },
  };
  const sessions = createSessionService(store.mysql);
  const session = await sessions.create('employee-a', 'workspace-a', {
    name: '页面',
    target: 'h5',
  });
  const notifications = createTimelineNotifications();
  const hints: Array<{ sessionId: string; seq: number }> = [];
  const messages = createMessageService(store.mysql, {
    readConfig: () => runtime,
    notify: (sessionId, seq) => {
      hints.push({ sessionId, seq });
      notifications.publish(sessionId, seq);
    },
  });
  return {
    ...store,
    configs,
    runtime,
    sessions,
    messages,
    notifications,
    hints,
    id: session.sessionId!,
  };
}
