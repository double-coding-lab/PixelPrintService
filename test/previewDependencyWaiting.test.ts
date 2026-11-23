import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPreviewCache } from '../src/functions/d2c/preview/cache';
import { createPreviewService } from '../src/functions/d2c/preview/service';
import { PreviewBuildError } from '../src/functions/d2c/preview/runner';
import {
  missingPreviewFile,
  unchangedMissingPreviewFile,
  type PreviewSnapshotFile,
} from '../src/functions/d2c/preview/session';
import type { PreviewDiagnostic } from '../src/functions/d2c/preview/diagnostics';
import { messageFixture } from './helpers/messages';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const entry = 'src/page/index.tsx';
const signal = () => new AbortController().signal;
const missing = (module = './index.scss', file = entry): PreviewDiagnostic => ({
  code: 'MODULE_NOT_FOUND',
  file,
  module,
});

/** 离线事务存储与显式编译替身：验证实际入队/执行次数，不连接数据库或对象存储。 */
async function fixture(t: test.TestContext) {
  const f = await messageFixture();
  const fileModel = f.mysql.models.D2cFile;
  const findFiles = fileModel.findAll.bind(fileModel);
  fileModel.findAll = ((options: Parameters<typeof fileModel.findAll>[0] = {}) =>
    findFiles(
      options.transaction && !options.lock ? { ...options, transaction: undefined } : options,
    )) as typeof fileModel.findAll;
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'preview-dependency-wait-'));
  const calls: Parameters<Parameters<typeof createPreviewService>[1]['run']>[0][] = [];
  let diagnostic: PreviewDiagnostic | undefined;
  let wait: (() => Promise<void>) | undefined;
  const instances: ReturnType<typeof createPreviewService>[] = [];
  function instance() {
    const service = createPreviewService(f.mysql, {
      cache: createPreviewCache(root),
      readLimits: () => f.runtime.d2c.limits,
      binary: () => ({
        async uploadFile() {
          assert.fail('no external upload');
        },
        async downloadFile() {
          return Buffer.from('image');
        },
      }),
      run: async (input) => {
        calls.push(input);
        await wait?.();
        if (diagnostic) throw new PreviewBuildError('PREVIEW_BUILD_FAILED', diagnostic);
        return [{ path: 'index.html', mimeType: 'text/html', content: Buffer.from('<main/>') }];
      },
    });
    instances.push(service);
    return service;
  }
  function save(content: string, filePath = entry) {
    const values = {
      sessionId: f.id,
      path: filePath,
      pathHash: hash(filePath),
      kind: 'source',
      content,
      size: Buffer.byteLength(content),
      sha256: hash(content),
      objectLocator: null,
    };
    const prior = f.tables.D2cFile.find((file) => file.path === filePath);
    if (prior) Object.assign(prior, values);
    else f.tables.D2cFile.push(values);
    f.tables.D2cSession[0].fileRevision++;
  }
  const run = { runId: 'generating', sessionId: f.id, status: 'running' };
  f.tables.D2cRun.push(run);
  f.tables.D2cSession[0].activeRunId = run.runId;
  const service = instance();
  t.after(async () => {
    for (const item of instances) await item.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    ...f,
    run,
    service,
    instance,
    save,
    calls,
    hold(value?: () => Promise<void>) {
      wait = value;
    },
    fail(value?: PreviewDiagnostic) {
      diagnostic = value;
    },
    async failed(module = './index.scss', file = entry) {
      diagnostic = missing(module, file);
      const result = await service.createSession('employee-a', f.id, entry);
      await service.work(signal());
      return result.current!;
    },
  };
}

test('34 edits to existing imported blocks reuse one missing-SCSS failure across restart, then retry when saved', async (t) => {
  const f = await fixture(t);
  f.save(
    "import './index.scss'; import { value } from '../generated/block-0'; export default () => <div>{value}</div>",
  );
  for (let i = 0; i < 4; i++) f.save('export const value = -1', `src/generated/block-${i}.ts`);
  const first = await f.failed();
  const original = structuredClone(f.tables.D2cPreview[0].buildManifest);
  let service = f.service;
  for (let i = 0; i < 34; i++) {
    f.save(`export const value = ${i}`, `src/generated/block-${i % 4}.ts`);
    if (i === 17) {
      await service.close();
      service = f.instance();
    }
    for (const state of [
      await service.existingSession('employee-a', f.id, entry),
      await service.createSession('employee-a', f.id, entry),
    ]) {
      assert.equal(state.current!.previewId, first.previewId);
      assert.equal(state.current!.status, 'waiting_files');
      assert.equal(state.current!.error, null);
      assert.equal(
        'waitingForFile' in state.current! && state.current.waitingForFile,
        'src/page/index.scss',
      );
      assert.equal(
        state.current!.validatedFileRevision,
        first.fileRevision,
        'uncompiled revisions are not claimed as validated',
      );
    }
    assert.equal(await service.work(signal()), false);
  }
  assert.equal(f.calls.length, 1);
  assert.equal(f.tables.D2cPreview.length, 1);
  assert.deepEqual(
    f.tables.D2cPreview[0].buildManifest,
    original,
    'preserve failed immutable evidence',
  );
  assert.equal(f.tables.D2cPreview[0].error.diagnostic.code, 'MODULE_NOT_FOUND');
  f.save('div { color: red; }', 'src/page/index.scss');
  f.fail();
  const attempts = await Promise.all(
    Array.from({ length: 3 }, () => service.createSession('employee-a', f.id, entry)),
  );
  assert.equal(new Set(attempts.map((state) => state.current!.previewId)).size, 1);
  assert.equal(attempts[0].current!.status, 'queued');
  assert.notEqual(attempts[0].current!.inputHash, first.inputHash);
  await service.work(signal());
  assert.equal((await service.existingSession('employee-a', f.id, entry)).current!.status, 'ready');
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1].files.some((file) => file.path === 'src/page/index.scss'));
});

test('24 edits to an existing sibling preserve the transitive travel-kit failure until its directory entry arrives', async (t) => {
  const f = await fixture(t);
  const bridge = 'src/page/blocks/index.ts';
  f.save("import './blocks'; import { value } from './existing'; export default value");
  f.save("export { default } from './travel-kit'", bridge);
  f.save('export const value = 0', 'src/page/existing.ts');
  const first = await f.failed('./travel-kit', bridge);
  for (let i = 1; i <= 24; i++) {
    f.save(`export const value = ${i}`, 'src/page/existing.ts');
    const state = await f.service.createSession('employee-a', f.id, entry);
    assert.equal(state.current!.previewId, first.previewId);
    assert.equal(state.current!.status, 'waiting_files');
    assert.equal(state.current!.validatedFileRevision, first.fileRevision);
    assert.equal(await f.service.work(signal()), false);
  }
  assert.equal(f.calls.length, 1);
  f.save('export default 1', 'src/page/blocks/travel-kit/index.tsx');
  f.fail();
  assert.equal(
    (await f.service.createSession('employee-a', f.id, entry)).current!.status,
    'queued',
  );
  await f.service.work(signal());
  assert.equal(f.calls.length, 2);
  assert.equal(
    (await f.service.existingSession('employee-a', f.id, entry)).current!.status,
    'ready',
  );
});

test('24 coupon JSX and SCSS edits wait for travel-kit, then compile the latest files once', async (t) => {
  const f = await fixture(t);
  const coupon = 'src/page/blocks/coupon-rush/index.tsx';
  const style = 'src/page/blocks/coupon-rush/index.scss';
  f.save(
    "import Coupon from './blocks/coupon-rush'; import Travel from './blocks/travel-kit'; export default () => <><Coupon/><Travel/></>",
  );
  f.save("import './index.scss'; export default () => <div className='coupon'>0</div>", coupon);
  f.save('.coupon { color: red; }', style);
  const first = await f.failed('./blocks/travel-kit');
  const evidence = structuredClone(f.tables.D2cPreview[0].buildManifest);
  for (let i = 1; i <= 24; i++) {
    f.save(
      `import './index.scss'; export default () => <div className='coupon'>${i}</div>`,
      coupon,
    );
    f.save(`.coupon { color: red; padding: ${i}px; .label { font-size: 12px; } }`, style);
    for (const state of [
      await f.service.existingSession('employee-a', f.id, entry),
      await f.service.createSession('employee-a', f.id, entry),
    ]) {
      assert.equal(state.current!.previewId, first.previewId);
      assert.equal(state.current!.status, 'waiting_files');
      assert.equal(state.current!.validatedFileRevision, first.fileRevision);
    }
    assert.equal(await f.service.work(signal()), false);
  }
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.tables.D2cPreview[0].buildManifest, evidence);
  f.save('export default () => <div/>', 'src/page/blocks/travel-kit/index.tsx');
  f.fail();
  await f.service.createSession('employee-a', f.id, entry);
  await f.service.work(signal());
  assert.equal(f.calls.length, 2);
  assert.match(
    f.calls[1].files.find((file) => file.path === style)!.content.toString(),
    /padding: 24px/,
  );
  assert.equal(
    (await f.service.existingSession('employee-a', f.id, entry)).current!.status,
    'ready',
  );
});

test('waiting defers uncompiled style faults, then exposes the real failure after the known gap is saved', async (t) => {
  const f = await fixture(t);
  f.save("import './index.scss'; import './coupon.scss'");
  f.save('.coupon { color: red; }', 'src/page/coupon.scss');
  await f.failed();
  f.save('.coupon { color: $undefined; }', 'src/page/coupon.scss');
  assert.equal(
    (await f.service.createSession('employee-a', f.id, entry)).current!.status,
    'waiting_files',
  );
  assert.equal(f.calls.length, 1);
  f.save('div {}', 'src/page/index.scss');
  f.fail({ code: 'STYLE_UNDEFINED_VARIABLE', file: 'src/page/coupon.scss' });
  await f.service.createSession('employee-a', f.id, entry);
  await f.service.work(signal());
  assert.equal(f.calls.length, 2);
  assert.equal(
    (await f.service.existingSession('employee-a', f.id, entry)).current!.error!.code,
    'STYLE_UNDEFINED_VARIABLE',
  );
});

test('changing an existing sibling import or syntax exposes the next real compiler error', async (t) => {
  for (const content of [
    "import './new-dependency'; export const value = 2",
    'export const value = ;',
    'export const value = import(path)',
    'export const value = import.meta.glob("./*.tsx")',
  ])
    await t.test(content, async (t) => {
      const f = await fixture(t);
      f.save("import './index.scss'; import { value } from './existing'; export default value");
      f.save('export const value = 1', 'src/page/existing.ts');
      const first = await f.failed();
      f.save(content, 'src/page/existing.ts');
      const next = await f.service.createSession('employee-a', f.id, entry);
      assert.notEqual(next.current!.previewId, first.previewId);
      assert.equal(next.current!.status, 'queued');
      f.fail({ code: 'SYNTAX_ERROR', file: 'src/page/existing.ts', line: 1 });
      await f.service.work(signal());
      assert.equal(
        (await f.service.existingSession('employee-a', f.id, entry)).current!.error!.code,
        'SYNTAX_ERROR',
      );
      assert.equal(f.calls.length, 2);
    });
});

test('worker rechecks queued snapshots after an in-flight build learns a missing dependency', async (t) => {
  const f = await fixture(t);
  f.save("import './index.scss'; import '../other'");
  f.save("import './other.scss'; export const x = 0", 'src/other.ts');
  f.save('.coupon { color: red; }', 'src/other.scss');
  f.fail(missing());
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.hold(async () => {
    entered();
    await gate;
  });
  await f.service.createSession('employee-a', f.id, entry);
  const working = f.service.work(signal());
  await started;
  try {
    f.save("import './other.scss'; export const x = 1", 'src/other.ts');
    f.save('.coupon { color: blue; }', 'src/other.scss');
    assert.equal(
      (await f.service.createSession('employee-a', f.id, entry)).current!.status,
      'queued',
    );
  } finally {
    release();
  }
  await working;
  f.hold();
  assert.equal(
    await f.service.work(signal()),
    true,
    'queued row settles with the real existing diagnostic',
  );
  assert.equal(f.calls.length, 1, 'compiler is not called again for the known missing dependency');
  assert.equal(
    (await f.service.existingSession('employee-a', f.id, entry)).current!.status,
    'waiting_files',
  );
  f.save('div {}', 'src/page/index.scss');
  f.fail();
  await f.service.createSession('employee-a', f.id, entry);
  await f.service.work(signal());
  assert.equal(f.calls.length, 2);
});

test('worker compiles a queued change to the import chain instead of inheriting an old missing-file error', async (t) => {
  const f = await fixture(t);
  f.save("import './index.scss'; import '../other'");
  f.save('export const value = 0', 'src/other.ts');
  f.fail(missing());
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.hold(async () => {
    entered();
    await gate;
  });
  await f.service.createSession('employee-a', f.id, entry);
  const working = f.service.work(signal());
  await started;
  try {
    f.save("import './new'; export const value = 1", 'src/other.ts');
    await f.service.createSession('employee-a', f.id, entry);
  } finally {
    release();
  }
  await working;
  f.hold();
  f.fail({ code: 'SYNTAX_ERROR', file: 'src/other.ts' });
  await f.service.work(signal());
  assert.equal(f.calls.length, 2);
  assert.equal(
    (await f.service.existingSession('employee-a', f.id, entry)).current!.error!.code,
    'SYNTAX_ERROR',
  );
});

test('hero, coupon and child SCSS wait independently; each new dependency resumes automatically', async (t) => {
  const f = await fixture(t);
  f.save(
    "import Hero from './blocks/hero'; import Coupon from './blocks/coupon-rush'; export default Hero;",
  );
  const stages = [
    { module: './blocks/hero', file: entry, path: 'src/page/blocks/hero.tsx', count: 19 },
    {
      module: './blocks/coupon-rush',
      file: entry,
      path: 'src/page/blocks/coupon-rush/index.tsx',
      count: 10,
    },
    {
      module: './index.scss',
      file: 'src/page/blocks/coupon-rush/index.tsx',
      path: 'src/page/blocks/coupon-rush/index.scss',
      count: 1,
    },
  ];
  for (const [stage, item] of stages.entries()) {
    const failed = await f.failed(item.module, item.file);
    for (let i = 0; i < item.count; i++) {
      f.save(`export const x = ${i}`, `src/unrelated/stage-${stage}.ts`);
      assert.equal(
        (await f.service.createSession('employee-a', f.id, entry)).current!.previewId,
        failed.previewId,
      );
      assert.equal(await f.service.work(signal()), false);
    }
    f.save(
      stage === 1
        ? "import './index.scss'; export default () => <div/>"
        : 'export default () => <div/>',
      item.path,
    );
    const next = await f.service.createSession('employee-a', f.id, entry);
    assert.equal(next.current!.status, 'queued');
    assert.notEqual(next.current!.previewId, failed.previewId);
  }
  f.fail();
  await f.service.work(signal());
  assert.equal(f.calls.length, 4);
  assert.equal(
    (await f.service.existingSession('employee-a', f.id, entry)).current!.status,
    'ready',
  );
});

test('run completion and stopping expose persisted failure even after unrelated revisions and restart', async (t) => {
  const f = await fixture(t);
  f.save("import './index.scss'");
  const first = await f.failed();
  f.save('export const x = 1', 'src/other.ts');
  const restarted = f.instance();
  for (const status of [
    'succeeded',
    'failed',
    'cancelled',
    'interrupted',
    'paused',
    'waiting_input',
    'stopping',
  ]) {
    f.run.status = status;
    const state = await restarted.createSession('employee-a', f.id, entry);
    assert.equal(state.current!.previewId, first.previewId);
    assert.equal(state.current!.status, 'failed', status);
    assert.equal(state.current!.error!.code, 'MODULE_NOT_FOUND');
  }
  f.run.status = 'running';
  f.tables.D2cSession[0].activeRunId = null;
  assert.equal(
    (await restarted.existingSession('employee-a', f.id, entry)).current!.status,
    'failed',
  );
  assert.equal(f.calls.length, 1);
});

test('changed original source is recompiled and a new syntax error is never hidden by an older dependency failure', async (t) => {
  const f = await fixture(t);
  f.save("import './index.scss'");
  f.save('export const helper = 1', 'src/helper.ts');
  await f.failed();
  f.save('export const helper = ;', 'src/helper.ts');
  const next = await f.service.createSession('employee-a', f.id, entry);
  assert.equal(next.current!.status, 'queued');
  f.fail({ code: 'SYNTAX_ERROR', file: 'src/helper.ts', line: 1 });
  await f.service.work(signal());
  assert.equal(
    (await f.service.existingSession('employee-a', f.id, entry)).current!.error!.code,
    'SYNTAX_ERROR',
  );
  f.save('export const other = 2', 'src/other.ts');
  assert.equal(
    (await f.service.createSession('employee-a', f.id, entry)).current!.status,
    'queued',
  );
  assert.equal(f.calls.length, 2);
});

test('removing the import resumes compilation and waiting evidence cannot cross sessions', async (t) => {
  const f = await fixture(t);
  f.save("import './index.scss'");
  await f.failed();
  const other = await f.sessions.create('employee-a', 'workspace-a', {
    name: 'other',
    target: 'h5',
  });
  f.tables.D2cFile.push({ ...f.tables.D2cFile[0], sessionId: other.sessionId });
  assert.equal(
    (await f.service.createSession('employee-a', other.sessionId!, entry)).current!.status,
    'queued',
  );
  f.save('export default () => <div/>');
  assert.equal(
    (await f.service.createSession('employee-a', f.id, entry)).current!.status,
    'queued',
  );
  f.fail();
  while (await f.service.work(signal())) {
    /* drain both isolated session jobs */
  }
  assert.equal(
    (await f.service.existingSession('employee-a', f.id, entry)).current!.status,
    'ready',
  );
  assert.equal(f.calls.length, 3);
});

test('waiting evidence is isolated by entry, target, runtime, config revision/hash and resources', async (t) => {
  const changes = [
    [
      'config revision',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.tables.D2cWorkspace[0].configRevision++;
      },
    ],
    [
      'config hash',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.tables.D2cWorkspace[0].configRevision++;
        f.tables.D2cWorkspace[0].configJson.h5.unit.outputBase = 375;
      },
    ],
    [
      'resource revision',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.tables.D2cWorkspace[0].activeResourceRevisionId = 'resource-new';
      },
    ],
    [
      'runtime revision',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.tables.D2cPreview[0].runtimeRevision = 'old-template';
      },
    ],
    [
      'target',
      (f: Awaited<ReturnType<typeof fixture>>) => {
        f.tables.D2cSession[0].target = 'rn';
      },
    ],
  ] as const;
  for (const [name, change] of changes)
    await t.test(name, async (t) => {
      const f = await fixture(t);
      f.save("import './index.scss'");
      const first = await f.failed();
      change(f);
      f.save('export const x = 1', 'src/other.ts');
      const next = await f.service.createSession('employee-a', f.id, entry);
      assert.equal(next.current!.status, 'queued');
      assert.notEqual(next.current!.previewId, first.previewId);
    });
  await t.test('entry and authorization', async (t) => {
    const f = await fixture(t);
    f.save("import './index.scss'");
    await f.failed();
    const other = 'src/other/index.tsx';
    f.save("import './index.scss'", other);
    assert.equal(
      (await f.service.createSession('employee-a', f.id, other)).current!.status,
      'queued',
    );
    await assert.rejects(f.service.createSession('employee-b', f.id, entry));
  });
});

test('packages, invalid paths, existing-file resolution failures and real errors keep failure semantics', async (t) => {
  const diagnostics: PreviewDiagnostic[] = [
    missing('missing-package'),
    missing('@scope/package/style.scss'),
    missing('../outside.scss'),
    missing('./../../../outside.scss'),
    missing('./node_modules/missing'),
    missing('./config/missing'),
    missing('./vite.config.ts'),
    missing('./missing.txt'),
    missing('./nested\\bad.scss'),
    missing('./index.tsx'),
    { code: 'MODULE_NOT_FOUND', module: './index.scss' },
    { code: 'SYNTAX_ERROR', file: entry },
    { code: 'MODULE_NOT_ALLOWED', file: entry },
    { code: 'STYLE_UNDEFINED_VARIABLE', file: entry },
  ];
  for (const diagnostic of diagnostics)
    await t.test(JSON.stringify(diagnostic), async (t) => {
      const f = await fixture(t);
      f.save("import './index.scss'");
      f.fail(diagnostic);
      await f.service.createSession('employee-a', f.id, entry);
      await f.service.work(signal());
      assert.equal(
        (await f.service.existingSession('employee-a', f.id, entry)).current!.status,
        'failed',
      );
      f.save('export const x = 1', 'src/other.ts');
      assert.equal(
        (await f.service.createSession('employee-a', f.id, entry)).current!.status,
        'queued',
      );
    });
});

test('explicit retry remains available and no run means missing dependencies remain actual failures', async (t) => {
  const f = await fixture(t);
  f.save("import './index.scss'");
  const first = await f.failed();
  assert.equal(
    (await f.service.createSession('employee-a', f.id, entry, true)).current!.status,
    'queued',
  );
  await f.service.work(signal());
  assert.equal(f.calls.length, 2);
  f.save('export const other = 1', 'src/other.ts');
  assert.equal(
    (await f.service.createSession('employee-a', f.id, entry, true)).current!.status,
    'queued',
  );
  await f.service.work(signal());
  assert.equal(f.calls.length, 3, 'explicit retry of a new revision bypasses worker deduplication');
  f.tables.D2cSession[0].activeRunId = null;
  assert.equal(
    (await f.service.existingSession('employee-a', f.id, entry)).current!.error!.module,
    './index.scss',
  );
  assert.equal(f.tables.D2cPreview[0].previewId, first.previewId);
});

/** 即使其他源码可解析，删除、二进制与解析别名仍不能沿用旧等待证据。 */
test('snapshot comparison invalidates deletions, binary changes and case aliases without retaining a cache', () => {
  const source = (filePath: string, content = ''): PreviewSnapshotFile => ({
    path: filePath,
    kind: 'source',
    content,
    objectLocator: null,
    size: Buffer.byteLength(content),
    sha256: hash(content),
  });
  const prior = [source(entry, "import './index.scss'")];
  const added = source('src/other.ts');
  assert.equal(
    unchangedMissingPreviewFile(missing(), prior, [...prior, added]),
    'src/page/index.scss',
  );
  assert.equal(
    unchangedMissingPreviewFile(missing(), prior, [source(entry, 'changed')]),
    undefined,
  );
  assert.equal(unchangedMissingPreviewFile(missing(), prior, [added]), undefined);
  assert.equal(
    unchangedMissingPreviewFile(missing(), prior, [...prior, source('SRC/page/index.tsx')]),
    undefined,
  );
  assert.equal(
    unchangedMissingPreviewFile(missing(), prior, [...prior, { ...added, kind: 'asset' }]),
    undefined,
  );
  assert.equal(
    unchangedMissingPreviewFile(missing(), prior, [...prior, source('src/page/index.scss')]),
    undefined,
  );
  assert.equal(
    missingPreviewFile(missing('./blocks/hero'), [
      ...prior,
      source('src/page/blocks/hero/index.tsx'),
    ]),
    undefined,
  );
  assert.equal(missingPreviewFile(missing('src/page/index.scss'), prior), 'src/page/index.scss');
  const asset = { ...source('assets/image.png', 'image'), kind: 'asset' as const };
  assert.equal(
    unchangedMissingPreviewFile(
      missing(),
      [...prior, asset],
      [...prior, { ...asset, sha256: hash('changed') }],
    ),
    undefined,
  );
  assert.equal(unchangedMissingPreviewFile(missing(), [...prior, asset], prior), undefined);
});

test('dependency graph uses real transitive imports, aliases and resolution candidates conservatively', () => {
  const source = (path: string, content: string): PreviewSnapshotFile => ({
    path,
    kind: 'source',
    content,
    objectLocator: null,
    size: Buffer.byteLength(content),
    sha256: hash(content),
  });
  const bridge = 'src/page/bridge.ts';
  const sibling = 'src/page/existing.ts';
  const diagnostic = missing('./travel-kit', bridge);
  const prior = [
    source(entry, "import '@/page/bridge'; import './existing'; export default 1"),
    source(bridge, "export { default } from './travel-kit'"),
    source(sibling, 'export const value = 1'),
    source('src/style.scss', '.card { color: red; }'),
    source('src/data.json', '{"value":1}'),
  ];
  const change = (name: string, content: string) =>
    prior.map((file) => (file.path === name ? source(name, content) : file));
  assert.equal(
    unchangedMissingPreviewFile(
      diagnostic,
      prior,
      change(sibling, 'export const value = 2'),
      entry,
    ),
    'src/page/travel-kit',
  );
  const invalidated = [
    change(bridge, "export { default } from './travel-kit'; export const value = 1"),
    change(entry, "import './existing'; export default 1"),
    change(sibling, "import './new'; export const value = 1"),
    change(sibling, 'export const value = ;'),
    change(sibling, 'export const value = require(path)'),
    change(sibling, 'const load = require; export const value = load(path)'),
    change(sibling, 'export const value = import.meta.glob("./*.tsx")'),
    change('src/style.scss', "@use './new'; .card { color: red; }"),
    change('src/style.scss', "@import './new';"),
    change('src/style.scss', "@forward './new';"),
    change('src/style.scss', 'a { background: url($dynamic); }'),
    change('src/style.scss', '@use'),
    change('src/data.json', '{"value":}'),
    prior.filter((file) => file.path !== sibling),
    [...prior, source('src/page/travel-kit/index.tsx', 'export default 1')],
    [...prior, source('src/page/bridge/index.tsx', 'export default 1')],
    [...prior, source('src/page/bridge.web.tsx', 'export default 1')],
    [...prior, source('src/new.ts', 'export const value = ;')],
  ];
  for (const snapshot of invalidated)
    assert.equal(unchangedMissingPreviewFile(diagnostic, prior, snapshot, entry), undefined);

  const unrelated = [source(entry, 'export default 1'), source(bridge, "import './travel-kit'")];
  assert.equal(
    unchangedMissingPreviewFile(diagnostic, unrelated, unrelated, entry),
    undefined,
    'an unreachable importer is not evidence for this entry',
  );
  for (const content of [
    "// import './travel-kit'\nexport default 1",
    'const text = "import \'./travel-kit\'"',
  ]) {
    const files = [source(entry, content)];
    assert.equal(
      unchangedMissingPreviewFile(missing('./travel-kit'), files, files, entry),
      undefined,
      'comments and strings are not imports',
    );
  }
  for (const content of ["import('./travel-kit')", "require('./travel-kit')"]) {
    const files = [source(entry, content), source(sibling, 'export const value = 1')];
    assert.equal(
      unchangedMissingPreviewFile(
        missing('./travel-kit'),
        files,
        [files[0], source(sibling, 'export const value = 2')],
        entry,
      ),
      'src/page/travel-kit',
    );
  }
  const jsImport = [
    source(entry, "import './travel-kit.js'"),
    source('src/page/travel-kit.ts', 'export default 1'),
  ];
  assert.equal(
    missingPreviewFile(missing('./travel-kit.js'), jsImport),
    undefined,
    'Vite may substitute a TS source for a JS import',
  );
});
