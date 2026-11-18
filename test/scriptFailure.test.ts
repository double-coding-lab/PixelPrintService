import './helpers/projectFixture';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { throwFigmaScriptFailure } from '../src/functions/d2c/run/scriptFailure';
import { diagnoseRunFailure, RunExecutionError } from '../src/functions/d2c/run/errors';
import { ToolIssue } from '../src/functions/d2c/run/toolFeedback';
import { createScriptNetworkPrelude } from '../src/functions/d2c/run/scriptNetwork';

const context = { stage: 'tool', tool: 'figma', command: 'fetch-node' } as const;

test('旧脚本信封只匹配本次节点的完整固定模板，额外上游内容不改变分类', () => {
  for (const [message, expected] of [
    ['节点 1:2 在文件 fixedKey 中未找到', 'FIGMA_NODE_NOT_FOUND'],
    ['节点 1:3 在文件 fixedKey 中未找到', undefined],
    ['节点 1:2 在文件 fixedKey 中未找到 upstream-secret', undefined],
  ] as const) {
    assert.throws(
      () =>
        throwFigmaScriptFailure({
          args: ['fetch-node', 'fixedKey', '1:2'],
          output: JSON.stringify({ ok: false, error: message }),
          context,
        }),
      (error) => {
        if (expected) assert.ok(error instanceof ToolIssue && error.feedback.code === expected);
        else assert.ok(error instanceof RunExecutionError);
        return true;
      },
    );
  }
});

test('非法输出、缺失导出图片和凭据分别分类，未知错误不透传', () => {
  for (const [command, message, expected] of [
    ['fetch-node', '{', 'SCRIPT_OUTPUT_INVALID'],
    [
      'export-image',
      JSON.stringify({ ok: false, error: 'Figma /v1/images 未返回 1:2 的 URL' }),
      'FIGMA_IMAGE_NOT_FOUND',
    ],
    [
      'screenshot',
      JSON.stringify({ ok: false, error: 'Figma /v1/images 未返回 1:2 的截图 URL' }),
      'FIGMA_IMAGE_NOT_FOUND',
    ],
    [
      'fetch-node',
      JSON.stringify({
        ok: false,
        error: 'FIGMA_TOKEN 未配置 (请在项目根 .env 写 FIGMA_TOKEN=xxx)',
      }),
      'ACCESS_REQUIRED',
    ],
  ] as const) {
    assert.throws(
      () =>
        throwFigmaScriptFailure({ args: [command, 'fixedKey', '1:2'], output: message, context }),
      (error) => {
        assert.equal(
          error instanceof ToolIssue ? error.feedback.code : (error as RunExecutionError).code,
          expected,
        );
        return true;
      },
    );
  }
});

test('网络前置在真实子进程保留阻止主机、无效JSON、响应超限及响应体断连原因', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-network-diagnostics-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const prelude = path.join(root, 'network.mjs');
  await fs.writeFile(prelude, createScriptNetworkPrelude());
  for (const [name, stub, operation, expected, status] of [
    [
      'blocked',
      "async()=>new Response('{}')",
      "await fetch('https://unapproved.example')",
      'HOST_NOT_ALLOWED',
      undefined,
    ],
    [
      'json',
      "async()=>new Response('private response')",
      "await (await fetch('https://api.figma.com/test')).json()",
      'INVALID_JSON',
      200,
    ],
    [
      'size',
      "async()=>new Response('x'.repeat(100))",
      "await (await fetch('https://api.figma.com/test')).text()",
      'RESPONSE_TOO_LARGE',
      200,
    ],
    [
      'body',
      "async()=>new Response(new ReadableStream({start(c){c.error(Object.assign(new Error('private error'),{code:'ECONNRESET'}))}}))",
      "await (await fetch('https://api.figma.com/test')).text()",
      'ECONNRESET',
      200,
    ],
  ] as const) {
    const diagnostic = path.join(root, `${name}.json`);
    const source = `globalThis.fetch=${stub}; await import(${JSON.stringify(prelude)}); try{${operation}}catch{};`;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
      env: {
        ...process.env,
        PIXELPRINT_ALLOWED_HOSTS: '["api.figma.com"]',
        PIXELPRINT_NETWORK_BYTES: '32',
        PIXELPRINT_NETWORK_DIAGNOSTIC: diagnostic,
      },
    });
    const network = JSON.parse(await fs.readFile(diagnostic, 'utf8'));
    assert.equal(network.code, expected);
    assert.equal(network.statusCode, status);
    assert.doesNotMatch(JSON.stringify(network), /private|api\.figma|unapproved/);
    assert.throws(
      () =>
        throwFigmaScriptFailure({
          args: ['fetch-node', 'fixedKey', '1:2'],
          output: '',
          context,
          network,
        }),
      (error) => {
        const report = diagnoseRunFailure(error instanceof ToolIssue ? error.failure : error);
        assert.equal(
          report.diagnostics.scriptReason,
          expected === 'ECONNRESET' ? 'NETWORK_ERROR' : expected,
        );
        return true;
      },
    );
  }
});
