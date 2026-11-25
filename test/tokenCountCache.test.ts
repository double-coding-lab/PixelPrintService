import assert from 'node:assert/strict';
import test from 'node:test';
import { Tiktoken } from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/cl100k_base';
import { estimateTokens } from '../src/functions/d2c/run/agent/tokens';

/** 独立保留优化前算法，检验 256 字符切块与最终取整语义。 */
test('cached estimates exactly match the original algorithm including Unicode boundaries', () => {
  const encoder = new Tiktoken(ranks);
  const values: unknown[] = [
    '',
    undefined,
    null,
    false,
    0,
    '中文 + TypeScript const result = 42;',
    'a'.repeat(255) + '😀'.repeat(40),
    '\ud800',
    '\udfff',
    '�',
    'x'.repeat(256) + '\ud800' + 'y'.repeat(512),
    { role: 'tool', content: 'layout'.repeat(1000), items: [null, 1, '图像'] },
    Array.from({ length: 800 }, (_, i) => `block-${i}: 页面布局 ${i * 7}\n`).join(''),
  ];
  for (const value of values) {
    const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
    let tokens = 0;
    for (let offset = 0; offset < text.length; offset += 256)
      tokens += encoder.encode(text.slice(offset, offset + 256), [], []).length;
    const expected = Math.ceil(tokens * 1.1);
    assert.equal(estimateTokens(value), expected);
    assert.equal(estimateTokens(value), expected);
  }
});

/** 按真实 encode 调用验证完整输入、变化片段复用和有界淘汰，不以耗时阈值制造脆弱测试。 */
test('only digests/counts are reused, changed input is recounted and capacity evicts', (t) => {
  let encodes = 0;
  t.mock.method(Tiktoken.prototype, 'encode', (text: string) => {
    encodes++;
    return Array.from({ length: text.length }, () => 1);
  });
  const first = 'cache-regression-distinct-'.padEnd(256, 'a');
  const second = 'second-chunk-distinct-'.padEnd(256, 'b');
  assert.equal(estimateTokens(first + second), Math.ceil(512 * 1.1));
  assert.equal(encodes, 2);
  estimateTokens(first + second);
  assert.equal(encodes, 2);
  estimateTokens(first + 'changed-chunk-unique');
  assert.equal(encodes, 3);
  for (let i = 0; i < 8200; i++) estimateTokens(`bounded-cache-entry-${i}`);
  const before = encodes;
  estimateTokens(first);
  assert.equal(encodes, before + 1);
  // Distinct lone surrogate strings must not alias each other or U+FFFD.
  const privatePrefix = 'surrogate-identity-probe-';
  for (const suffix of ['\ud800', '\ud801', '�']) estimateTokens(privatePrefix + suffix);
  assert.equal(encodes, before + 4);
});
