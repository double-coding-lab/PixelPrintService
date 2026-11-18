import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { Sequelize } from 'sequelize';
import { installPreview } from '../src/functions/d2c/preview/runtime';
import { initModels } from '../src/models/index';
import type { EditService } from '../src/functions/d2c/edit/service';
import type { PreviewService } from '../src/functions/d2c/preview/service';

/** 两类访客/个人副本经原网关票据和 CSP，不落到原工作区编辑器。 */
test('广场和个人作品预览按独立前缀分发并保留 iframe 隔离', async (t) => {
  const app = Fastify();
  installPreview(app, {
    worker: false,
    service: { asset: async () => assert.fail('不得使用工作区预览') } as unknown as PreviewService,
  });
  const calls: unknown[][] = [];
  for (const [getter, kind] of [
    ['getPlazaEditService', 'plaza'],
    ['getSavedWorkEditService', 'own'],
  ] as const) {
    app[getter] = async () =>
      ({
        asset: async (...args: unknown[]) => {
          calls.push([kind, ...args]);
          return { mimeType: 'text/html', content: Buffer.from('<html><body>copy</body></html>') };
        },
      }) as unknown as EditService;
  }
  t.after(() => app.close());
  for (const [prefix, kind] of [
    ['plazaedit-', 'plaza'],
    ['workedit-', 'own'],
  ] as const) {
    const previewId = prefix + '12345678-1234-4234-8234-123456789012';
    const token = 'a'.repeat(64);
    const result = await app.inject(`/H5_Preview/${previewId}/${token}/index.html`);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(calls.at(-1), [kind, 'h5', previewId, token, 'index.html']);
    assert.match(String(result.headers['content-security-policy']), /sandbox allow-scripts;/);
    assert.doesNotMatch(String(result.headers['content-security-policy']), /allow-same-origin/);
    assert.match(result.body, /data-pixelprint-inspector/);
  }
});

/** SQL 审核规则同时约束模型事实源，避免发布后临时编辑数据没有永久保存表。 */
test('广场与个人作品模型已注册，字段带备注且大字段允许空，迁移仅新增表', () => {
  const mysql = new Sequelize('mysql://unused:unused@127.0.0.1/unused', { logging: false });
  const models = initModels(mysql);
  for (const name of ['D2cSessionShare', 'D2cSavedWork', 'D2cSavedWorkFile']) {
    assert.ok(models[name]);
    for (const [field, attribute] of Object.entries(models[name].getAttributes())) {
      assert.ok(attribute.comment, `${name}.${field} 缺少备注`);
      const type = (attribute.type as { key?: string }).key ?? '';
      if (/TEXT|BLOB|JSON/i.test(type)) assert.equal(attribute.allowNull, true);
      if (attribute.allowNull === false && !attribute.autoIncrement)
        assert.notEqual(attribute.defaultValue, undefined, `${name}.${field} 缺少默认值`);
    }
  }
  const sql = readFileSync('.Knowledge/req-docs/d2c-session-plaza_迁移.sql', 'utf8');
  assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length, 3);
  assert.doesNotMatch(
    sql,
    /DROP TABLE|DELETE FROM|ALTER TABLE `d2c_session`|ALTER TABLE `d2c_workspace`/i,
  );
});
