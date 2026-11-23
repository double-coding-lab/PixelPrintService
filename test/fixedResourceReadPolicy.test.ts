import './helpers/projectFixture';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  readTemplateResources,
  validateResourceBundle,
} from '../src/functions/d2c/workspace/resources';
import {
  createFixedResourceBackend,
  resourcePrefix,
} from '../src/functions/d2c/run/agent/resources';
import { createDeepToolFeedback } from '../src/functions/d2c/run/agent/feedback';
import {
  fixedResourceReadGuidance,
  uiResourceReadInstructions,
} from '../src/functions/d2c/run/agent/readPolicy';
import { readToolFeedback } from '../src/functions/d2c/run/toolFeedback';
import { subagentInstructions, type SubagentRole } from '../src/functions/d2c/run/subagent';
import { createSubagentTools } from '../src/functions/d2c/run/agent/subagentTools';
import type { GenerationTools } from '../src/functions/d2c/run/types';

// 公仓没有额外的平台Skill目录；用空目录收集真实发布模板，不借用内仓资源。
const originalBundle = (async () => {
  const platformSkills = await mkdtemp(path.join(tmpdir(), 'resource-policy-skills-'));
  try {
    return await readTemplateResources(path.resolve('pixelprint'), await realpath(platformSkills));
  } finally {
    await rm(platformSkills, { recursive: true, force: true });
  }
})();
const secret = 'PRIVATE_CHECKER_IMPLEMENTATION';
const scriptPaths = ['pp-d2c', 'pp-d2c-rn'].flatMap((skill) => [
  `templates/skills/${skill}/bin/check-rules.mjs`,
  `templates/skills/${skill}/bin/lib/loadProduct.mjs`,
  `templates/skills/${skill}/bin/rules/R01-fixed-position.mjs`,
]);
const scriptMap = 'templates/skills/pp-d2c/bin/check-rules.mjs.map';
const allowed = {
  'templates/skills/pp-d2c/bin/README.md': 'TOOL_DOCUMENT: checker usage',
  'templates/skills/pp-d2c/bin/options.json': '{"mode":"block"}',
  'templates/skills/pp-d2c/templates/lib/Card.tsx': 'TEMPLATE_SOURCE: export const Card = 1;',
  'templates/skills/pp-d2c/references/helpers/demo.ts': 'REFERENCE_SOURCE: example',
};

/** 修改实际固定包的已知实现字节，离线验证各条读取通道，不执行脚本或访问网络。 */
async function fixture(role?: SubagentRole, target: 'h5' | 'rn' = 'h5') {
  const original = await originalBundle;
  const files = structuredClone(original.files);
  for (const script of scriptPaths) {
    const file = files.find((file) => file.path === script);
    assert.ok(file, `真实bundle必须包含${script}`);
    file.content = Buffer.from(secret.repeat(100)).toString('base64');
  }
  for (const [name, content] of Object.entries({ ...allowed, [scriptMap]: secret }))
    files.push({ path: name, content: Buffer.from(content).toString('base64') });
  const bundle = validateResourceBundle({ format: 1, files });
  const controller = new AbortController();
  let calls = 0;
  const input = {
    bundle,
    bundleHash: bundle.hash,
    target,
    role,
    signal: controller.signal,
    assertLease: async () => {
      calls++;
    },
  };
  return { input, controller, calls: () => calls, resources: createFixedResourceBackend(input) };
}

function assertGuidance(content: unknown) {
  assert.equal(typeof content, 'string');
  assert.match(content as string, /rule-hits\.json/);
  assert.match(content as string, /交回父 Agent/);
  assert.doesNotMatch(content as string, new RegExp(secret));
  assert.equal(readToolFeedback(content), undefined, '普通阅读引导不能变成纠错反馈');
}

test('UI直接读取检查器、规则实现及lib仅返回普通引导，H5/RN保持一致', async () => {
  for (const target of ['h5', 'rn'] as const) {
    const { resources, input } = await fixture('ui', target);
    assert.equal(resources.bundleHash, input.bundle.hash);
    for (const script of [...scriptPaths, scriptMap]) {
      const page = JSON.parse(await resources.readText(script));
      assertGuidance(page.content);
      assert.match(page.content, /\/rules\/README\.md/);
      assert.equal(page.totalCharacters, page.content.length);
      assert.equal(page.nextOffset, null);
      assert.equal((await resources.backend.read(resourcePrefix + script)).error, undefined);
      assertGuidance((await resources.backend.read(resourcePrefix + script)).content);
      assertGuidance((await resources.backend.readRaw(script)).data?.content);
      const download = (await resources.backend.downloadFiles!([script]))[0];
      assert.equal(download.error, null);
      assertGuidance(new TextDecoder().decode(download.content!));
    }
  }
});

test('资源前缀、重复分隔符、点段及根内回退别名均不能读到UI受限实现', async () => {
  const { resources } = await fixture('ui');
  for (const alias of [
    scriptPaths[0],
    resourcePrefix + scriptPaths[0],
    '/resources///templates/skills/pp-d2c/bin/./check-rules.mjs',
    'templates//skills/pp-d2c/bin/lib/../check-rules.mjs',
    '/resources/templates/skills/pp-d2c/rules/../bin/check-rules.mjs',
  ]) {
    assertGuidance(JSON.parse(await resources.readText(alias)).content);
    assertGuidance((await resources.backend.readRaw(alias)).data?.content);
    const downloaded = (await resources.backend.downloadFiles!([alias]))[0];
    assertGuidance(new TextDecoder().decode(downloaded.content!));
  }
  for (const invalid of [
    '/resources/../etc/passwd',
    '/etc/passwd',
    'templates/skills/pp-d2c/bin/%63heck-rules.mjs',
    'templates\\skills\\pp-d2c\\bin\\check-rules.mjs',
  ]) {
    await assert.rejects(resources.readText(invalid), /路径无效/);
    await assert.rejects(async () => resources.backend.readRaw(invalid), /路径无效/);
  }
});

test('UI的grep、glob、目录列表及下载不能泄漏固定实现内容或引导反复发现源码', async () => {
  const { resources } = await fixture('ui');
  for (const root of [undefined, '/resources/', '/resources/templates/skills/pp-d2c/bin/']) {
    const search = await resources.backend.grep(secret, root);
    assert.deepEqual(search.matches ?? [], []);
    const glob = await resources.backend.glob('**/*', root);
    assert.ok(
      glob.files?.every(
        (file) => !fixedResourceReadGuidance(file.path.replace(resourcePrefix, ''), 'ui'),
      ),
    );
    assert.doesNotMatch(JSON.stringify([search, glob]), new RegExp(secret));
  }
  const listing = await resources.backend.ls('/resources/templates/skills/pp-d2c/bin/');
  assert.ok(listing.files?.some((file) => file.path.endsWith('README.md')));
  assert.ok(listing.files?.every((file) => !file.path.endsWith('.mjs')));
  const paths = await resources.listFiles();
  assert.ok(paths.includes('/resources/templates/skills/pp-d2c/rules/README.md'));
  for (const script of [...scriptPaths, scriptMap])
    assert.ok(!paths.includes(resourcePrefix + script));
  const values = await resources.backend.downloadFiles!([resourcePrefix + scriptPaths[0]]);
  assert.doesNotMatch(JSON.stringify(values), new RegExp(secret));
  values[0].content![0] = 0;
  assertGuidance((await resources.backend.readRaw(scriptPaths[0])).data?.content);
});

test('规则Markdown、配置、模板及参考源码仍完整可读，不按bin或lib名字粗暴封禁', async () => {
  const { resources, input } = await fixture('ui');
  const readable = [
    'templates/skills/pp-d2c/SKILL.md',
    'templates/skills/pp-d2c/rules/README.md',
    'templates/skills/pp-d2c/rules/R01-fixed-position.md',
    'templates/skills/pp-d2c-rn/rules/RN01-scroll-skeleton.md',
    'templates/pp-d2c.config.json',
    'templates/pp-d2c.rn.config.json',
    'templates/skills/pp-d2c-reskin/reskin-slice.mjs',
    ...Object.keys(allowed),
  ];
  for (const name of readable) {
    const original = input.bundle.files.find((file) => file.path === name)!;
    assert.ok(original);
    const expected = Buffer.from(original.content, 'base64').toString();
    const actual = JSON.parse(await resources.readText(name, 0, 256000));
    assert.equal(actual.content, expected.slice(0, 256000));
    const download = (await resources.backend.downloadFiles!([name]))[0];
    assert.equal(new TextDecoder().decode(download.content!), expected);
  }
  const matches = await resources.backend.grep('TOOL_DOCUMENT', '/resources/');
  assert.equal(matches.matches?.length, 1);
  assert.match(matches.matches![0].path, /bin\/README\.md$/);
});

test('省略role保持旧API，父Agent、review、rule_scan及design保留必要实现排查能力', async () => {
  for (const role of [undefined, 'review', 'rule_scan', 'design'] as const) {
    const { resources } = await fixture(role);
    const page = JSON.parse(await resources.readText(scriptPaths[0], 0, 50));
    assert.equal(page.content, secret.repeat(100).slice(0, 50));
    assert.ok((await resources.listFiles()).includes(resourcePrefix + scriptPaths[0]));
    assert.ok((await resources.backend.grep(secret, '/resources/')).matches?.length);
  }
});

test('重复请求引导不会消耗工具纠错次数、重试次数或阻塞后续规则阅读', async () => {
  const { resources, input } = await fixture('ui');
  const feedback = createDeepToolFeedback(input);
  for (let i = 0; i < 12; i++) {
    const result = await feedback.run('read_file', () => resources.readText(scriptPaths[0]));
    assertGuidance(JSON.parse(result).content);
  }
  const rule = await feedback.run('read_file', () =>
    resources.readText('templates/skills/pp-d2c/rules/README.md'),
  );
  assert.equal(readToolFeedback(rule), undefined);
  assert.doesNotThrow(() => feedback.assertUnblocked());
});

test('UI授权业务源码和具体违规证据继续通过原工具读取，不套用固定资源限制', async () => {
  const values: unknown[][] = [];
  const unexpected = async (): Promise<never> => assert.fail('此测试只允许读取');
  const tools: GenerationTools = {
    list: unexpected,
    write: unexpected,
    remove: unexpected,
    slices: unexpected,
    figma: unexpected,
    rules: unexpected,
    read: async (...args) => {
      values.push(args);
      return 'AUTHORIZED_SOURCE_OR_EVIDENCE';
    },
  };
  const scoped = createSubagentTools(tools, 'ui', ['page/blocks/card/index.tsx']);
  for (const name of [
    'page/blocks/card/index.tsx',
    'page/blocks/card/rule-hits.json',
    '.d2c-cache/file/root.json',
  ])
    assert.equal(await scoped.read(name, false, 0, 200), 'AUTHORIZED_SOURCE_OR_EVIDENCE');
  assert.equal(values.length, 3);
  assert.ok(subagentInstructions('ui').includes(uiResourceReadInstructions));
  for (const role of ['review', 'rule_scan', 'design'] as const)
    assert.ok(!subagentInstructions(role).includes(uiResourceReadInstructions));
});

test('阅读引导保留取消和租约检查，受限内容不能通过失败后的读取获取', async () => {
  const f = await fixture('ui');
  await f.resources.readText(scriptPaths[0]);
  assert.equal(f.calls(), 2);
  f.controller.abort(new Error('OFFLINE_CANCELLED'));
  await assert.rejects(f.resources.readText(scriptPaths[0]), /OFFLINE_CANCELLED/);
  await assert.rejects(
    async () => f.resources.backend.downloadFiles!([scriptPaths[0]]),
    /OFFLINE_CANCELLED/,
  );
  const denied = createFixedResourceBackend({
    ...f.input,
    signal: new AbortController().signal,
    assertLease: async () => {
      throw new Error('OFFLINE_LEASE_DENIED');
    },
  });
  await assert.rejects(denied.readText(scriptPaths[0]), /OFFLINE_LEASE_DENIED/);
});
