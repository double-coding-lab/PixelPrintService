import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { previewDiagnostic } from '../src/functions/d2c/preview/diagnostics';
/** 直接运行可信格式化器，使用明确的测试工作区根。 */
async function formatter() {
  const { formatCompilerDiagnostic } = await import(
    pathToFileURL(path.resolve('preview-template/container/diagnostics.mjs')).href
  );
  return (error: unknown) => formatCompilerDiagnostic(error, '/tmp/work');
}

test('真实Sass未定义变量提供固定分类和行列，诊断省略源码与原始异常', async () => {
  const { boundedSass } = await import(
    pathToFileURL(path.resolve('preview-template/container/sass.mjs')).href
  );
  const format = await formatter();
  try {
    await boundedSass('/tmp/work').transform(
      '.card {\n  height: $private_undefined;\n}',
      '/tmp/work/pages/page/hero.scss',
    );
    assert.fail('Sass应拒绝未定义变量');
  } catch (error) {
    const result = format(error);
    assert.equal(result.code, 'STYLE_UNDEFINED_VARIABLE');
    assert.equal(result.file, 'pages/page/hero.scss');
    assert.equal(result.line, 2);
    assert.ok(result.column > 0);
    assert.match(previewDiagnostic(result)!.message, /未定义变量/);
    assert.doesNotMatch(JSON.stringify(previewDiagnostic(result)), /private|\.card|\/tmp\/work/);
  }
});
