import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as PreviewUi from '../web/src/workspace/PreviewPanel';
import type { FileInfo } from '../web/src/workspace/types';

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../web/src/workspace/PreviewPanel.tsx', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  plugins: [
    {
      name: 'shared-packages',
      /** 真实组件使用共享 React 实例，以便在 Node 中渲染。 */
      setup(builder) {
        builder.onResolve({ filter: /^(react(?:\/.*)?|react-dom(?:\/.*)?|antd)$/ }, ({ path }) => ({
          path: import.meta.resolve(path),
          external: true,
        }));
      },
    },
  ],
});
const ui = (await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
)) as typeof PreviewUi;

/** 使用带中文和嵌套目录的实际源码路径，避免以文件 ID 或 basename 代替入口。 */
function file(path: string, kind: FileInfo['kind'] = 'source'): FileInfo {
  return { fileId: `file-${path}`, path, kind, revision: 1, size: 10 };
}

test('预览入口仅包含 TSX/JSX 源码，保留完整路径与大小写', () => {
  const entries = [
    file('src/页面/index.tsx'),
    file('components/Card.JSX'),
    file('src/helper.ts'),
    file('src/main.js'),
    file('src/App.tsx.map'),
    file('assets/icon.tsx', 'asset'),
    file('notes/demo.jsx', 'attachment'),
    file('internal/demo.tsx', 'internal'),
  ];
  assert.deepEqual(
    ui.previewEntries(entries).map((entry) => entry.path),
    ['src/页面/index.tsx', 'components/Card.JSX'],
  );
});

test('多入口优先页面首页，输入重排不影响默认选择且不修改原数组', () => {
  const paths = [
    'pages/page/blocks/qiangquan/index.tsx',
    'pages/page/blocks/baibaoxiang/index.tsx',
    'pages/page/blocks/gengduofuli/index.tsx',
    'pages/page/index.tsx',
  ];
  const files = paths.map((path) => file(path));
  assert.equal(ui.previewEntries(files)[0].path, 'pages/page/index.tsx');
  assert.deepEqual(
    files.map((entry) => entry.path),
    paths,
  );
  assert.deepEqual(ui.previewEntries(files), ui.previewEntries([...files].reverse()));
  assert.equal(
    ui.previewEntries([file('components/Card.jsx'), file('src/App.tsx')])[0].path,
    'src/App.tsx',
  );
  assert.equal(
    ui.previewEntries([file('pages/detail/index.tsx'), file('pages/home/index.tsx')])[0].path,
    'pages/home/index.tsx',
  );
  const html = renderToStaticMarkup(
    createElement(ui.default, { versionId: 'v', files, target: 'h5' }),
  );
  assert.match(html, /<option value="pages\/page\/index.tsx" selected=""/);
});

test('票据入口限定当前 preview、target 和有效期，拒绝越界 URL', () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  for (const [target, prefix] of [
    ['h5', 'H5_Preview'],
    ['rn', 'RN_Preview'],
  ] as const) {
    assert.equal(
      ui.validPreviewTicket(
        { url: `/${prefix}/p-1/ticket_1/index.html`, expiresAt },
        'p-1',
        target,
      ),
      true,
    );
  }
  for (const url of [
    'https://example.com/H5_Preview/p-1/t/index.html',
    '//example.com/H5_Preview/p-1/t/index.html',
    '/H5_Preview/p-2/t/index.html',
    '/RN_Preview/p-1/t/index.html',
    '/H5_Preview/p-1/../index.html',
    '/H5_Preview/p-1/%2e%2e/index.html',
    '/H5_Preview/p-1/t/index.html?redirect=elsewhere',
    '/H5_Preview/p-1/t/index.html#fragment',
  ])
    assert.equal(ui.validPreviewTicket({ url, expiresAt }, 'p-1', 'h5'), false, url);
  for (const invalidExpiry of ['invalid', '2000-01-01T00:00:00.000Z']) {
    assert.equal(
      ui.validPreviewTicket(
        { url: '/H5_Preview/p-1/t/index.html', expiresAt: invalidExpiry },
        'p-1',
        'h5',
      ),
      false,
    );
  }
});

test('作品库允许长期链接，私有会话校验默认仍拒绝无到期时间的票据', () => {
  for (const [target, prefix] of [
    ['h5', 'H5_Preview'],
    ['rn', 'RN_Preview'],
  ] as const) {
    const ticket = { url: `/${prefix}/p-1/token/index.html`, expiresAt: null };
    assert.equal(ui.validPreviewTicket(ticket, 'p-1', target, true), true);
    assert.equal(ui.validPreviewTicket(ticket, 'p-1', target), false);
    assert.equal(ui.validPreviewTicket(ticket, 'other-preview', target, true), false);
    assert.equal(
      ui.validPreviewTicket(
        { ...ticket, url: 'https://outside.invalid/index.html' },
        'p-1',
        target,
        true,
      ),
      false,
    );
  }
});

test('RN 初始展示兼容提示及真实入口，不会在显式取票据前加载 iframe', () => {
  const html = renderToStaticMarkup(
    createElement(ui.default, {
      versionId: 'version-1',
      files: [file('src/页面/index.tsx')],
      target: 'rn',
    }),
  );
  assert.match(html, /浏览器兼容预览/);
  assert.match(html, /value="src\/页面\/index.tsx"/);
  assert.match(html, /生成预览/);
  assert.doesNotMatch(html, /<iframe|target="_blank"/);
});

test('没有合适源码时显示空态并禁止生成', () => {
  const html = renderToStaticMarkup(
    createElement(ui.default, {
      versionId: 'version-1',
      files: [file('helper.ts')],
      target: 'h5',
    }),
  );
  assert.match(html, /该版本没有可预览的 TSX \/ JSX 源码/);
  assert.match(html, /<button[^>]*disabled=""/);
});
