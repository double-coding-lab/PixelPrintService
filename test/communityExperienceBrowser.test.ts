import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playwright = fileURLToPath(
  new URL('../preview-browser/node_modules/playwright-core/index.mjs', import.meta.url),
);

/** 独立挂载广场以隔离主导航并行改动；保留真实 Drawer、Markdown、网络和 CSS。 */
test(
  '广场卡片、Markdown、自动补读重试和抽屉取消',
  {
    skip:
      process.env.PIXELPRINT_BROWSER_TESTS !== '1' ||
      !existsSync(chrome) ||
      !existsSync(playwright),
    timeout: 60000,
  },
  async (t) => {
    const bundle = await build({
      stdin: {
        contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
        import CommunityPanel from './web/src/workspace/CommunityPanel';
        import './web/src/styles.css'; import './web/src/workspace/works.css';
        const root=createRoot(document.getElementById('root'));
        window.mount=(kind='plaza',resourceId='')=>root.render(<CommunityPanel key={kind+resourceId} kind={kind} resourceId={resourceId} onSelect={id=>window.mount(kind,id)}/>);
        window.mount();`,
        resolveDir: root,
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      outfile: '/tmp/community-experience/app.js',
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [
        {
          name: 'isolate-editor',
          setup(builder) {
            builder.onResolve({ filter: /^\.\/EditWorkspace$/ }, () => ({
              path: 'editor',
              namespace: 'fixture',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
              contents: `import React from 'react'; export function EditWorkspaceSurface(){const [text,setText]=React.useState('draft');return <textarea aria-label="副本" value={text} onChange={e=>setText(e.target.value)}/>;} export default function EditWorkspace(){return null;}`,
              loader: 'tsx',
              resolveDir: root,
            }));
          },
        },
      ],
    });
    const js = bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
    const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
    const session = {
      shareId: 'share',
      sessionId: 'original',
      name: '测试作品',
      target: 'h5',
      creatorName: '作者',
      createdUserId: 'author',
      createdAt: '',
      fileRevision: 1,
      timelineSeq: 9,
      coverUrl: '/cover.png',
    };
    const entry = (seq: number, role: string, text: string) => ({
      entryId: `e${seq}`,
      sessionId: 'original',
      runId: null,
      seq,
      kind: 'message',
      data: { role, text },
      at: '2026-11-18T00:00:00Z',
    });
    const cursors: number[] = [];
    let fail = true;
    let hold = false;
    let active = 0;
    let maxActive = 0;
    let showSavedCover = false;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://local');
      if (url.pathname === '/app.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(js);
        return;
      }
      if (url.pathname === '/app.css') {
        res.setHeader('Content-Type', 'text/css');
        res.end(css);
        return;
      }
      const send = (data: unknown) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, data }));
      };
      if (url.pathname === '/api/d2c/plaza/sessions')
        return send({
          items: [
            session,
            { ...session, shareId: 'empty', name: '无封面作品', coverUrl: null },
            { ...session, shareId: 'broken', name: '失效封面作品', coverUrl: '/missing.png' },
          ],
          total: 3,
        });
      if (url.pathname === '/api/d2c/plaza/sessions/share') return send(session);
      if (url.pathname === '/api/d2c/my-works')
        return send({
          items: showSavedCover
            ? [
                {
                  workId: 'saved',
                  name: '已保存同源作品',
                  target: 'h5',
                  revision: 1,
                  createdAt: session.createdAt,
                  coverUrl: session.coverUrl,
                },
              ]
            : [],
          total: showSavedCover ? 1 : 0,
        });
      if (url.pathname.endsWith('/timeline')) {
        active++;
        maxActive = Math.max(maxActive, active);
        res.on('close', () => {
          active--;
        });
        const before = Number(url.searchParams.get('beforeSeq'));
        cursors.push(before);
        if (hold) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (before === 5 && fail) {
          fail = false;
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, resultMessage: '暂时失败' }));
          return;
        }
        return send({
          entries:
            before === 0
              ? [
                  entry(
                    5,
                    'assistant',
                    '**最近回复**\n\n## 对话小标题\n\n|列|值|\n|---|---|\n|A|B|\n\n```js\nconst x = 1;\n```\n\n<script>window.injected=true</script>',
                  ),
                ]
              : [entry(1, 'user', '# 早期需求\n\n1. 第一项\n2. 第二项')],
          previousSeq: before === 0 ? 5 : 1,
          hasMore: before === 0,
          nextSeq: 9,
        });
      }
      if (url.pathname === '/cover.png') {
        res.setHeader('Content-Type', 'image/png');
        res.end(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6cAAAAASUVORK5CYII=',
            'base64',
          ),
        );
        return;
      }
      if (url.pathname === '/missing.png') {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const { chromium } = await import(pathToFileURL(playwright).href);
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    const cover = page.getByRole('button', { name: '打开作品：测试作品', exact: true });
    await cover.waitFor();
    assert.equal(await cover.locator('img').getAttribute('loading'), 'lazy');
    await page
      .getByRole('button', { name: '打开作品：失效封面作品', exact: true })
      .getByText('暂无运行截图')
      .waitFor();
    assert.equal(await page.getByText('暂无运行截图').count(), 2);
    await page.screenshot({ path: '/tmp/community-cards.png' });
    await cover.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: '副本' }).fill('保留编辑');
    const back = page.getByRole('button', { name: '← 返回广场' });
    assert.equal(
      await back.evaluate((node: HTMLElement) => !!node.closest('.community-detail-leading')),
      true,
    );
    await page.getByRole('button', { name: '查看对话', exact: true }).click();
    await page.getByText('暂时失败', { exact: true }).waitFor();
    await page.locator('.markdown-message strong').getByText('最近回复').waitFor();
    assert.deepEqual(cursors, [0, 5]);
    assert.equal(await page.getByRole('button', { name: '加载更早记录' }).count(), 0);
    await page.getByRole('button', { name: /^重\s*试$/ }).click();
    await page.getByRole('status').getByText('已读取全部对话', { exact: false }).waitFor();
    assert.deepEqual(cursors, [0, 5, 5]);
    assert.equal(maxActive, 1);
    await page.screenshot({ path: '/tmp/community-conversation.png' });
    assert.equal(await page.locator('.community-conversation h1').innerText(), '早期需求');
    assert.equal(await page.locator('.markdown-table td').count(), 2);
    assert.equal(
      await page.locator('.community-conversation .markdown-message h2').innerText(),
      '对话小标题',
    );
    assert.equal(await page.locator('.markdown-message pre code').innerText(), 'const x = 1;\n');
    assert.equal(await page.locator('.community-conversation script').count(), 0);
    assert.equal(await page.evaluate('window.injected'), undefined);
    assert.equal(
      await page
        .locator('ol.timeline')
        .evaluate((el: Element) => getComputedStyle(el).listStyleType),
      'none',
    );
    assert.equal(
      await page
        .locator('.markdown-message ol')
        .evaluate((el: Element) => getComputedStyle(el).listStyleType),
      'decimal',
    );
    assert.equal(await page.getByRole('textbox', { name: '副本' }).inputValue(), '保留编辑');
    await page.locator('.community-detail-drawer .ant-drawer-close').click();
    await page.evaluate(
      `window.aborts=0; const old=window.fetch; window.fetch=(url,init)=>{if(String(url).includes('/timeline')) init.signal.addEventListener('abort',()=>window.aborts++);return old(url,init);}`,
    );
    hold = true;
    await page.getByRole('button', { name: '查看对话', exact: true }).click();
    await page.waitForFunction(
      'document.querySelector(".community-conversation [role=status]")?.textContent.includes("正在自动读取")',
    );
    await page.locator('.community-detail-drawer .ant-drawer-close').click();
    await page.waitForFunction('window.aborts === 1');
    await page.evaluate('window.mount("my-works")');
    const categories = page.getByRole('navigation', { name: '广场分类', exact: true });
    await categories.getByRole('button', { name: '已保存作品', exact: true }).waitFor();
    assert.equal(
      await categories
        .getByRole('button', { name: '已保存作品', exact: true })
        .getAttribute('aria-current'),
      'page',
    );
    assert.equal(
      await page.getByRole('link', { name: '广场', exact: true }).getAttribute('href'),
      '/plaza',
    );
    await page.getByText('点击“保存为作品”后即可在这里查看。', { exact: false }).waitFor();
    showSavedCover = true;
    await page.evaluate('window.mount("plaza")');
    await cover.waitFor();
    const plazaImage = await cover.locator('img').getAttribute('src');
    await page.evaluate('window.mount("my-works")');
    const savedCover = page.getByRole('button', { name: '打开作品：已保存同源作品', exact: true });
    await savedCover.waitFor();
    assert.equal(await savedCover.locator('img').getAttribute('src'), plazaImage);
    assert.equal(await savedCover.locator('img').getAttribute('alt'), '已保存同源作品运行截图');
    assert.equal(await page.getByText('作品图片', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  },
);
