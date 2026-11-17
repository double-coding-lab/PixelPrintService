import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Annotation,
  END,
  GraphRecursionError,
  MemorySaver,
  START,
  StateGraph,
} from '@langchain/langgraph';
import {
  GraphStepLimitError,
  graphExecutionLimits,
  runGraphWithRecovery,
} from '../src/functions/d2c/run/agent/graphRecovery';
import { RunExecutionError } from '../src/functions/d2c/run/errors';

/** 使用真实图检查点强制小步数边界，验证 null 续作没有重放已完成节点。 */
test('native graph resumes the same checkpoint with bounded slices and no repeated side effects', async () => {
  const state = Annotation.Root({
    count: Annotation<number>({ reducer: (_old, next) => next, default: () => 0 }),
  });
  const operations: number[] = [];
  const graph = new StateGraph(state)
    .addNode('work', async ({ count }) => {
      operations.push(count + 1);
      return { count: count + 1 };
    })
    .addEdge(START, 'work')
    .addConditionalEdges('work', ({ count }) => (count >= 8 ? END : 'work'))
    .compile({ checkpointer: new MemorySaver() });
  const config = {
    configurable: { thread_id: 'native-graph-budget' },
    durability: 'sync' as const,
  };
  const inputs: boolean[] = [];
  await runGraphWithRecovery({
    checkpoint: true,
    steps: 3,
    guard: async () => {},
    inspect: async () => ({
      signature: String((await graph.getState(config)).values.count ?? 0),
      complete: false,
    }),
    finish: async () => assert.fail('unfinished graph cannot claim delivery'),
    execute: async (resume, recursionLimit) => {
      inputs.push(resume);
      await graph.invoke(resume ? null : { count: 0 }, { ...config, recursionLimit });
    },
  });
  assert.deepEqual(inputs, [false, true, true]);
  assert.deepEqual(operations, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual((await graph.getState(config)).next, []);
  assert.ok(graphExecutionLimits.steps > 40 * 4 + 10);
});

/** 持续无持久进展或恢复额度用尽时返回可交接的明确错误，不启动无限循环。 */
for (const progressing of [false, true]) {
  test(`graph recovery is bounded when persisted progress=${progressing}`, async () => {
    let calls = 0;
    const cause = new GraphRecursionError('bounded graph');
    await assert.rejects(
      runGraphWithRecovery({
        checkpoint: true,
        guard: async () => {},
        inspect: async () => ({
          signature: progressing ? String(calls) : 'unchanged',
          complete: false,
        }),
        finish: async () => assert.fail('cannot finish incomplete files'),
        execute: async () => {
          calls++;
          throw cause;
        },
      }),
      (error: unknown) => error instanceof GraphStepLimitError && error.cause === cause,
    );
    assert.equal(calls, progressing ? 3 : 1);
  });
}

test('complete delivery is freshly verified and collected without another model call', async () => {
  let valid = false,
    checks = 0,
    finished = 0,
    calls = 0;
  await runGraphWithRecovery({
    checkpoint: true,
    guard: async () => {},
    inspect: async () => ({ signature: 'saved-files', complete: valid }),
    onLimit: async () => {
      checks++;
      valid = true;
    },
    finish: async () => {
      assert.equal(valid, true);
      finished++;
    },
    execute: async () => {
      calls++;
      throw new GraphRecursionError('finished files');
    },
  });
  assert.equal(calls, 1);
  assert.equal(checks, 1);
  assert.equal(finished, 1);
});

for (const phase of ['execute', 'verify', 'settle', 'cancel'] as const) {
  test(`graph handling preserves fatal ${phase} errors`, async () => {
    const original = new RunExecutionError('STORAGE_FAILED', { stage: 'storage' });
    let calls = 0;
    await assert.rejects(
      runGraphWithRecovery({
        checkpoint: true,
        guard: async () => {
          if (phase === 'cancel' && calls) throw original;
        },
        inspect: async () => ({ signature: 'complete', complete: true }),
        onLimit: async () => {
          if (phase === 'verify') throw original;
        },
        finish: async () => {
          if (phase === 'settle') throw original;
        },
        execute: async () => {
          calls++;
          throw phase === 'execute' ? original : new GraphRecursionError('limit');
        },
      }),
      (error: unknown) => error === original,
    );
    assert.equal(calls, 1);
  });
}

test('without a checkpointer graph exhaustion cannot be reported as completed or retried', async () => {
  let calls = 0;
  await assert.rejects(
    runGraphWithRecovery({
      checkpoint: false,
      guard: async () => {},
      inspect: async () => ({ signature: 'saved', complete: true }),
      finish: async () => assert.fail('missing checkpoint'),
      execute: async () => {
        calls++;
        throw new GraphRecursionError('limit');
      },
    }),
    GraphStepLimitError,
  );
  assert.equal(calls, 1);
});
