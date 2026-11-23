import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { createDelegationScheduler } from '../src/functions/d2c/run/agent/delegationScheduler';
import {
  createBackgroundDelegations,
  type Job,
} from '../src/functions/d2c/run/agent/backgroundDelegations';
import { ToolIssue } from '../src/functions/d2c/run/toolFeedback';

/** 用显式屏障检查执行与持久化先后，不依赖计时猜测。 */
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 每个用例独享调度器、取消信号与 fatal 记录。 */
function fixture() {
  const controller = new AbortController();
  const scheduler = createDelegationScheduler({ concurrency: 2, signal: controller.signal });
  const errors: unknown[] = [];
  const registry = createBackgroundDelegations({
    scheduler,
    signal: controller.signal,
    onFatal: (e) => {
      errors.push(e);
    },
  });
  return { controller, scheduler, registry, errors };
}

/** 确定身份与精确写权限，UI 目录预留另行传入。 */
function job(id: string): Job {
  return {
    agentId: id,
    key: id,
    role: 'ui',
    nodeId: id,
    writePaths: [`page/blocks/${id}/index.tsx`],
  };
}

/** 默认持久化不引入外部资源。 */
function persist() {
  return { settled: async (_result: string) => {}, observed: async () => {} };
}

test('启动先保存且同步预留，两个子任务并发、排队回执与父工具独立执行', async () => {
  const { scheduler, registry } = fixture();
  const started = barrier(),
    finish = barrier(),
    saved = barrier();
  const runs: string[] = [];
  let observed = 0;
  const first = registry.start(
    job('a'),
    ['page/blocks/a'],
    async () => {
      runs.push('a');
      await finish.promise;
      return '{"success":false}';
    },
    {
      started: () => started.promise,
      settled: () => saved.promise,
      observed: async () => {
        observed++;
      },
    },
  );
  assert.throws(() => scheduler.assertAvailable(job('a').writePaths), ToolIssue);
  assert.equal(runs.length, 0);
  assert.equal(registry.lookup('a'), first);
  assert.equal(
    registry.start(job('a'), [], async () => assert.fail('duplicate'), persist()),
    first,
  );
  const second = registry.start(
    job('b'),
    ['page/blocks/b'],
    async () => {
      runs.push('b');
      await finish.promise;
      return 'b';
    },
    persist(),
  );
  const third = await registry.start(
    job('c'),
    ['page/blocks/c'],
    async () => {
      runs.push('c');
      return 'c';
    },
    persist(),
  );
  assert.equal(third.status, 'queued');
  assert.throws(() => scheduler.exclusive(['page/blocks/c/style.css'], async () => {}), ToolIssue);
  assert.equal(await scheduler.exclusive(['page/root.tsx'], async () => 'parent'), 'parent');
  started.resolve();
  assert.equal((await first).status, 'running');
  await second;
  await setImmediate();
  assert.deepEqual(runs.sort(), ['a', 'b']);
  finish.resolve();
  await setImmediate();
  assert.equal((await registry.wait(['a'], false)).agents[0].status, 'running');
  assert.throws(() => scheduler.assertAvailable(['page/blocks/a']), ToolIssue);
  saved.resolve();
  await registry.drain();
  assert.equal(registry.hasActive(), false);
  assert.equal(registry.hasUnobserved(), true);
  assert.equal((await registry.wait(['a'], false)).agents[0].result, '{"success":false}');
  assert.equal(observed, 0);
  await Promise.all([registry.wait(['a']), registry.wait(['a'])]);
  assert.equal(observed, 1);
  assert.equal(registry.lookup('a'), undefined);
  await registry.wait();
  assert.equal(registry.hasUnobserved(), false);
  scheduler.assertAvailable(['page']);
});

test('restore 不执行结果保存，未知 ID 原子拒绝，观察后允许新 agentId 重试', async () => {
  const { registry } = fixture();
  let observations = 0;
  const persistence = {
    settled: async () => assert.fail('restored result rewritten'),
    observed: async () => {
      observations++;
    },
  };
  registry.restore(job('old'), 'restored', persistence);
  registry.restore(job('old'), 'ignored', persistence);
  assert.deepEqual(
    await registry.start(job('old'), [], async () => assert.fail('duplicate'), persist()),
    { accepted: true, agentId: 'old', status: 'completed' },
  );
  await assert.rejects(
    registry.wait(['old', 'unknown']),
    (e) => e instanceof ToolIssue && e.feedback.code === 'INVALID_ARGUMENT',
  );
  assert.equal(observations, 0);
  assert.equal((await registry.wait()).agents[0].result, 'restored');
  assert.equal(observations, 1);
  await registry.start({ ...job('new'), key: 'old' }, [], async () => 'retry', persist());
  await registry.drain();
  assert.equal((await registry.wait(['new'])).agents[0].result, 'retry');
});

test('启动保存失败不执行 child、不留排队 ghost 或路径，原始 fatal 可等待且无未处理拒绝', async () => {
  const { scheduler, registry, errors } = fixture();
  const finish = barrier();
  await registry.start(
    job('a'),
    ['a.ts'],
    async () => {
      await finish.promise;
      return 'a';
    },
    persist(),
  );
  await registry.start(
    job('b'),
    ['b.ts'],
    async () => {
      await finish.promise;
      return 'b';
    },
    persist(),
  );
  const original = new Error('startup storage');
  const starting = registry.start(job('c'), ['c.ts'], async () => assert.fail('child ran'), {
    ...persist(),
    started: async () => {
      throw original;
    },
  });
  await assert.rejects(starting, (e) => e === original);
  scheduler.assertAvailable(['c.ts']);
  assert.equal(registry.lookup('c'), undefined);
  assert.throws(
    () => registry.assertHealthy(),
    (e) => e === original,
  );
  await assert.rejects(registry.wait(), (e) => e === original);
  let drained = false;
  const draining = registry.drain().then(
    () => assert.fail('fatal swallowed'),
    (e) => {
      assert.equal(e, original);
      drained = true;
    },
  );
  await setImmediate();
  assert.equal(drained, false);
  finish.resolve();
  await draining;
  assert.deepEqual(errors, [original]);
});

test('action、settled、observed 失败原样上报一次；completed 不早于结果保存', async () => {
  for (const stage of ['action', 'settled', 'observed']) {
    const { registry, scheduler, errors } = fixture();
    const original = new Error(stage);
    await registry.start(
      job(stage),
      [stage],
      async () => {
        if (stage === 'action') throw original;
        return 'result';
      },
      {
        settled: async () => {
          if (stage === 'settled') throw original;
        },
        observed: async () => {
          if (stage === 'observed') throw original;
        },
      },
    );
    if (stage === 'observed') await registry.drain();
    await assert.rejects(registry.wait(), (e) => e === original);
    await assert.rejects(registry.drain(), (e) => e === original);
    assert.deepEqual(errors, [original]);
    scheduler.assertAvailable([stage]);
  }
});

test('共享取消清理排队任务并等待活动 action 结束，通知失败不替换原始异常', async () => {
  const { controller, registry, scheduler } = fixture();
  const gate = barrier();
  const original = new Error('cancelled');
  for (const id of ['a', 'b', 'c'])
    await registry.start(
      job(id),
      [id],
      async () => {
        await gate.promise;
        controller.signal.throwIfAborted();
        return id;
      },
      persist(),
    );
  controller.abort(original);
  const drained = assert.rejects(registry.drain(), (e) => e === original);
  gate.resolve();
  await drained;
  assert.equal(registry.hasActive(), false);
  const other = createBackgroundDelegations({
    scheduler,
    signal: new AbortController().signal,
    onFatal: () => {
      throw new Error('notification');
    },
  });
  other.rejectFatal(original);
  assert.throws(
    () => other.assertHealthy(),
    (e) => e === original,
  );
});

test('queued 启动保存期间重复调用共享回执，保存前不回 ack、同步冲突不注册任务', async () => {
  const { scheduler, registry } = fixture();
  const finish = barrier(),
    started = barrier();
  for (const id of ['a', 'b'])
    await registry.start(
      job(id),
      [id],
      async () => {
        await finish.promise;
        return id;
      },
      persist(),
    );
  let accepted = false,
    childRan = false;
  const pending = registry.start(
    job('queued'),
    ['page/blocks/queued'],
    async () => {
      childRan = true;
      return 'queued';
    },
    { ...persist(), started: () => started.promise },
  );
  void pending.then(() => {
    accepted = true;
  });
  assert.equal(registry.lookup('queued'), pending);
  assert.equal(
    registry.start(job('queued'), [], async () => assert.fail('duplicate'), persist()),
    pending,
  );
  assert.throws(
    () =>
      registry.start(
        job('conflict'),
        ['page/blocks/queued/index.tsx'],
        async () => assert.fail('conflict'),
        persist(),
      ),
    ToolIssue,
  );
  assert.equal(registry.lookup('conflict'), undefined);
  await setImmediate();
  assert.equal(accepted, false);
  assert.equal(childRan, false);
  started.resolve();
  assert.equal((await pending).status, 'queued');
  assert.equal(childRan, false);
  finish.resolve();
  await registry.drain();
  assert.equal(childRan, true);
  scheduler.assertAvailable(['page/blocks/queued']);
});

test('wait true 等待 observed 保存，wait false 保持未消费；无等待者的后台失败不泄漏拒绝', async () => {
  const { registry, errors } = fixture();
  const observed = barrier();
  registry.restore(job('restored'), 'saved', { ...persist(), observed: () => observed.promise });
  let returned = false;
  const waiting = registry.wait(['restored']).then((result) => {
    returned = true;
    return result;
  });
  await setImmediate();
  assert.equal(returned, false);
  assert.equal(registry.hasUnobserved(), true);
  assert.equal((await registry.wait(['restored'], false)).agents[0].result, 'saved');
  observed.resolve();
  await waiting;
  assert.equal(registry.hasUnobserved(), false);
  const failure = new Error('background failure');
  await registry.start(
    job('failed'),
    [],
    async () => {
      throw failure;
    },
    persist(),
  );
  await setImmediate();
  assert.deepEqual(errors, [failure]);
  await assert.rejects(registry.drain(), (e) => e === failure);
});

test('wait 空数组选择全部；活动任务触发自动等待，消费后 lookup 清空', async () => {
  const { registry } = fixture();
  const finish = barrier();
  let observations = 0;
  for (const id of ['a', 'b']) {
    await registry.start(
      job(id),
      [],
      async () => {
        await finish.promise;
        return id;
      },
      {
        ...persist(),
        observed: async () => {
          observations++;
        },
      },
    );
    const duplicate = await registry.lookup(id);
    assert.equal(duplicate?.agentId, id);
    assert.equal(duplicate?.status, 'running');
  }
  assert.equal(registry.hasUnobserved(), true);
  assert.equal(registry.hasActive(), true);
  const snapshot = await registry.wait([], false);
  assert.deepEqual(
    snapshot.agents.map((agent) => agent.agentId),
    ['a', 'b'],
  );
  assert.equal(observations, 0);
  let returned = false;
  const waiting = registry.wait([], true).then((result) => {
    returned = true;
    return result;
  });
  await setImmediate();
  assert.equal(returned, false);
  finish.resolve();
  const result = await waiting;
  assert.deepEqual(
    result.agents.map((agent) => agent.result),
    ['a', 'b'],
  );
  assert.equal(observations, 2);
  assert.equal(registry.hasActive(), false);
  assert.equal(registry.hasUnobserved(), false);
  assert.equal(registry.lookup('a'), undefined);
  assert.equal(registry.lookup('b'), undefined);
});

test('已观察 partial 可用同 agentId/key 重启，未观察或活动尝试保持幂等', async () => {
  const { registry } = fixture();
  const partial = '{"success":false,"partial":true}';
  let executions = 0,
    saves = 0,
    observations = 0;
  const persistence = {
    settled: async () => {
      saves++;
    },
    observed: async () => {
      observations++;
    },
  };
  const first = job('retry');
  registry.restore(first, partial, persistence);
  await registry.start(
    first,
    first.writePaths,
    async () => assert.fail('unobserved restarted'),
    persistence,
  );
  assert.equal((await registry.wait([])).agents[0].result, partial);
  assert.equal(registry.lookup(first.key), undefined);
  const finish = barrier();
  const pending = registry.start(
    first,
    first.writePaths,
    async () => {
      executions++;
      await finish.promise;
      return 'recovered';
    },
    persistence,
  );
  assert.equal(
    registry.start(
      first,
      first.writePaths,
      async () => assert.fail('active restarted'),
      persistence,
    ),
    pending,
  );
  await pending;
  assert.equal(registry.hasActive(), true);
  assert.equal(registry.hasUnobserved(), true);
  finish.resolve();
  assert.equal((await registry.wait([], true)).agents[0].result, 'recovered');
  assert.equal(executions, 1);
  assert.equal(saves, 1);
  assert.equal(observations, 2);
  assert.equal(registry.lookup(first.key), undefined);
});

test('相同 ID 不同 key 或相同 key 不同 ID 拒绝，已消费 ID 更换 key 时清理旧索引', async () => {
  const { registry, scheduler } = fixture();
  const first = job('same');
  registry.restore(first, 'partial', persist());
  for (const mismatched of [
    { ...first, key: 'other' },
    { ...first, agentId: 'other' },
  ]) {
    assert.throws(
      () => registry.start(mismatched, [], async () => assert.fail('mismatch ran'), persist()),
      ToolIssue,
    );
  }
  await registry.wait([]);
  const gate = barrier();
  const blocking = scheduler.exclusive(first.writePaths, () => gate.promise);
  assert.throws(
    () =>
      registry.start(first, first.writePaths, async () => assert.fail('conflict ran'), persist()),
    ToolIssue,
  );
  assert.equal((await registry.wait([first.agentId], false)).agents[0].result, 'partial');
  gate.resolve();
  await blocking;
  await registry.start(
    { ...first, key: 'new-key' },
    first.writePaths,
    async () => 'new',
    persist(),
  );
  await registry.drain();
  assert.equal(registry.lookup(first.key), undefined);
  assert.equal((await registry.lookup('new-key'))?.agentId, first.agentId);
  await registry.wait([]);
  assert.equal(registry.lookup('new-key'), undefined);
});

test('any 在 A 完成后唤醒且 C 自动补槽，B 保持活动锁；all 仍等待慢任务', async () => {
  const { registry, scheduler } = fixture();
  const gates = { a: barrier(), b: barrier(), c: barrier() };
  const savedA = barrier();
  const started: string[] = [],
    observed: string[] = [];
  for (const id of ['a', 'b', 'c'] as const) {
    const ack = await registry.start(
      job(id),
      [`page/blocks/${id}`],
      async () => {
        started.push(id);
        await gates[id].promise;
        return `result-${id}`;
      },
      {
        settled: async () => {
          if (id === 'a') await savedA.promise;
        },
        observed: async () => {
          observed.push(id);
        },
      },
    );
    if (id === 'c') assert.equal(ack.status, 'queued');
  }
  assert.deepEqual(started, ['a', 'b']);
  let returned = false;
  const waiting = registry.wait(['b', 'a', 'c'], true, 'any').then((result) => {
    returned = true;
    return result;
  });
  gates.a.resolve();
  await setImmediate();
  assert.equal(returned, false, '不能在 settled 保存前收取');
  assert.deepEqual(started, ['a', 'b']);
  savedA.resolve();
  const first = await waiting;
  assert.deepEqual(
    first.agents.map((agent) => agent.result),
    [undefined, 'result-a', undefined],
  );
  assert.deepEqual(started, ['a', 'b', 'c'], 'A 释放执行槽即启动已入队的 C，不等 B');
  assert.deepEqual(observed, ['a']);
  scheduler.assertAvailable(['page/blocks/a']);
  assert.throws(() => scheduler.assertAvailable(['page/blocks/b']), ToolIssue);
  assert.throws(() => scheduler.assertAvailable(['page/blocks/c']), ToolIssue);
  assert.equal(registry.lookup('a'), undefined);
  assert.equal(registry.hasUnobserved(), true);

  returned = false;
  const next = registry.wait([], true, 'any').then((result) => {
    returned = true;
    return result;
  });
  await setImmediate();
  assert.equal(returned, false, '已经观察的 A 不能反复唤醒 any');
  gates.c.resolve();
  const second = await next;
  assert.deepEqual(
    second.agents.map((agent) => agent.result),
    [undefined, undefined, 'result-c'],
  );
  assert.deepEqual(observed, ['a', 'c']);

  returned = false;
  const all = registry.wait([], true).then((result) => {
    returned = true;
    return result;
  });
  await setImmediate();
  assert.equal(returned, false);
  gates.b.resolve();
  assert.deepEqual(
    (await all).agents.map((agent) => agent.result),
    ['result-a', 'result-b', 'result-c'],
  );
  assert.deepEqual(observed, ['a', 'c', 'b']);
  assert.equal(registry.hasUnobserved(), false);
  scheduler.assertAvailable(['page']);
});

test('any 收齐已有 settled 包括恢复结果，查询不消费且空集合立即返回', async () => {
  const { registry } = fixture();
  assert.deepEqual(await registry.wait([], true, 'any'), { agents: [] });
  const observations: string[] = [];
  for (const id of ['a', 'b'])
    registry.restore(job(id), `saved-${id}`, {
      ...persist(),
      observed: async () => {
        observations.push(id);
      },
    });
  assert.equal((await registry.wait(undefined, false, 'any')).agents.length, 2);
  assert.deepEqual(observations, []);
  await assert.rejects(registry.wait(['a', 'unknown'], true, 'any'), ToolIssue);
  assert.deepEqual(observations, []);
  const result = await registry.wait(undefined, true, 'any');
  assert.deepEqual(
    result.agents.map((agent) => agent.result),
    ['saved-a', 'saved-b'],
  );
  assert.deepEqual(observations, ['a', 'b']);
  const repeated = await registry.wait([], true, 'any');
  assert.ok(repeated.agents.every((agent) => agent.status === 'completed'));
  assert.ok(repeated.agents.every((agent) => !Object.hasOwn(agent, 'result')));
  const query = await registry.wait([], false, 'any');
  assert.deepEqual(query, repeated);
  assert.deepEqual(await registry.wait([], true, 'all'), result, 'all 兼容既有完整回执');
  assert.deepEqual(observations, ['a', 'b']);
});

test('any 仅由所选任务唤醒，重复 ID 和并发 wait 共用观察保存', async () => {
  const { registry } = fixture();
  const finish = barrier(),
    observation = barrier();
  let observations = 0;
  await registry.start(
    job('selected'),
    [],
    async () => {
      await finish.promise;
      return 'selected';
    },
    {
      ...persist(),
      observed: async () => {
        observations++;
        await observation.promise;
      },
    },
  );
  let returned = false;
  const first = registry.wait(['selected', 'selected'], true, 'any').then((result) => {
    returned = true;
    return result;
  });
  registry.restore(job('other'), 'other', persist());
  await setImmediate();
  assert.equal(returned, false);
  const second = registry.wait(['selected'], true, 'any');
  finish.resolve();
  await setImmediate();
  assert.equal(observations, 1);
  assert.equal(returned, false, 'any 同样等待观察保存');
  observation.resolve();
  assert.deepEqual(await first, await second);
  assert.equal((await first).agents.length, 1);
  assert.equal(observations, 1);
  assert.equal(registry.hasUnobserved(), true, '未选择的完成结果仍可收取');
  assert.equal((await registry.wait([], true, 'any')).agents[1].result, 'other');
  assert.equal(registry.hasUnobserved(), false);
});

test('any 观察期间其他任务完成，结果留给下一次收取且不提前放入回执', async () => {
  const { registry } = fixture();
  const finishB = barrier(),
    observingA = barrier(),
    saveA = barrier();
  const observed: string[] = [];
  registry.restore(job('a'), 'a', {
    ...persist(),
    observed: async () => {
      observingA.resolve();
      await saveA.promise;
      observed.push('a');
    },
  });
  await registry.start(
    job('b'),
    [],
    async () => {
      await finishB.promise;
      return 'b';
    },
    {
      ...persist(),
      observed: async () => {
        observed.push('b');
      },
    },
  );
  const first = registry.wait([], true, 'any');
  await observingA.promise;
  finishB.resolve();
  await registry.drain();
  saveA.resolve();
  assert.equal((await first).agents[1].status, 'running');
  assert.deepEqual(observed, ['a']);
  assert.equal((await registry.wait([], true, 'any')).agents[1].result, 'b');
  assert.deepEqual(observed, ['a', 'b']);
});

for (const mode of ['all', 'any'] as const) {
  test(`${mode} 等待时取消立即原样上抛，即使 action 尚未退出也不挂起或泄漏监听器`, async () => {
    const { controller, registry } = fixture();
    const finish = barrier();
    await registry.start(
      job('a'),
      [],
      async () => {
        await finish.promise;
        return 'a';
      },
      persist(),
    );
    const baseline = getEventListeners(controller.signal, 'abort').length;
    const waiting = registry.wait([], true, mode);
    const original = new Error('cancel waiting');
    const rejected = assert.rejects(waiting, (error) => error === original);
    controller.abort(original);
    await rejected;
    assert.equal(getEventListeners(controller.signal, 'abort').length, baseline);
    assert.equal(registry.hasActive(), true);
    finish.resolve();
    await registry.drain();
    assert.equal(registry.hasUnobserved(), true);
  });

  test(`${mode} 等待或观察保存被 fatal 唤醒，保留首个异常且不消费未完成任务`, async () => {
    for (const observing of [false, true]) {
      const { registry } = fixture();
      const finish = barrier(),
        entered = barrier();
      if (observing)
        registry.restore(job('a'), 'a', {
          ...persist(),
          observed: async () => {
            entered.resolve();
            await finish.promise;
          },
        });
      else
        await registry.start(
          job('a'),
          [],
          async () => {
            entered.resolve();
            await finish.promise;
            return 'a';
          },
          persist(),
        );
      const waiting = registry.wait([], true, mode);
      await entered.promise;
      const original = new Error('fatal during wait');
      const rejected = assert.rejects(waiting, (error) => error === original);
      registry.rejectFatal(original);
      registry.rejectFatal(new Error('later failure'));
      await rejected;
      assert.equal(registry.hasUnobserved(), true);
      finish.resolve();
      await assert.rejects(registry.drain(), (error) => error === original);
    }
  });
}

test('any 的 action、settled、observed 失败保留原始 fatal', async () => {
  for (const stage of ['action', 'settled', 'observed']) {
    const { registry } = fixture();
    const original = new Error(stage);
    const finish = barrier();
    await registry.start(
      job(stage),
      [],
      async () => {
        await finish.promise;
        if (stage === 'action') throw original;
        return 'result';
      },
      {
        settled: async () => {
          if (stage === 'settled') throw original;
        },
        observed: async () => {
          if (stage === 'observed') throw original;
        },
      },
    );
    const waiting = registry.wait([], true, 'any');
    const rejected = assert.rejects(waiting, (error) => error === original);
    finish.resolve();
    await rejected;
    await assert.rejects(registry.drain(), (error) => error === original);
    assert.equal(registry.hasUnobserved(), true);
  }
});
