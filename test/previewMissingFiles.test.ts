import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { missingPreviewFile, type PreviewSnapshotFile } from '../src/functions/d2c/preview/session';

const entry = 'pages/page/index.tsx';
const snapshot: PreviewSnapshotFile[] = [
  { path: entry, kind: 'source', content: '', objectLocator: null, size: 0, sha256: '' },
];

/** 缺少本地样式才进入等待；依赖包、语法错误和已经保存的文件保留真实错误。 */
test('preview identifies missing generated local files without masking other build errors', () => {
  const diagnostic = { code: 'MODULE_NOT_FOUND' as const, file: entry, module: './index.scss' };
  assert.equal(missingPreviewFile(diagnostic, snapshot), 'pages/page/index.scss');
  assert.equal(
    missingPreviewFile({ ...diagnostic, module: 'pages/page/index.scss' }, snapshot),
    'pages/page/index.scss',
  );
  for (const module of [
    'package-name',
    '@scope/package/style.scss',
    '../outside.scss',
    './../../../outside.scss',
    '/outside.scss',
    './C:/outside.scss',
    './nested\\..\\outside.scss',
  ])
    assert.equal(missingPreviewFile({ ...diagnostic, module }, snapshot), undefined, module);
  assert.equal(missingPreviewFile({ ...diagnostic, code: 'SYNTAX_ERROR' }, snapshot), undefined);
  assert.equal(
    missingPreviewFile({ code: 'MODULE_NOT_FOUND', module: './index.scss' }, snapshot),
    undefined,
  );
  assert.equal(
    missingPreviewFile(diagnostic, [
      ...snapshot,
      { ...snapshot[0], path: 'pages/page/index.scss' },
    ]),
    undefined,
  );
});
