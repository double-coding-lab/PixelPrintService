import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownOutline } from '../src/functions/d2c/run/agent/markdownOutline';

test('目录忽略前置元数据与代码块内假标题，章节位置精确保留嵌套与Unicode正文', () => {
  const text =
    '---\r\nname: example\r\n# YAML注释\r\n---\r\n开头🙂\r\n# 总览\r\n总览正文\r\n## 实现\r\n实现约束\r\n```md\r\n## 代码里的假标题\r\n```\r\n### 子步骤\r\n子步骤正文\r\n## 验收\r\n必须验收\r\n';
  const outline = markdownOutline(text, 0, 64);
  assert.deepEqual(
    outline.sections.map((s) => s.heading),
    ['文档开头', '总览', '实现', '子步骤', '验收'],
  );
  const section = outline.sections.find((s) => s.heading === '实现')!;
  assert.equal(section.offset, text.indexOf('## 实现'));
  assert.equal(section.end, text.indexOf('## 验收'));
  assert.ok(text.slice(section.offset, section.end).includes('子步骤正文'));
  assert.equal(outline.sections[0].offset, 0);
  assert.equal(outline.sections[0].end, text.indexOf('# 总览'));
  assert.equal(outline.sections.at(-1)?.end, text.length);
  assert.equal(outline.nextOffset, null);
});

test('目录按条目分页，长标题仅截断定位标签，原始正文及字符区间保持可回读', () => {
  const text = '# ' + '约束'.repeat(200) + '\n正文\n## B\n内容\n~~~js\n# 非标题\n~~~\n## C\n末尾';
  const first = markdownOutline(text, 0, 1),
    second = markdownOutline(text, first.nextOffset!, 1),
    last = markdownOutline(text, second.nextOffset!, 1);
  assert.equal(first.totalSections, 3);
  assert.equal(first.sections[0].labelTruncated, true);
  assert.equal(first.sections[0].heading.length, 160);
  assert.equal(first.sections[0].end, text.length);
  assert.equal(second.sections[0].offset, text.indexOf('## B'));
  assert.equal(last.sections[0].offset, text.indexOf('## C'));
  assert.equal(last.nextOffset, null);
  assert.equal(
    markdownOutline('无标题的完整原文', 0, 32).sections[0].end,
    '无标题的完整原文'.length,
  );
});
