import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playwright = fileURLToPath(
  new URL('../preview-browser/node_modules/playwright-core/index.mjs', import.meta.url),
);
const screenshotPrefix = `/tmp/publications-ui-${basename(root) === 'pixel-print-service' ? 'internal' : 'public'}`;

/** PIXELPRINT_BROWSER_TESTS=1 npx --no-install tsx --test test/publicationsUiBrowser.test.ts */
test(
  '发布作品 UI：真实组件、CSS、剪贴板、导航及本地 HTTP 下线回归',
  {
    skip:
      process.env.PIXELPRINT_BROWSER_TESTS !== '1' ||
      !existsSync(chrome) ||
      !existsSync(playwright),
    timeout: 120000,
  },
  async (t) => {
    const bundle = await build({
      stdin: {
        contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {App,Select} from 'antd';
          import WorksPanel from './web/src/workspace/WorksPanel';
          import CommunityPanel from './web/src/workspace/CommunityPanel';
          import {TeamProvider} from './web/src/workspace/TeamSettings';
          import './web/src/workspace/works.css';import './web/src/styles.css';
          import './web/src/workspace/previewPanel.css';import './web/src/workspace/phonePreview.css';
          import './web/src/workspace/previewInspector.css';
          const root=createRoot(document.getElementById('root'));let epoch=0;
          window.sourceSelection=null;window.selected=null;
          function Collection({initialKind,resourceId}){
            const [kind,setKind]=React.useState(initialKind);
            const [scope,setScope]=React.useState('all');
            return <CommunityPanel key={kind} kind={kind} resourceId={resourceId}
              plazaScope={scope} onScopeChange={setScope} onKindChange={setKind}
              onSelect={id=>window.selected=id} onOpenSession={(w,s)=>window.sourceSelection=[w,s]}/>;
          }
          window.mount=(kind='versions',resourceId='')=>flushSync(()=>root.render(<App key={++epoch}><TeamProvider>
            {kind==='selects' ? <Select aria-label="AntD 范围" defaultValue="all" options={[{value:'all',label:'全部作品'},{value:'mine',label:'我发布的作品'}]}/>
              :kind==='versions' ? <WorksPanel versionId={resourceId} onSelect={id=>window.selected=id} onOpenSession={(w,s)=>window.sourceSelection=[w,s]}/>
              :<Collection initialKind={kind==='saved'?'my-works':'plaza'} resourceId={resourceId}/>}
          </TeamProvider></App>));window.mount();`,
        resolveDir: root,
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      outfile: '/tmp/publications-ui/app.js',
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [
        {
          name: 'isolate-editors',
          setup(builder) {
            builder.onResolve({ filter: /^\.\/(?:EditWorkspace|CodePreview)$/ }, () => ({
              path: 'editor',
              namespace: 'fixture',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
              contents:
                'export default function Editor(){return null};export function EditWorkspaceSurface(){return null}',
              loader: 'js',
              resolveDir: root,
            }));
          },
        },
      ],
    });
    const identity = {
      createdEid: 'fixture-owner',
      createdUserId: 'fixture-owner',
      creatorName: '测试作者',
      createdAt: '2026-11-23T01:00:00Z',
    };
    const files = ['pages/page/index.tsx', 'pages/page/blocks/card/index.tsx'].map((path) => ({
      fileId: path,
      path,
      kind: 'source',
      revision: 1,
      size: 10,
    }));
    const version = {
      ...identity,
      versionId: 'version-owned',
      name: '浏览器回归版本',
      target: 'h5',
      status: 'ready',
      canDelete: true,
      sourceFileRevision: 1,
      validationSummary: { status: 'passed' },
      sourceSession: { workspaceId: 'version-workspace', sessionId: 'version-session' },
      files,
    };
    const session = {
      ...identity,
      shareId: 'share-owned',
      sessionId: 'session-owned',
      name: '本人发布作品',
      target: 'h5',
      canManage: true,
      fileRevision: 1,
      timelineSeq: 1,
      sourceSession: { workspaceId: 'source-workspace', sessionId: 'source-session' },
    };
    const foreign = {
      ...session,
      shareId: 'share-foreign',
      sessionId: 'session-foreign',
      name: '不可管理作品',
      // 同一个创建者快照仍必须以服务端当前 canManage 为准。
      canManage: false,
      sourceSession: null,
    };
    const saved = {
      ...identity,
      workId: 'saved-owned',
      name: '本人保存作品',
      target: 'h5',
      revision: 1,
      canManage: true,
    };
    const requests: { method: string; path: string; body: any; csrf?: string }[] = [];
    const unexpected: string[] = [];
    let published = true;
    let rejectUnpublish = false;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      if (url.pathname === '/app.js' || url.pathname === '/app.css') {
        const extension = url.pathname.endsWith('.js') ? '.js' : '.css';
        res.setHeader('Content-Type', extension === '.js' ? 'text/javascript' : 'text/css');
        res.end(bundle.outputFiles.find((file) => file.path.endsWith(extension))!.text);
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const record = {
        method: req.method!,
        path: url.pathname + url.search,
        body: body ? JSON.parse(body) : null,
        csrf: req.headers['x-requested-with'] as string | undefined,
      };
      if (url.pathname.startsWith('/api/')) requests.push(record);
      const send = (data: unknown, status = 200, resultMessage = '') => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: status < 400, data, resultMessage }));
      };
      if (url.pathname === '/api/d2c/teams') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, rows: [], total: 0 }));
        return;
      }
      if (url.pathname === '/api/d2c/users/me')
        return send({ eid: 'fixture-owner', userId: 'fixture-owner', name: '测试作者' });
      if (url.pathname === '/api/d2c/users/resolve') return send({ users: [] });
      if (url.pathname === '/api/d2c/versions')
        return send({ rows: [version], total: 1, page: 1, pageSize: 12 });
      if (url.pathname === '/api/d2c/versions/version-owned') return send(version);
      if (url.pathname === '/api/d2c/versions/version-owned/previews') {
        const entryPath = url.searchParams.get('entryPath');
        return send({
          previewId: entryPath === files[0].path ? 'preview-home' : 'preview-card',
          versionId: version.versionId,
          status: 'ready',
          target: 'h5',
          entryPath,
        });
      }
      if (/^\/api\/d2c\/previews\/preview-(home|card)\/ticket$/.test(url.pathname)) {
        const previewId = url.pathname.split('/')[4];
        return send({ url: `/H5_Preview/${previewId}/permanent/index.html`, expiresAt: null });
      }
      if (url.pathname === '/api/d2c/my-works')
        return send({ items: [saved], total: 1, page: 1, pageSize: 12 });
      if (url.pathname === '/api/d2c/plaza/sessions') {
        const mine = url.searchParams.get('scope') === 'mine';
        const page = Number(url.searchParams.get('page') || 1);
        const items = mine
          ? published
            ? [session]
            : []
          : Array.from({ length: 13 }, (_, index) =>
              index === 0
                ? session
                : { ...foreign, shareId: `foreign-${index}`, name: `不可管理作品 ${index}` },
            ).filter((row) => published || row.shareId !== session.shareId);
        return send({
          items: items.slice((page - 1) * 12, page * 12),
          total: items.length,
          page,
          pageSize: 12,
        });
      }
      if (url.pathname === '/api/d2c/sessions/session-owned/sharing' && req.method === 'PUT') {
        if (rejectUnpublish) return send(null, 503, '下线失败：隔离接口暂不可用');
        published = false;
        return send({ public: false, shareId: null, canManage: true });
      }
      if (url.pathname.startsWith('/api/')) {
        unexpected.push(`${req.method} ${url.pathname}`);
        return send(null, 404, '未定义测试接口');
      }
      if (url.pathname.startsWith('/H5_Preview/')) {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html><body><h1>隔离 HTTP 预览产物</h1></body></html>');
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    const external: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    // 防止未来组件新增请求时意外触达线上；同源请求仍全部走真实 HTTP。
    await page.route('**/*', async (route: any) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return route.continue();
      external.push(url.origin);
      await route.abort();
    });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await page.goto(origin);

    /** 每个场景同步重挂真实组件，避免读到上一场景正在卸载的节点。 */
    async function mount(kind: string, resourceId = '') {
      await page.evaluate(
        ([kind, resourceId]: string[]) => (window as any).mount(kind, resourceId),
        [kind, resourceId],
      );
      await page.locator(kind === 'selects' ? '.ant-select' : '.works-panel').waitFor();
    }

    /** 同时检查文档与实际可滚动容器，不能让 overflow:auto 掩盖横向溢出。 */
    async function noOverflow() {
      const overflow = await page.evaluate(() =>
        [document.documentElement, ...document.querySelectorAll('.works-panel,.work-card')]
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => ({
            selector: element.className || element.tagName,
            client: element.clientWidth,
            scroll: element.scrollWidth,
          })),
      );
      assert.deepEqual(overflow, [], '390px 不应存在文档、面板或卡片内部横向溢出');
    }

    /** 检查可见坐标、间距和行数，避免仅匹配 CSS 声明而漏过真实布局回归。 */
    async function aligned(selector: string, expectedNames: string[], rightAction: boolean) {
      const row = page.locator(selector).first();
      const names = await row
        .locator(':scope > .ant-btn')
        .evaluateAll((buttons: Element[]) =>
          buttons.map((button) => button.getAttribute('aria-label') || button.textContent!.trim()),
        );
      assert.deepEqual(names, expectedNames, `${selector} 的操作顺序和所属操作栏`);
      const geometry = await row.evaluate((element: HTMLElement) => {
        const box = element.getBoundingClientRect();
        const buttons = [...element.querySelectorAll(':scope > .ant-btn')].map((button) => {
          const rect = button.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        });
        return { left: box.left, right: box.right, buttons };
      });
      const { buttons } = geometry;
      assert.ok(Math.abs(buttons[0].left - geometry.left) <= 2, '常用操作从左侧开始');
      for (let index = 1; index < buttons.length; index++) {
        assert.ok(Math.abs(buttons[index].top - buttons[0].top) <= 2, '操作栏应保持单行');
        assert.ok(buttons[index].left >= buttons[index - 1].right, '操作不能重叠');
      }
      if (rightAction)
        assert.ok(Math.abs(buttons.at(-1)!.right - geometry.right) <= 2, '删除/下线靠右');
      if (buttons.length > 2)
        assert.ok(buttons[1].left - buttons[0].right <= 10, '相邻常用操作聚在左侧');
    }

    await t.test('1440px 详情操作顺序与 App.useApp 剪贴板成功/失败', async () => {
      await mount('versions', version.versionId);
      const copy = page.getByRole('button', { name: '复制预览链接', exact: true });
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll('button')].find((b) => b.textContent === '复制预览链接')
            ?.disabled,
      );
      await page.locator('.version-preview-viewport iframe').waitFor();
      await aligned(
        '.work-summary-actions',
        ['查看来源会话', '下载 ZIP', '复制预览链接', `删除会话版本：${version.name}`],
        true,
      );
      assert.equal(
        await page.getByRole('link', { name: '下载 ZIP', exact: true }).getAttribute('href'),
        '/api/d2c/versions/version-owned/archive',
      );
      await page.getByRole('link', { name: '查看来源会话', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => (window as any).sourceSelection), [
        'version-workspace',
        'version-session',
      ]);
      // 使用原始浏览器脚本，避免 tsx keepNames 为嵌套函数注入 Node 侧 __name helper。
      await page.evaluate(`window.copied=[];window.rejectClipboard=false;
        Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async(value)=>{
          if(window.rejectClipboard)throw new DOMException('Denied','NotAllowedError');
          window.copied.push(value);
        }});`);
      await copy.click();
      await page
        .locator('.ant-message-success')
        .getByText('预览链接已复制', { exact: true })
        .waitFor();
      assert.deepEqual(await page.evaluate(() => (window as any).copied), [
        `${origin}/H5_Preview/preview-home/permanent/index.html`,
      ]);
      await page.evaluate(() => ((window as any).rejectClipboard = true));
      await copy.click();
      await page
        .locator('.ant-message-error')
        .getByText('复制失败，请重试或检查浏览器剪贴板权限', { exact: true })
        .waitFor();
      assert.equal(
        await page
          .locator('.works-panel p')
          .filter({ hasText: /预览链接已复制|复制失败/ })
          .count(),
        0,
      );
      assert.equal(await page.getByRole('button', { name: /^(关闭预览|显示预览)$/ }).count(), 0);
      await page.screenshot({
        path: `${screenshotPrefix}-detail-1440.png`,
        animations: 'disabled',
      });
      await page.evaluate(() => ((window as any).rejectClipboard = false));
      await page
        .locator('.version-preview-panel > .version-preview-controls > label > select')
        .selectOption(files[1].path);
      await page.waitForFunction(() =>
        document.querySelector('iframe')?.getAttribute('src')?.includes('preview-card'),
      );
      await copy.click();
      assert.equal(
        (await page.evaluate(() => (window as any).copied)).at(-1),
        `${origin}/H5_Preview/preview-card/permanent/index.html`,
      );
    });

    await t.test(
      '真实 PreviewPanel 原生 select 36px 留白、12px 箭头；AntD select 可用且不被污染',
      async () => {
        await mount('versions', version.versionId);
        const select = page.locator(
          '.version-preview-panel > .version-preview-controls > label > select',
        );
        await select.waitFor();
        const style = await select.evaluate((node: Element) => {
          const css = getComputedStyle(node);
          return {
            padding: css.paddingInlineEnd,
            size: css.backgroundSize,
            x: css.backgroundPositionX,
            image: css.backgroundImage,
            appearance: css.appearance,
          };
        });
        assert.equal(style.padding, '36px');
        assert.equal(style.size, '12px 12px');
        assert.match(style.x, /12px/);
        assert.match(style.image, /data:image\/svg\+xml/);
        assert.equal(style.appearance, 'none');
        await mount('selects');
        const combo = page.getByRole('combobox', { name: 'AntD 范围' });
        const antdStyle = await combo.evaluate((node: Element) => {
          const css = getComputedStyle(node);
          return { tag: node.tagName, padding: css.paddingInlineEnd, image: css.backgroundImage };
        });
        assert.notEqual(antdStyle.tag, 'SELECT');
        assert.notEqual(antdStyle.padding, '36px');
        assert.equal(antdStyle.image, 'none');
        await combo.click();
        await page
          .locator('.ant-select-item-option-content')
          .getByText('我发布的作品', { exact: true })
          .click();
        await page
          .locator('.ant-select-content')
          .getByText('我发布的作品', { exact: true })
          .waitFor();
      },
    );

    for (const kind of ['versions', 'saved', 'plaza']) {
      await t.test(`${kind} 卡片桌面和 390px 操作对齐、单行与无水平溢出`, async () => {
        published = true;
        await page.setViewportSize({ width: 1440, height: 1000 });
        await mount(kind);
        await page.locator('.work-card').first().waitFor();
        const names =
          kind === 'versions'
            ? ['查看版本', '下载 ZIP', `删除会话版本：${version.name}`]
            : kind === 'saved'
              ? ['查看作品', '下载 ZIP', `删除作品：${saved.name}`]
              : ['打开作品', '进入会话', `下线作品：${session.name}`];
        // 先保存窄屏证据，再执行严格布局断言，以便真实缺陷也留下截图。
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({
          path: `${screenshotPrefix}-${kind}-390.png`,
          animations: 'disabled',
        });
        await noOverflow();
        await aligned('.work-card-actions', names, true);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await aligned('.work-card-actions', names, true);
      });
    }

    await t.test('广场唯一三分类往返、mine 页码重置、当前权限与来源回调', async () => {
      published = true;
      await mount('plaza');
      const categories = page.getByRole('navigation', { name: '广场分类', exact: true });
      /** 分类只有一层，列表无重复标题，选中项跟随受控 scope/kind。 */
      async function category(name: string) {
        assert.equal(await categories.count(), 1);
        assert.deepEqual(await categories.getByRole('button').allTextContents(), [
          '全部作品',
          '我发布的作品',
          '已保存作品',
        ]);
        assert.equal(await categories.locator('[aria-current="page"]').innerText(), name);
        assert.equal(
          await page
            .locator('.community-panel h1,.community-panel .ant-segmented,.plaza-navigation')
            .count(),
          0,
        );
      }
      await category('全部作品');
      await page.locator('.ant-pagination-item-2').click();
      await page.getByRole('button', { name: '不可管理作品 12', exact: true }).waitFor();
      const start = requests.length;
      await page.getByText('我发布的作品', { exact: true }).click();
      const unpublish = page.getByRole('button', {
        name: `下线作品：${session.name}`,
        exact: true,
      });
      await unpublish.waitFor();
      const reads = requests
        .slice(start)
        .filter((r) => r.path.startsWith('/api/d2c/plaza/sessions?'));
      assert.equal(reads.length, 1);
      const query = new URL(reads[0].path, origin).searchParams;
      assert.equal(query.get('scope'), 'mine');
      assert.equal(query.get('page'), '1');
      assert.equal(query.get('pageSize'), '12');
      await category('我发布的作品');
      await categories.getByRole('button', { name: '已保存作品', exact: true }).click();
      await page.getByRole('button', { name: saved.name, exact: true }).waitFor();
      await category('已保存作品');
      const returnStart = requests.length;
      await categories.getByRole('button', { name: '我发布的作品', exact: true }).click();
      await unpublish.waitFor();
      await category('我发布的作品');
      const returned = requests
        .slice(returnStart)
        .filter((r) => r.path.startsWith('/api/d2c/plaza/sessions?'));
      assert.equal(returned.length, 1);
      assert.equal(new URL(returned[0].path, origin).searchParams.get('scope'), 'mine');
      assert.equal(new URL(returned[0].path, origin).searchParams.get('page'), '1');
      const source = page.getByRole('link', { name: '进入会话', exact: true });
      assert.equal(
        await source.getAttribute('href'),
        '/workbench/source-workspace/sessions/source-session',
      );
      await source.click();
      assert.deepEqual(await page.evaluate(() => (window as any).sourceSelection), [
        'source-workspace',
        'source-session',
      ]);
      assert.equal(await page.evaluate(() => location.pathname), '/');
      await page.getByText('全部作品', { exact: true }).click();
      await page.getByRole('button', { name: '不可管理作品 1', exact: true }).waitFor();
      const foreignCard = page
        .locator('.work-card')
        .filter({ has: page.getByRole('button', { name: '不可管理作品 1', exact: true }) });
      assert.equal(await foreignCard.locator('.work-action-unpublish').count(), 0);
      assert.equal(
        await foreignCard.getByRole('link', { name: '进入会话', exact: true }).count(),
        0,
      );
      assert.equal(await page.locator('.work-action-unpublish').count(), 1);
      assert.equal(requests.filter((r) => r.method === 'PUT').length, 0);
      await category('全部作品');
      await categories.getByRole('button', { name: '已保存作品', exact: true }).click();
      await page.getByRole('button', { name: saved.name, exact: true }).waitFor();
      await categories.getByRole('button', { name: '全部作品', exact: true }).click();
      await page.getByRole('button', { name: '不可管理作品 1', exact: true }).waitFor();
      await category('全部作品');
    });

    await t.test(
      '列表下线失败保留卡片和 message；成功 PUT 带 CSRF、public:false 并刷新 mine',
      async () => {
        published = true;
        rejectUnpublish = true;
        await mount('plaza');
        await page.getByText('我发布的作品', { exact: true }).click();
        const remove = page.getByRole('button', { name: `下线作品：${session.name}`, exact: true });
        await remove.waitFor();
        const start = requests.length;
        await remove.click();
        await page
          .locator('.ant-message-error')
          .getByText('下线失败：隔离接口暂不可用', { exact: true })
          .waitFor();
        assert.equal(await remove.isVisible(), true);
        assert.equal(await remove.isEnabled(), true);
        assert.equal(published, true);
        assert.equal(
          requests
            .slice(start)
            .filter((r) => r.method === 'GET' && r.path.startsWith('/api/d2c/plaza/sessions?'))
            .length,
          0,
        );
        rejectUnpublish = false;
        await remove.click();
        await page
          .locator('.ant-message-success')
          .getByText('作品已下线', { exact: true })
          .waitFor();
        await page
          .getByText('暂无已发布的作品，可在工作台会话中发布到广场。', { exact: true })
          .waitFor();
        assert.equal(await page.locator('.work-card').count(), 0);
        const changes = requests.slice(start).filter((r) => r.method === 'PUT');
        assert.equal(changes.length, 2);
        for (const change of changes) {
          assert.equal(change.path, '/api/d2c/sessions/session-owned/sharing');
          assert.deepEqual(change.body, { public: false });
          assert.equal(change.csrf, 'PixelPrint');
        }
        const refreshed = requests
          .slice(start)
          .filter((r) => r.method === 'GET' && r.path.startsWith('/api/d2c/plaza/sessions?'));
        assert.equal(refreshed.length, 1);
        assert.equal(new URL(refreshed[0].path, origin).searchParams.get('scope'), 'mine');
        assert.equal(new URL(refreshed[0].path, origin).searchParams.get('page'), '1');
      },
    );
    assert.deepEqual(unexpected, [], 'fixture 必须显式覆盖实际请求');
    assert.deepEqual(external, [], '所有请求应局限于隔离 HTTP');
    assert.deepEqual(errors, [], '真实组件不能出现未捕获浏览器异常');
  },
);
