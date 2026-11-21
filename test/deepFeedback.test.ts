import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeepToolFeedback } from '../src/functions/d2c/run/agent/feedback';
import {
  diagnoseRunFailure,
  RunExecutionError,
  type FailureCommand,
  type FailureTool,
} from '../src/functions/d2c/run/errors';
import {
  ToolIssue,
  readToolFeedback,
  toolFeedback,
  type ToolFeedbackCode,
} from '../src/functions/d2c/run/toolFeedback';

/** 每个 fixture 对应一轮执行，预算和阻塞均不跨轮共享。 */
function fixture(assertLease: () => Promise<void> = async () => {}) {
  const controller = new AbortController();
  return {
    controller,
    feedback: createDeepToolFeedback({ signal: controller.signal, assertLease }),
  };
}

/** 同时覆盖返回的结构化反馈与主层显式抛出的参数/工具问题。 */
function issueAction(code: ToolFeedbackCode, thrown: boolean, path?: string) {
  const feedback = toolFeedback(code, { path });
  const failure = new RunExecutionError('TOOL_FAILED', {
    stage: 'tool',
    tool: 'figma',
    command: 'fetch-node',
    requiresUser: true,
  });
  return {
    failure,
    action: async () => {
      if (thrown) throw new ToolIssue(feedback, failure);
      return JSON.stringify(feedback);
    },
  };
}

test('同名会话文件与固定资源分别纠错，耗尽后保留路径、资源类型和原始反馈', async () => {
  const { feedback } = fixture();
  const path = 'templates/skills/pp-d2c/missing.md';
  for (const resource of [true, false]) {
    for (let count = 0; count < 10; count++) {
      const result = await feedback.run('read_file', async () =>
        JSON.stringify(toolFeedback('FILE_NOT_FOUND', { path, resource })),
      );
      assert.equal(readToolFeedback(result)?.code, 'FILE_NOT_FOUND');
    }
  }
  const exhausted = readToolFeedback(
    await feedback.run('read_file', async () =>
      JSON.stringify(toolFeedback('FILE_NOT_FOUND', { path, resource: true })),
    ),
  );
  assert.equal(exhausted?.code, 'ADJUSTMENT_EXHAUSTED');
  assert.equal(exhausted?.path, path);
  assert.equal(exhausted?.resource, true);
  assert.throws(feedback.assertUnblocked, (error: unknown) => {
    const report = diagnoseRunFailure(error);
    assert.equal(report.diagnostics.feedbackCode, 'ADJUSTMENT_EXHAUSTED');
    assert.equal(report.diagnostics.originalFeedbackCode, 'FILE_NOT_FOUND');
    assert.equal(report.diagnostics.readPath, path);
    assert.equal(report.diagnostics.resource, true);
    assert.ok(!JSON.stringify(report.failure).includes(path));
    return true;
  });
});

test('读取诊断拒绝宿主绝对路径、穿越、链接参数和异常正文', () => {
  for (const path of [
    '/etc/passwd',
    '../secret.txt',
    '/resources/../secret.txt',
    'a?token=secret',
  ]) {
    const error = new RunExecutionError('TOOL_FAILED', {
      stage: 'tool',
      tool: 'read_file',
      feedback: {
        code: 'ADJUSTMENT_EXHAUSTED',
        originalCode: 'FILE_NOT_FOUND',
        path,
        resource: true,
      },
    });
    const report = diagnoseRunFailure(error);
    assert.equal(report.diagnostics.readPath, undefined);
    assert.equal(report.diagnostics.resource, undefined);
  }
});

for (const thrown of [false, true]) {
  const mode = thrown ? 'ToolIssue' : '返回反馈';

  test(`${mode}：retry 按工具累计两次，成功和错误码切换不重置预算`, async () => {
    const { feedback } = fixture();
    for (const code of ['NETWORK_RETRY', 'RATE_LIMITED'] as const) {
      const result = await feedback.run(
        'figma',
        issueAction(code, thrown).action,
        code === 'NETWORK_RETRY' ? 'export-image' : 'inspect-node',
      );
      assert.equal(readToolFeedback(result)?.code, code);
    }
    assert.equal(await feedback.run('figma', async () => 'success'), 'success');
    assert.equal(
      readToolFeedback(
        await feedback.run('prepare_slices', issueAction('NETWORK_RETRY', thrown).action),
      )?.code,
      'NETWORK_RETRY',
    );
    const issue = issueAction('NETWORK_RETRY', thrown);
    assert.equal(
      readToolFeedback(await feedback.run('figma', issue.action, 'cache-check'))?.code,
      'RETRY_EXHAUSTED',
    );
    assert.throws(feedback.assertUnblocked, (error: unknown) =>
      thrown ? error === issue.failure : error instanceof RunExecutionError,
    );
    fixture().feedback.assertUnblocked();
  });

  test(`${mode}：adjust 按工具、错误码、路径累计十次，第十一次耗尽`, async () => {
    const { feedback } = fixture();
    for (let count = 0; count < 10; count++)
      assert.equal(
        readToolFeedback(
          await feedback.run('read_file', issueAction('FILE_NOT_FOUND', thrown, 'a.tsx').action),
        )?.code,
        'FILE_NOT_FOUND',
      );
    for (const [name, code, path] of [
      ['read_file', 'FILE_NOT_FOUND', 'b.tsx'],
      ['read_file', 'INVALID_ARGUMENT', 'a.tsx'],
      ['write_file', 'FILE_NOT_FOUND', 'a.tsx'],
    ] as const)
      assert.equal(
        readToolFeedback(await feedback.run(name, issueAction(code, thrown, path).action))?.code,
        code,
      );
    const issue = issueAction('FILE_NOT_FOUND', thrown, 'a.tsx');
    assert.equal(
      readToolFeedback(await feedback.run('read_file', issue.action))?.code,
      'ADJUSTMENT_EXHAUSTED',
    );
    assert.throws(feedback.assertUnblocked, RunExecutionError);
  });

  test(`${mode}：导图与节点读取各有十次纠错，成功不重置且第十一次原命令阻塞`, async () => {
    for (const exhaustedCommand of ['export-image', 'inspect-node'] as const) {
      const { feedback } = fixture();
      for (const command of ['export-image', 'inspect-node'] as const) {
        for (let count = 0; count < 10; count++) {
          const issue = issueAction('INVALID_ARGUMENT', thrown);
          // 抛出的 ToolIssue 故意携带旧命令或没有命令，不能改变调用方预算。
          if (count % 2 === 0) delete issue.failure.context.command;
          else issue.failure.context.command = 'fetch-node';
          assert.equal(
            readToolFeedback(await feedback.run('figma', issue.action, command))?.code,
            'INVALID_ARGUMENT',
          );
        }
        feedback.assertUnblocked();
      }
      assert.equal(await feedback.run('figma', async () => 'success', exhaustedCommand), 'success');
      const issue = issueAction('INVALID_ARGUMENT', thrown);
      const result = await feedback.run('figma', issue.action, exhaustedCommand);
      assert.equal(readToolFeedback(result)?.code, 'ADJUSTMENT_EXHAUSTED');
      assert.throws(feedback.assertUnblocked, (error: unknown) => {
        assert.ok(error instanceof RunExecutionError);
        assert.equal(error.context.command, exhaustedCommand);
        assert.equal(error.context.feedback?.originalCode, 'INVALID_ARGUMENT');
        return true;
      });
      let called = false;
      await assert.rejects(
        feedback.run(
          'figma',
          async () => {
            called = true;
          },
          exhaustedCommand === 'export-image' ? 'inspect-node' : 'export-image',
        ),
        RunExecutionError,
      );
      assert.equal(called, false);
    }
  });

  test(`${mode}：缺少调用方命令时不从 ToolIssue 推导分组`, async () => {
    const { feedback } = fixture();
    for (let count = 0; count < 11; count++) {
      const issue = issueAction('INVALID_ARGUMENT', thrown);
      issue.failure.context.command = count % 2 ? 'export-image' : 'inspect-node';
      const result = await feedback.run('figma', issue.action);
      assert.equal(
        readToolFeedback(result)?.code,
        count < 10 ? 'INVALID_ARGUMENT' : 'ADJUSTMENT_EXHAUSTED',
      );
    }
    assert.throws(feedback.assertUnblocked, RunExecutionError);
  });

  test(`${mode}：命令分组仍保留错误码、路径与资源分类`, async () => {
    const { feedback } = fixture();
    const command: FailureCommand = 'inspect-node';
    for (const [code, path, resource] of [
      ['INVALID_ARGUMENT', 'a.json', true],
      ['INVALID_ARGUMENT', 'a.json', false],
      ['INVALID_ARGUMENT', 'b.json', true],
      ['FILE_NOT_FOUND', 'a.json', true],
    ] as const) {
      for (let count = 0; count < 10; count++) {
        const detail = toolFeedback(code, { path, resource });
        const action = async () => {
          if (thrown)
            throw new ToolIssue(detail, new RunExecutionError('TOOL_FAILED', { stage: 'tool' }));
          return JSON.stringify(detail);
        };
        assert.equal(readToolFeedback(await feedback.run('figma', action, command))?.code, code);
      }
    }
    feedback.assertUnblocked();
    assert.equal(
      readToolFeedback(
        await feedback.run(
          'figma',
          async () =>
            JSON.stringify(toolFeedback('INVALID_ARGUMENT', { path: 'a.json', resource: true })),
          command,
        ),
      )?.code,
      'ADJUSTMENT_EXHAUSTED',
    );
  });

  test(`${mode}：RULES_FAILED 不受纠错上限限制`, async () => {
    const { feedback } = fixture();
    for (let count = 0; count < 10; count++)
      assert.equal(
        readToolFeedback(
          await feedback.run('check_rules', issueAction('RULES_FAILED', thrown).action),
        )?.code,
        'RULES_FAILED',
      );
    feedback.assertUnblocked();
  });
}

test('成功值保持类型与引用，返回反馈保留完整规则报告和文本块', async () => {
  let leases = 0;
  const { feedback } = fixture(async () => {
    leases++;
  });
  const files = ['a.tsx'];
  assert.equal(await feedback.run('list_files', async () => files), files);
  const report = JSON.stringify({ ...toolFeedback('RULES_FAILED'), report: 'fix jsx' });
  assert.equal(await feedback.run('check_rules', async () => report), report);
  assert.equal(
    readToolFeedback(
      await feedback.run('check_rules', async () => [{ type: 'text', text: report }]),
    )?.code,
    'RULES_FAILED',
  );
  assert.equal(leases, 6);
  feedback.assertUnblocked();
});

test('user 反馈允许 list/read，成功读取和最终答复不能清除原始 failure', async () => {
  const { feedback } = fixture();
  const issue = issueAction('ACCESS_REQUIRED', true);
  assert.equal(readToolFeedback(await feedback.run('figma', issue.action))?.action, 'user');
  assert.equal(
    await feedback.run('list_files', async () => ['a.tsx']).then(JSON.stringify),
    '["a.tsx"]',
  );
  assert.equal(await feedback.run('read_file', async () => 'source'), 'source');
  await feedback.run('read_file', issueAction('CONFIRMATION_REQUIRED', true).action);
  assert.throws(feedback.assertUnblocked, (error: unknown) => error === issue.failure);
  assert.throws(feedback.assertUnblocked, (error: unknown) => error === issue.failure);
});

test('user 阻塞禁止所有非 list/read 工具执行', async () => {
  const names: FailureTool[] = [
    'prepare_slices',
    'write_file',
    'delete_file',
    'figma',
    'delegate_agent',
    'check_rules',
  ];
  for (const name of names) {
    const { feedback } = fixture();
    const issue = issueAction('ACCESS_REQUIRED', true);
    await feedback.run('figma', issue.action);
    let called = false;
    await assert.rejects(
      feedback.run(name, async () => {
        called = true;
      }),
      (error: unknown) => error === issue.failure,
    );
    assert.equal(called, false);
    assert.throws(feedback.assertUnblocked, (error: unknown) => error === issue.failure);
  }
});

test('返回的确认反馈保留 command 与 requiresUser，最终不能以普通答复完成', async () => {
  const { feedback } = fixture();
  await feedback.run('figma', issueAction('CONFIRMATION_REQUIRED', false).action, 'export-image');
  assert.throws(feedback.assertUnblocked, (error: unknown) => {
    assert.ok(error instanceof RunExecutionError);
    assert.equal(error.code, 'CONFIRMATION_REQUIRED');
    assert.deepEqual(error.context, {
      stage: 'tool',
      tool: 'figma',
      command: 'export-image',
      requiresUser: true,
      feedback: {
        code: 'CONFIRMATION_REQUIRED',
        originalCode: 'CONFIRMATION_REQUIRED',
        path: undefined,
        resource: undefined,
      },
    });
    return true;
  });
});

test('工具原始异常固定分类，敏感正文只留在 cause，故障不能被后续调用吞掉', async () => {
  const { feedback } = fixture();
  const secret = new Error('private token and upstream body');
  let caught: unknown;
  await assert.rejects(
    feedback.run(
      'figma',
      async () => {
        throw secret;
      },
      'fetch-node',
    ),
    (error: unknown) => {
      assert.ok(error instanceof RunExecutionError);
      caught = error;
      assert.equal(error.code, 'TOOL_FAILED');
      assert.deepEqual(error.context, { stage: 'tool', tool: 'figma', command: 'fetch-node' });
      assert.equal(error.cause, secret);
      assert.doesNotMatch(error.message + JSON.stringify(error), /private token|upstream body/);
      return true;
    },
  );
  await assert.rejects(
    feedback.run('read_file', async () => assert.fail('must not execute')),
    (error: unknown) => error === caught,
  );
  assert.throws(feedback.assertUnblocked, (error: unknown) => error === caught);
});

test('租约失败在 action 前及 action 后固定映射为 LEASE_LOST', async () => {
  for (const failAt of [1, 2]) {
    let leases = 0;
    let calls = 0;
    const raw = new Error('private lease response');
    const { feedback } = fixture(async () => {
      if (++leases === failAt) throw raw;
    });
    await assert.rejects(
      feedback.run(
        'figma',
        async () => {
          calls++;
          return 'ok';
        },
        'fetch-node',
      ),
      (error: unknown) => {
        assert.ok(error instanceof RunExecutionError);
        assert.equal(error.code, 'LEASE_LOST');
        assert.deepEqual(error.context, { stage: 'worker', tool: 'figma', command: 'fetch-node' });
        assert.doesNotMatch(error.message, /private/);
        return true;
      },
    );
    assert.equal(calls, failAt - 1);
    assert.throws(feedback.assertUnblocked, RunExecutionError);
  }
});

test('严重存储和已有租约异常保留分类、阶段、工具及命令', async () => {
  for (const code of ['STORAGE_FAILED', 'LEASE_LOST'] as const) {
    for (const source of ['tool', 'lease'] as const) {
      const original = new RunExecutionError(
        code,
        {
          stage: code === 'STORAGE_FAILED' ? 'storage' : 'worker',
          tool: 'prepare_slices',
          command: 'cache-check',
        },
        new Error('private database/lease details'),
      );
      const { feedback } = fixture(async () => {
        if (source === 'lease') throw original;
      });
      await assert.rejects(
        feedback.run(
          'figma',
          async () => {
            throw original;
          },
          'fetch-node',
        ),
        (error: unknown) => {
          assert.ok(error instanceof RunExecutionError);
          assert.equal(error.code, code);
          assert.deepEqual(error.context, original.context);
          assert.doesNotMatch(error.message + JSON.stringify(error), /private database/);
          return true;
        },
      );
      assert.throws(feedback.assertUnblocked, RunExecutionError);
    }
  }
});

test('预先取消及 action 执行期间取消保留 RUN_TIMEOUT，不返回成功或反馈', async () => {
  for (const before of [true, false]) {
    const { controller, feedback } = fixture();
    const reason = new RunExecutionError('RUN_TIMEOUT', { stage: 'worker' });
    if (before) controller.abort(reason);
    let called = false;
    await assert.rejects(
      feedback.run('figma', async () => {
        called = true;
        controller.abort(reason);
        return JSON.stringify(toolFeedback('NETWORK_RETRY'));
      }),
      (error: unknown) => error instanceof RunExecutionError && error.code === 'RUN_TIMEOUT',
    );
    assert.equal(called, !before);
    assert.throws(feedback.assertUnblocked, RunExecutionError);
  }
  const { controller, feedback } = fixture();
  controller.abort(new Error('private abort reason'));
  assert.throws(
    feedback.assertUnblocked,
    (error: unknown) => error instanceof RunExecutionError && !error.message.includes('private'),
  );
});

test('retry 等待可取消；取消后不再检查租约或执行 action', async () => {
  let leases = 0;
  const { controller, feedback } = fixture(async () => {
    leases++;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = feedback.run('figma', async () => {
    started();
    return JSON.stringify(toolFeedback('RATE_LIMITED', { retryAfterMs: 300000 }));
  });
  const rejected = assert.rejects(
    pending,
    (error: unknown) => error instanceof RunExecutionError && error.code === 'WORKER_INTERRUPTED',
  );
  await ready;
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new RunExecutionError('WORKER_INTERRUPTED', { stage: 'worker' }));
  await rejected;
  assert.equal(leases, 1);
});

test('retry 等待结束后复核租约，且不会自动重放工具', async () => {
  let leases = 0;
  let calls = 0;
  const { feedback } = fixture(async () => {
    if (++leases === 2) throw new RunExecutionError('LEASE_LOST', { stage: 'worker' });
  });
  await assert.rejects(
    feedback.run('figma', async () => {
      calls++;
      throw new ToolIssue(
        toolFeedback('RATE_LIMITED', { retryAfterMs: 1 }),
        new RunExecutionError('TOOL_FAILED', { stage: 'tool' }),
      );
    }),
    (error: unknown) => error instanceof RunExecutionError && error.code === 'LEASE_LOST',
  );
  assert.equal(calls, 1);
  assert.equal(leases, 2);
});

for (const thrown of [false, true]) {
  test(`未知命令不论如何改名共用同一纠错预算：${thrown ? 'ToolIssue' : '返回反馈'}`, async () => {
    const { feedback } = fixture();
    for (let count = 0; count < 11; count++) {
      const result = await feedback.run(
        'figma',
        issueAction('INVALID_ARGUMENT', thrown).action,
        `unvalidated-command-${count}` as FailureCommand,
      );
      assert.equal(
        readToolFeedback(result)?.code,
        count < 10 ? 'INVALID_ARGUMENT' : 'ADJUSTMENT_EXHAUSTED',
      );
    }
    assert.throws(feedback.assertUnblocked, RunExecutionError);
  });
}
