import './helpers/projectFixture';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createGenerationTools } from '../src/functions/d2c/run/tools';
import {
  RunExecutionError,
  diagnoseRunFailure,
  type FailureCode,
} from '../src/functions/d2c/run/errors';
import { ToolIssue } from '../src/functions/d2c/run/toolFeedback';

const secret = 'private-token-body-and-arguments';

/** 只检查内存 cause 的身份，不序列化原始异常；投影必须拒绝全部敏感字符串。 */
function checkFailure(error: unknown, code: FailureCode, original?: unknown) {
  if (error instanceof ToolIssue) error = error.failure;
  assert.ok(error instanceof RunExecutionError);
  assert.equal(error.code, code);
  if (original) {
    let current: unknown = error;
    let found = false;
    for (let depth = 0; current instanceof Error && depth < 8; depth++) {
      if (current === original) {
        found = true;
        break;
      }
      current = current.cause;
    }
    assert.ok(found, '原始 cause 必须仍在内存链上');
  }
  assert.doesNotMatch(
    JSON.stringify(diagnoseRunFailure(error)),
    /private-token-body-and-arguments|stderr-secret|stdout-secret|upstream-secret/,
  );
  assert.doesNotMatch(String(error), /private-token-body-and-arguments|upstream-secret/);
  return true;
}

/** 每例创建独立可信脚本和私有目录，使用真实 Node 子进程，不连接外部服务。 */
async function toolFixture(t: TestContext, figma: string, rules = 'process.exit(0);') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-diagnostics-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const resources = path.join(directory, 'resources');
  const workspace = path.join(directory, 'workspace');
  const bin = path.join(resources, 'templates/skills/pp-d2c/bin');
  const slices = path.join(resources, 'templates/skills/pp-d2c-reskin');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(slices, { recursive: true });
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'pp-d2c.config.json'), '{}');
  await fs.writeFile(path.join(bin, 'figma.mjs'), figma);
  await fs.writeFile(path.join(bin, 'check-rules.mjs'), rules);
  await fs.writeFile(
    path.join(slices, 'reskin-slice.mjs'),
    `import fs from 'node:fs';
    fs.writeFileSync('reskin-invoked', 'unexpected');
    throw new Error('Native slices must never invoke reskin-slice.mjs');`,
  );
  const input = {
    restored: {
      directory,
      resources,
      workspace,
      skill: '',
      skillFile: '',
      configHash: '',
      bundleHash: '',
      dispose: async () => {},
    },
    figmaUrl: 'https://www.figma.com/design/fixedKey/Test?node-id=1-2' as string | null,
    target: 'h5' as const,
    proxyUrl: 'http://unused.internal:8080',
    allowedHosts: ['api.figma.com'],
    textFileBytes: 65536,
    uploadBytes: 65536,
    signal: new AbortController().signal,
    token: async () => secret,
    redact: (value: string) => value,
    save: async () => {},
    saveBinary: async () => {},
    remove: async () => {},
    assertLease: async () => {},
  };
  return { input, bin, workspace };
}

test('真实脚本异常保留退出元数据与 command，stderr/stdout/参数不进入诊断', async (t) => {
  const f = await toolFixture(
    t,
    `console.error('stderr-secret'); console.log('stdout-secret'); process.exit(7);`,
  );
  const runtime = await createGenerationTools(f.input);
  await assert.rejects(runtime.tools.figma('fetch-node', {}), (error) => {
    checkFailure(error, 'SCRIPT_FAILED');
    assert.ok(error instanceof RunExecutionError);
    assert.deepEqual(error.context, { stage: 'tool', tool: 'figma', command: 'fetch-node' });
    let current: unknown = error;
    while (current instanceof RunExecutionError) current = current.cause;
    const cause = current as {
      code: unknown;
      stdout: string;
      stderr: string;
      killed: boolean;
      signal: unknown;
    };
    assert.equal(cause.code, 7);
    assert.equal(cause.killed, false);
    assert.equal(cause.signal, null);
    assert.match(cause.stderr, /stderr-secret/);
    assert.match(cause.stdout, /stdout-secret/);
    assert.equal(diagnoseRunFailure(error).diagnostics.exitCode, 7);
    return true;
  });
});

test('Figma 返回错误文本不能指定分类，JSON 失败保留原因；缺 URL 和违规路径分类明确', async (t) => {
  for (const body of [
    JSON.stringify({ ok: false, error: 'ETIMEDOUT 401 upstream-secret' }),
    'upstream-secret',
  ]) {
    const f = await toolFixture(t, `console.log(${JSON.stringify(body)});`);
    const runtime = await createGenerationTools(f.input);
    await assert.rejects(runtime.tools.figma('fetch-node', {}), (error) =>
      checkFailure(
        error,
        body === 'upstream-secret' ? 'SCRIPT_OUTPUT_INVALID' : 'FIGMA_REQUEST_FAILED',
      ),
    );
    await assert.rejects(
      runtime.tools.write('../escape', secret),
      (error) => error instanceof ToolIssue && error.feedback.code === 'INVALID_ARGUMENT',
    );
    await assert.rejects(
      runtime.tools.write('.d2c-cache/fixedKey/slice-manifest-test.json', '{"confirmed":true}'),
      (error) => error instanceof ToolIssue && error.feedback.code === 'FILE_WRITE_NOT_ALLOWED',
    );
  }
  const f = await toolFixture(t, 'process.exit(0);');
  f.input.figmaUrl = null;
  const runtime = await createGenerationTools(f.input);
  await assert.rejects(runtime.tools.figma('fetch-node', {}), (error) =>
    checkFailure(error, 'FIGMA_ADDRESS_MISSING'),
  );
  await assert.rejects(runtime.tools.slices('test'), (error) =>
    checkFailure(error, 'FIGMA_ADDRESS_MISSING'),
  );
});

test('Figma CLI 非零退出保留退出码，大输出超限继续拒绝，非法 JSON 单独分类', async (t) => {
  for (const [source, maximum, expected] of [
    [
      `console.log(JSON.stringify({ok:false,error:'private upstream'}));process.exit(7);`,
      65536,
      'SCRIPT_FAILED',
    ],
    [
      `console.log(JSON.stringify({ok:true,data:'x'.repeat(200000)}));process.exit(0);`,
      65536,
      'SCRIPT_FAILED',
    ],
    [`console.log('{"ok":true');process.exit(0);`, 65536, 'SCRIPT_OUTPUT_INVALID'],
  ] as const) {
    const f = await toolFixture(t, source);
    f.input.textFileBytes = maximum;
    const runtime = await createGenerationTools(f.input);
    await assert.rejects(runtime.tools.figma('fetch-node', {}), (error) => {
      checkFailure(error, expected);
      if (source.includes('exit(7)'))
        assert.equal(diagnoseRunFailure(error).diagnostics.exitCode, 7);
      return true;
    });
  }
});

test('Figma CLI exit 1 的缺失节点反馈可纠正，旧快照脚本无需更新', async (t) => {
  const f = await toolFixture(
    t,
    `
    const [, key, node] = process.argv.slice(2);
    if (node === '1:2') {
      console.log(JSON.stringify({ok:false,error:\`节点 \${node} 在文件 \${key} 中未找到\`}));
      process.exit(1);
    } else console.log(JSON.stringify({ok:true,data:{node:{id:node}}}));
  `,
  );
  const runtime = await createGenerationTools(f.input);
  const { createDeepToolFeedback } = await import('../src/functions/d2c/run/agent/feedback');
  const feedback = createDeepToolFeedback(f.input);
  const first = JSON.parse(
    (await feedback.run(
      'figma',
      () => runtime.tools.figma('fetch-node', {}),
      'fetch-node',
    )) as string,
  );
  assert.equal(first.code, 'FIGMA_NODE_NOT_FOUND');
  assert.equal(first.action, 'adjust');
  assert.match(first.message, /1:2/);
  const next = JSON.parse(
    (await feedback.run(
      'figma',
      () => runtime.tools.figma('fetch-node', { nodeId: '1:3' }),
      'fetch-node',
    )) as string,
  );
  assert.equal(next.ok, true);
  feedback.assertUnblocked();
});

test('失败信封保留安全诊断；未知正文、标准文件错误和伪造状态均不作为重试依据', async (t) => {
  for (const [message, reason, causeCode] of [
    ['private-token-body-and-arguments ETIMEDOUT HTTP 401', 'REPORTED_ERROR', undefined],
    [
      "ENOSPC: no space left on device, open '/private/upstream-secret.json'",
      'FILE_SYSTEM_ERROR',
      'ENOSPC',
    ],
  ] as const) {
    const f = await toolFixture(
      t,
      `console.log(JSON.stringify({ok:false,error:${JSON.stringify(message)},statusCode:503,code:'ECONNRESET'}));process.exit(1);`,
    );
    const runtime = await createGenerationTools(f.input);
    await assert.rejects(runtime.tools.figma('fetch-node', {}), (error) => {
      checkFailure(error, 'FIGMA_REQUEST_FAILED');
      assert.ok(!(error instanceof ToolIssue));
      const report = diagnoseRunFailure(error);
      assert.equal(report.diagnostics.scriptReason, reason);
      assert.equal(report.diagnostics.causeCode, causeCode);
      assert.equal(report.diagnostics.nodeId, '1:2');
      assert.equal(report.diagnostics.exitCode, 1);
      assert.equal(report.diagnostics.statusCode, undefined);
      return true;
    });
  }
});

test('可信网络状态优先于失败正文，限流/网络可重试，鉴权需要用户处理', async (t) => {
  for (const [network, expected, status] of [
    [{ statusCode: 503, phase: 'response' }, 'NETWORK_RETRY', 503],
    [{ statusCode: 400, phase: 'response' }, 'INVALID_ARGUMENT', 400],
    [{ statusCode: 403, phase: 'response' }, 'ACCESS_REQUIRED', 403],
    [{ statusCode: 429, retryAfterMs: 1000, phase: 'response' }, 'RATE_LIMITED', 429],
    [{ code: 'ECONNRESET', phase: 'body', statusCode: 200 }, 'NETWORK_RETRY', 200],
  ] as const) {
    const f = await toolFixture(
      t,
      `import fs from 'node:fs';
      fs.writeFileSync(process.env.PIXELPRINT_NETWORK_DIAGNOSTIC, ${JSON.stringify(JSON.stringify(network))});
      console.log(JSON.stringify({ok:false,error:'upstream-secret'}));process.exit(1);`,
    );
    const runtime = await createGenerationTools(f.input);
    await assert.rejects(runtime.tools.figma('fetch-node', {}), (error) => {
      assert.ok(error instanceof ToolIssue);
      assert.equal(error.feedback.code, expected);
      checkFailure(error, error.failure.code);
      const report = diagnoseRunFailure(error.failure);
      assert.equal(report.diagnostics.exitCode, 1);
      assert.equal(report.diagnostics.statusCode, status);
      assert.equal(report.diagnostics.scriptPhase, network.phase);
      return true;
    });
  }
});

test('脚本返回失败时仍先复查取消和租约，不发送可纠正反馈', async (t) => {
  const f = await toolFixture(
    t,
    `console.log(JSON.stringify({ok:false,error:'节点 1:2 在文件 fixedKey 中未找到'}));process.exit(1);`,
  );
  let checks = 0;
  const runtime = await createGenerationTools({
    ...f.input,
    assertLease: async () => {
      if (++checks === 2) throw new RunExecutionError('LEASE_LOST', { stage: 'worker' });
    },
  });
  await assert.rejects(runtime.tools.figma('fetch-node', {}), (error) =>
    checkFailure(error, 'LEASE_LOST'),
  );
  const controller = new AbortController();
  const next = await toolFixture(t, 'process.exit(0);');
  const stopped = await createGenerationTools({ ...next.input, signal: controller.signal });
  controller.abort(new RunExecutionError('RUN_TIMEOUT', { stage: 'worker' }));
  await assert.rejects(stopped.tools.figma('fetch-node', {}), (error) =>
    checkFailure(error, 'RUN_TIMEOUT'),
  );
});

test('脚本输出超限优先于网络重试，不能因残留503诊断继续重放', async (t) => {
  const f = await toolFixture(
    t,
    `import fs from 'node:fs';
    fs.writeFileSync(process.env.PIXELPRINT_NETWORK_DIAGNOSTIC,JSON.stringify({statusCode:503}));
    console.log('x'.repeat(200000));`,
  );
  const runtime = await createGenerationTools(f.input);
  await assert.rejects(runtime.tools.figma('fetch-node', {}), (error) => {
    assert.ok(!(error instanceof ToolIssue));
    checkFailure(error, 'SCRIPT_FAILED');
    assert.equal(
      diagnoseRunFailure(error).diagnostics.causeCode,
      'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    );
    return true;
  });
});
