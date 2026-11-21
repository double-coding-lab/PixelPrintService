import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Sequelize, Model, ModelStatic } from 'sequelize';
import { installContentStorage } from '../src/functions/d2c/content/install';
import {
  checkpointModel,
  checkpointPayloadScope,
  prepareCheckpointPayload,
  resolveCheckpointPayload,
} from '../src/functions/d2c/content/checkpointRuntime';

/** 启动级回归：没有第二阶段配置/密钥/文件服务时，旧checkpoint路径仍只使用BLOB。 */
test('仅启用第一阶段不会启用检查点外置，也不要求第二阶段密钥或存储配置', async () => {
  const scope = checkpointPayloadScope({
    sessionId: '12345678-1234-1234-1234-123456789abc',
    namespaceHash: createHash('sha256').update('').digest('hex'),
    checkpointId: 'legacy-checkpoint',
    kind: 'checkpoint',
    type: 'v8',
  });
  for (const d2c of [
    {},
    {
      contentStorage: {
        schemaReady: true,
        mode: 'external',
        encryption: {
          activeKeyId: 'body',
          keys: { body: randomBytes(32).toString('base64') },
        },
      },
    },
  ]) {
    const mysql = { models: {} } as unknown as Sequelize;
    const raw = { d2c };
    installContentStorage({
      mysql,
      qconfig: { get: () => raw },
      runtimeConfig: { get: () => raw },
    } as unknown as FastifyInstance);
    const model = {} as ModelStatic<Model>;
    assert.equal(checkpointModel(mysql, model), model);
    const payload = Buffer.from([0, 255, 1]);
    const saved = await prepareCheckpointPayload(mysql, scope, payload);
    assert.deepEqual(saved, { payload });
    assert.deepEqual(await resolveCheckpointPayload(mysql, saved, scope), payload);
  }
});
