import assert from 'node:assert/strict';
import test from 'node:test';
import { parseD2cRuntimeConfig } from '../src/config/d2c';
const raw = {
  modelConfigs: [
    {
      MODEL_BASE_URL: 'https://example.com/v1',
      MODEL_NAME: 'model',
      MODEL_API_KEY: 'test',
      contextBudgetTokens: 16000,
    },
  ],
  d2c: {
    execution: {
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
test('ordinary WebP defaults on, accepts false, rejects nonboolean', () => {
  assert.equal(parseD2cRuntimeConfig(raw).d2c.imageVariants?.enabled ?? true, true);
  const configured = { ...raw, d2c: { ...raw.d2c, imageVariants: { enabled: false } } };
  assert.equal(parseD2cRuntimeConfig(configured).d2c.imageVariants?.enabled, false);
  assert.throws(() =>
    parseD2cRuntimeConfig({ ...raw, d2c: { ...raw.d2c, imageVariants: { enabled: 'false' } } }),
  );
});
