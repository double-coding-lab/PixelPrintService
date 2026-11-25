import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFileTree,
  buildSourceFileTree,
  directoryKeys,
  formatFileSize,
  isPreviewImage,
} from '../web/src/workspace/fileTree';
import type { FileInfo } from '../web/src/workspace/types';

/** 样本包含重名文件、内部缓存和多级目录，用于核对前端路径归组。 */
function file(path: string, fileId = path): FileInfo {
  return { fileId, path, size: 1024, kind: 'source', revision: 1 };
}

test('文件树按目录隔离重名文件，目录优先自然排序并保留原始标识', () => {
  const tree = buildFileTree([
    file('z.ts'),
    file('src/page10/index.tsx', 'ten'),
    file('assets/index.png', 'image'),
    file('src/page2/index.tsx', 'two'),
    file('.d2c-cache/key/node.json'),
  ]);
  assert.deepEqual(
    tree.map((node) => node.title),
    ['.d2c-cache', 'assets', 'src', 'z.ts'],
  );
  assert.deepEqual(
    tree[2].children?.map((node) => node.title),
    ['page2', 'page10'],
  );
  assert.equal(tree[2].children?.[0].children?.[0].key, 'two');
  assert.equal(tree[1].children?.[0].file?.path, 'assets/index.png');
  assert.ok(directoryKeys(tree).includes('directory:src/page2'));
});

test('搜索忽略大小写并保留父级目录，不修改原始清单；图片识别排除 SVG', () => {
  const files = [file('src/Page/index.tsx'), file('assets/banner.PNG')];
  const tree = buildFileTree(files, '  BANNER  ');
  assert.equal(tree.length, 1);
  assert.equal(tree[0].title, 'assets');
  assert.equal(tree[0].children?.[0].key, 'assets/banner.PNG');
  assert.deepEqual(buildFileTree(files, 'missing'), []);
  assert.equal(files.length, 2);
  assert.ok(isPreviewImage(files[1]));
  assert.equal(isPreviewImage(file('assets/icon.svg')), false);
  assert.equal(formatFileSize(500), '500 B');
  assert.equal(formatFileSize(2048), '2.0 KB');
});

test('WebP缩略图使用独立虚拟目录和身份，保留路径、搜索及真实同名目录', () => {
  const files = [file('assets/banner.png', 'original'), file('WebP/index.tsx', 'source')];
  const derivative = {
    ...file('assets/banner.png_.webp', 'webp:original'),
    kind: 'asset' as const,
    url: 'https://images.example.test/actual.webp',
  };
  const tree = buildSourceFileTree(files, [derivative]);
  assert.equal(tree[0].title, 'WebP 缩略图');
  assert.equal(tree[0].key, 'virtual:webp');
  const leaf = tree[0].children?.[0].children?.[0];
  assert.equal(leaf?.key, 'webp:original');
  assert.equal(leaf?.file, derivative);
  assert.ok(directoryKeys(tree).includes('webp:directory:assets'));
  assert.ok(directoryKeys(tree).includes('directory:assets'));
  assert.ok(directoryKeys(tree).includes('directory:WebP'));
  assert.deepEqual(
    buildSourceFileTree(files, [derivative], 'INDEX'),
    buildFileTree(files, 'INDEX'),
  );
  assert.equal(
    buildSourceFileTree(files, [derivative], '.WEBP')[0].children?.[0].children?.[0].key,
    'webp:original',
  );
  assert.deepEqual(buildSourceFileTree(files, []), buildFileTree(files));
  assert.equal(files[0].path, 'assets/banner.png');
});
