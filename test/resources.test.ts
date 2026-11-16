import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

/** 更新策略在临时上游资源上验证，不修改已分发 Skill。 */
test('resource updates retain public presets and discard unsupported integration examples', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pixelprint-resources-'));
  try {
    await mkdir(path.join(root, 'templates/adapter-presets'), { recursive: true });
    await mkdir(path.join(root, 'templates/code-connect'), { recursive: true });
    await mkdir(path.join(root, 'templates/skills/demo'), { recursive: true });
    await writeFile(path.join(root, 'templates/adapter-presets/rn.json'), '{}');
    await writeFile(path.join(root, 'templates/adapter-presets/private.json'), '{}');
    const skill = path.join(root, 'templates/skills/demo/SKILL.md');
    await writeFile(
      skill,
      [
        'import { View } from "@tarojs/components";',
        'import { Private } from "@private/widgets";',
        'https://assets.private.invalid/fonts/Display.woff2',
        'https://assets.private.invalid/image.png',
        'https://github.com/example/demo',
      ].join('\n'),
    );
    const { sanitizeResources } = await import('../scripts/sanitize-resources.mjs');
    await sanitizeResources(root);
    const result = await readFile(skill, 'utf8');
    assert.match(result, /@tarojs\/components/);
    assert.doesNotMatch(result, /@private|private\.invalid/);
    assert.match(result, /\/fonts\/Display\.woff2/);
    assert.match(result, /https:\/\/assets\.example\.com\//);
    assert.match(result, /https:\/\/github\.com\/example\/demo/);
    assert.deepEqual(await readdir(path.join(root, 'templates/adapter-presets')), ['rn.json']);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(root, 'templates/code-connect/mappings.json'), 'utf8')),
      { components: [] },
    );
    await sanitizeResources(root);
    assert.equal(await readFile(skill, 'utf8'), result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
