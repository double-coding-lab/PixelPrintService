import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import type { DiagnosticError, ErrorDiagnostics } from '../shared/errorDiagnostics';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playwrightPath = fileURLToPath(
  new URL('../preview-browser/node_modules/playwright-core/index.mjs', import.meta.url),
);

/** 使用真实 Drawer、React 状态和 API 层；合成离线数据，不连接业务服务。 */
test(
  '浏览器：数据库明细与复制、历史未知、会话统计、分页竞态、关闭取消与窄屏',
  {
    skip:
      process.env.PIXELPRINT_BROWSER_TESTS !== '1' ||
      !existsSync(chrome) ||
      !existsSync(playwrightPath),
    timeout: 90000,
  },
  async (t) => {
    const bundle = await build({
      stdin: {
        contents: `import React from 'react';
        import {createRoot} from 'react-dom/client';
        import DiagnosticsPanel from './web/src/workspace/DiagnosticsPanel';
        const originalFetch = window.fetch;
        // 模拟传输层忽略取消，生产 API 和组件仍必须隔离晚到响应。
        window.fetch = (url, init) => originalFetch(url, String(url).includes('/errors?') ? {...init, signal: undefined} : init);
        let fixture = {sessionId: 'session-a', open: false, revision: 100};
        const root = createRoot(document.getElementById('root'));
        function render() { root.render(<DiagnosticsPanel {...fixture} onClose={() => window.setFixture({open:false})}/>); }
        window.setFixture = patch => {fixture = {...fixture, ...patch}; render();}; render();`,
        resolveDir: fileURLToPath(new URL('..', import.meta.url)),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    const css = readFileSync(
      new URL('../web/src/workspace/diagnostics.css', import.meta.url),
      'utf8',
    );
    const requests: URL[] = [];
    let seq = 2000;
    let failure = 0;
    let wrongToken = false;
    const databaseFailure = {
      databaseErrorType: 'SequelizeConnectionAcquireTimeoutError' as const,
      databaseOperation: 'lease.lock_admission' as const,
      databaseTransactionPhase: 'commit' as const,
      databaseAttempt: 3,
      databaseCode: 'ETIMEDOUT' as const,
      databaseErrno: 1205,
      databaseSqlState: 'HY000',
      ...({
        sql: 'PRIVATE_SQL',
        parameters: ['PRIVATE_BINDINGS'],
        stack: 'PRIVATE_STACK',
      } as object),
    };
    let databaseDetails: DiagnosticError['failureDetails'] = databaseFailure;
    let hold: ((url: URL) => boolean) | null = null;
    const held: Array<() => void> = [];
    const row = (id: string, runId: string, rowSeq: number, url: URL): DiagnosticError => ({
      id,
      seq: rowSeq,
      at: '2026-11-21T01:00:00Z',
      runId,
      category: (url.searchParams.get('category') || 'model') as DiagnosticError['category'],
      scope: (url.searchParams.get('scope') || 'main') as DiagnosticError['scope'],
      code: 'MODEL_REQUEST_FAILED',
      message: '目标服务连接或响应超时',
      stage: 'model',
      tool: 'read_file',
      command: '<img src=x onerror=alert(1)>',
      agentId: 'agent-1',
      agentRole: 'ui',
      errorId: `trace-${id}`,
      requestId: `request-${id}`,
      attempt: 2,
      recovery: 'subsequent_success',
      failureDetails: databaseDetails,
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/app.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(bundle.outputFiles[0].text);
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          `<!doctype html><html><head><style>body{margin:0;font-family:Arial} ${css}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`,
        );
        return;
      }
      requests.push(url);
      assert.equal(req.method, 'GET');
      assert.equal(req.headers['x-requested-with'], 'PixelPrint');
      res.setHeader('Content-Type', 'application/json');
      const send = (data: unknown) => res.end(JSON.stringify({ success: true, data }));
      const sessionId = url.pathname.split('/')[4];
      if (url.pathname.endsWith('/diagnostics')) {
        const scope = (runCount: number) => ({
          runCount,
          elapsedMs: runCount * 1000,
          runningCount: 0,
          complete: true,
          usage: {
            requests: runCount,
            reportedRequests: runCount,
            totalTokens: runCount * 10,
            usageComplete: true,
          },
        });
        send({
          sessionId,
          observedAt: '2026-11-21T01:01:00Z',
          timelineSeq: seq,
          runId: url.searchParams.get('runId') || 'run-a',
          status: 'succeeded',
          modelName: 'offline-model',
          createdAt: null,
          finishedAt: null,
          elapsedMs: null,
          lease: { expiresAt: null, expired: false },
          current: null,
          failure: null,
          execution: {
            selected: scope(1),
            recoveryChain: scope(3),
            session: scope(4),
            resumeFromRunId: url.searchParams.get('runId') === 'run-parent' ? null : 'run-parent',
            interruption: null,
          },
          steps: [],
          hasMore: false,
          runs: ['run-a', 'run-b'].map((runId) => ({
            runId,
            status: 'succeeded',
            createdAt: null,
          })),
          checkpoint: { available: false, savedAt: null, scope: 'session', continuation: 'none' },
          usage: {
            requests: null,
            reportedRequests: null,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
          },
        });
        return;
      }
      assert.ok(url.pathname.endsWith('/errors'));
      assert.equal(url.searchParams.get('pageSize'), '50');
      if (failure) {
        res.statusCode = failure;
        res.end(JSON.stringify({ success: false, resultMessage: '<b>PRIVATE_FAILURE</b>' }));
        return;
      }
      const before = url.searchParams.get('before');
      const runId = url.searchParams.get('runId');
      const filteredCount =
        url.searchParams.has('category') || url.searchParams.has('scope') ? 3 : runId ? 1 : 79;
      const snapshot: ErrorDiagnostics = {
        sessionId,
        observedAt: '2026-11-21T01:01:00Z',
        snapshotSeq: Number(url.searchParams.get('snapshotSeq') || seq),
        snapshotToken: (wrongToken ? 'b' : 'a').repeat(64),
        total: 79,
        executionErrors: 70,
        toolCorrections: 9,
        ruleFailures: 2,
        filteredTotal: filteredCount === 79 ? 81 : filteredCount,
        filteredCounts: {
          total: filteredCount,
          executionErrors: filteredCount,
          toolCorrections: 0,
          ruleFailures: filteredCount === 79 ? 2 : 0,
        },
        facets: {
          categories: { model: 70, tool: 3, rule: 2 },
          scopes: { main: 70, subagent: 3, unknown: 0 },
          runs: { 'run-a': 1, 'run-b': 1 },
          allCategories: 81,
          allScopes: 81,
          allRuns: 81,
        },
        items: before
          ? [
              row('stable-error', runId || 'run-old', 1000, url),
              row('older-error', runId || 'run-older', 900, url),
            ]
          : [row('stable-error', runId || 'run-old', 1500, url)],
        hasMore: before !== '100',
        nextBefore: before === '100' ? null : before ? 100 : 50,
        coverage: {
          complete: false,
          scannedEvents: 20000,
          limit: 20000,
          historical: 'saved_events_only',
        },
      };
      if (hold?.(url)) held.push(() => send(snapshot));
      else send(snapshot);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const { chromium } = await import(pathToFileURL(playwrightPath).href);
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.addInitScript(`Object.defineProperty(navigator, 'clipboard', {
      value: {writeText: async value => { window.copied = value; }}
    });`);
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const external: string[] = [];
    await page.route('**/*', (route: any) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    const update = (patch: Record<string, unknown>) =>
      page.evaluate((value: Record<string, unknown>) => (window as any).setFixture(value), patch);
    const errorCalls = () => requests.filter((url) => url.pathname.endsWith('/errors'));
    const region = page.getByRole('region', { name: '执行错误诊断' });
    const metrics = region.getByLabel('错误统计');
    const waitReady = () =>
      page.waitForFunction(
        () => document.querySelector('.error-diagnostics')?.getAttribute('aria-busy') === 'false',
      );
    const waitRequest = (count: number) =>
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const timer = setInterval(() => {
          if (errorCalls().length >= count) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() > deadline) {
            clearInterval(timer);
            reject(new Error('错误查询未发出'));
          }
        }, 10);
      });
    await page.goto(origin);
    assert.equal(requests.length, 0);
    await update({ open: true });
    await waitReady();
    const toggle = region.getByRole('button', { name: '执行错误', exact: true });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await region.getByRole('combobox', { name: '错误分类' }).isVisible(), false);
    const sections = await page
      .locator('[aria-label="模型用量"], [aria-label="执行错误诊断"]')
      .evaluateAll((nodes: Element[]) => nodes.map((node) => node.getAttribute('aria-label')));
    assert.deepEqual(sections, ['模型用量', '执行错误诊断']);
    await toggle.click();
    assert.equal(errorCalls()[0].searchParams.has('runId'), false);
    assert.match(
      (await region.getByRole('combobox', { name: '错误分类' }).textContent()) ?? '',
      /工具执行异常或纠正（3）/,
    );
    assert.match(
      (await region.getByRole('combobox', { name: 'Agent 范围' }).textContent()) ?? '',
      /子 Agent（3）/,
    );
    assert.equal(await region.getByRole('combobox', { name: '错误轮次' }).inputValue(), 'session');
    assert.match(await metrics.innerText(), /错误总数（不含规则未通过）\s*79/);
    assert.match(await region.innerText(), /run-old|覆盖不完整|当前列表尚未完整加载/);
    assert.equal(await region.locator('img').count(), 0);
    assert.doesNotMatch(await region.innerText(), /PRIVATE_/);
    const details = region.locator('details').first();
    await details.locator('summary').click();
    assert.equal(await details.getAttribute('open'), '');
    await region.getByRole('button', { name: '复制排查信息' }).click();
    await region.getByText('排查信息已复制', { exact: true }).waitFor();
    const copied = await page.evaluate(() => (window as any).copied);
    assert.match(copied, /sessionId: session-a/);
    assert.match(copied, /requestId: request-stable-error/);
    assert.doesNotMatch(copied, /PRIVATE_|rawStack/);
    for (const [key, expected] of [
      ['数据库错误类型', '连接池获取连接超时（SequelizeConnectionAcquireTimeoutError）'],
      ['数据库操作', '锁定任务准入记录（lease.lock_admission）'],
      ['数据库事务阶段', '提交及提交后回调（commit）'],
      ['数据库尝试次数', '3'],
      ['数据库错误码', 'ETIMEDOUT'],
      ['数据库错误编号', '1205'],
      ['SQLSTATE', 'HY000'],
    ]) {
      const fact = details.getByText(key, { exact: true }).locator('..');
      assert.equal(await fact.locator('dd').innerText(), expected);
      assert.ok(copied.includes(`${key}: ${expected}`), copied);
    }
    // 旧记录刷新后仍可展开和复制；缺失元数据不沿用上次已知原因。
    databaseDetails = undefined;
    await region.getByRole('button', { name: '刷新错误诊断', exact: true }).click();
    await waitReady();
    assert.equal(await details.getAttribute('open'), '');
    for (const key of ['数据库错误类型', '数据库操作', '数据库事务阶段', '数据库尝试次数']) {
      const fact = details.getByText(key, { exact: true }).locator('..');
      assert.equal(await fact.locator('dd').innerText(), '未记录（未知）');
    }
    await region.getByRole('button', { name: '复制排查信息' }).click();
    await page.waitForFunction(() =>
      (window as any).copied.includes('数据库错误类型: 未记录（未知）'),
    );
    const historicalCopy = await page.evaluate(() => (window as any).copied);
    for (const key of ['数据库错误类型', '数据库操作', '数据库事务阶段', '数据库尝试次数']) {
      assert.ok(historicalCopy.includes(`${key}: 未记录（未知）`), historicalCopy);
    }
    assert.doesNotMatch(
      historicalCopy + (await details.innerText()),
      /Sequelize|lease\.|ETIMEDOUT|PRIVATE_|死锁/,
    );
    databaseDetails = databaseFailure;
    await region.getByRole('button', { name: '刷新错误诊断', exact: true }).click();
    await waitReady();
    assert.equal(
      await details
        .getByText('数据库事务阶段', { exact: true })
        .locator('..')
        .locator('dd')
        .innerText(),
      '提交及提交后回调（commit）',
    );
    // 过期快照 409 保留已加载列表和已确认统计，刷新从无游标首屏开始。
    failure = 409;
    await region.getByRole('button', { name: '加载更早错误', exact: true }).click();
    await region.getByRole('alert').waitFor();
    await waitReady();
    assert.match(await metrics.innerText(), /错误总数（不含规则未通过）\s*79/);
    assert.equal(await region.locator('.error-diagnostic-record').count(), 1);
    assert.match(await region.getByRole('alert').innerText(), /快照已变化.*刷新/);
    failure = 0;
    await region.getByRole('button', { name: '刷新并重新读取错误', exact: true }).click();
    await waitReady();
    assert.equal(errorCalls().at(-1)!.searchParams.has('snapshotToken'), false);
    assert.equal(errorCalls().at(-1)!.searchParams.has('before'), false);
    // 服务端返回不同 token 时不得合并新页，也不把计数改成 0。
    wrongToken = true;
    await region.getByRole('button', { name: '加载更早错误', exact: true }).click();
    await region.getByRole('alert').waitFor();
    await waitReady();
    assert.equal(await region.locator('.error-diagnostic-record').count(), 1);
    assert.match(await metrics.innerText(), /错误总数（不含规则未通过）\s*79/);
    assert.equal(errorCalls().at(-1)!.searchParams.get('snapshotToken'), 'a'.repeat(64));
    wrongToken = false;
    await region.getByRole('button', { name: '重试加载更早错误', exact: true }).click();
    await waitReady();
    const pagination = errorCalls().at(-1)!;
    assert.equal(pagination.searchParams.get('before'), '50');
    assert.equal(pagination.searchParams.get('snapshotSeq'), '2000');
    assert.equal(pagination.searchParams.get('snapshotToken'), 'a'.repeat(64));
    assert.equal(await region.locator('.error-diagnostic-record').count(), 2);
    await region.getByRole('button', { name: '加载更早错误', exact: true }).click();
    await waitReady();
    assert.equal(errorCalls().at(-1)!.searchParams.get('before'), '100');
    assert.equal(errorCalls().at(-1)!.searchParams.get('snapshotSeq'), '2000');
    assert.equal(errorCalls().at(-1)!.searchParams.get('snapshotToken'), 'a'.repeat(64));
    assert.equal(await region.locator('.error-diagnostic-record').count(), 2);
    assert.equal(
      await region.getByRole('button', { name: '加载更早错误', exact: true }).count(),
      0,
    );
    // revision 刷新重置分页，但保留同 id 展开状态。
    seq = 2001;
    const previous = errorCalls().length;
    await update({ revision: 101 });
    await waitRequest(previous + 1);
    await waitReady();
    assert.equal(errorCalls().at(-1)!.searchParams.has('before'), false);
    assert.equal(errorCalls().at(-1)!.searchParams.has('snapshotSeq'), false);
    assert.equal(await region.locator('.error-diagnostic-record').count(), 1);
    assert.equal(await details.getAttribute('open'), '');
    await region.getByRole('combobox', { name: '错误轮次' }).selectOption('current');
    await waitRequest(previous + 2);
    await waitReady();
    assert.equal(errorCalls().at(-1)!.searchParams.get('runId'), 'run-a');
    assert.match(await metrics.innerText(), /错误总数（不含规则未通过）\s*1/);
    // 父级切换 run 后默认回到 session；不受父菜单中只有两个最近 run 的限制。
    await page.getByRole('combobox', { name: '诊断轮次', exact: true }).click();
    await page.locator('.ant-select-item-option').filter({ hasText: 'run-b' }).click();
    await waitRequest(previous + 3);
    await waitReady();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    assert.equal(await region.getByRole('combobox', { name: '错误轮次' }).inputValue(), 'session');
    assert.equal(errorCalls().at(-1)!.searchParams.has('runId'), false);
    await region.getByRole('combobox', { name: '错误轮次' }).selectOption('current');
    await waitRequest(previous + 4);
    await waitReady();
    assert.equal(errorCalls().at(-1)!.searchParams.get('runId'), 'run-b');
    // 快速切分类、主/子/未知范围，旧请求故意延迟到新结果之后返回。
    hold = (url) => url.searchParams.get('scope') === 'main';
    const raceCount = errorCalls().length;
    await region.getByRole('combobox', { name: 'Agent 范围' }).selectOption('main');
    await waitRequest(raceCount + 1);
    assert.doesNotMatch(await metrics.innerText(), /\b0\b|70/);
    await region.getByRole('combobox', { name: '错误分类' }).selectOption('tool');
    await waitRequest(raceCount + 2);
    await region.getByRole('combobox', { name: 'Agent 范围' }).selectOption('subagent');
    await waitRequest(raceCount + 3);
    await waitReady();
    assert.match(await metrics.innerText(), /错误总数（不含规则未通过）\s*3/);
    assert.match(await region.locator('.error-diagnostic-meta').innerText(), /工具执行异常或纠正/);
    assert.match(
      await region.locator('.error-diagnostic-heading').innerText(),
      /目标服务连接或响应超时/,
    );
    hold = null;
    for (const finish of held.splice(0)) finish();
    await page.waitForLoadState('networkidle');
    assert.equal(
      await region.getByRole('combobox', { name: 'Agent 范围' }).inputValue(),
      'subagent',
    );
    assert.match(
      await region.getByText('子 Agent · UI 实现', { exact: true }).innerText(),
      /子 Agent/,
    );
    await region.getByRole('combobox', { name: 'Agent 范围' }).selectOption('unknown');
    await waitRequest(raceCount + 4);
    await waitReady();
    assert.match(await region.innerText(), /归属未知 · UI 实现/);
    // 404 和 500 均不回显服务端异常，也不把统计显示成 0。
    for (const status of [404, 500]) {
      failure = status;
      await region.getByRole('button', { name: '刷新错误诊断' }).click();
      await region.getByRole('alert').waitFor();
      await waitReady();
      assert.doesNotMatch(await metrics.innerText(), /\b0\b|70/);
      assert.match(
        await region.getByRole('alert').innerText(),
        status === 404 ? /404/ : /读取失败/,
      );
      assert.doesNotMatch(await region.innerText(), /PRIVATE_FAILURE/);
    }
    failure = 0;
    await region.getByRole('button', { name: '刷新错误诊断' }).click();
    await waitReady();
    // 窄屏检查使用真实 CSS，内容不横向溢出。
    await page.setViewportSize({ width: 390, height: 844 });
    await region.scrollIntoViewIfNeeded();
    assert.ok(
      await region.evaluate(
        (element: HTMLElement) => element.scrollWidth <= element.clientWidth + 1,
      ),
    );
    const card = region.locator('.error-diagnostic-record').first();
    assert.equal(
      await card.evaluate((node: Element) => getComputedStyle(node).borderLeftWidth),
      '3px',
    );
    await page.screenshot({ path: '/tmp/diagnostic-filters-mobile.png' });
    // 刷新时关闭 Drawer：晚到结果不重挂组件；关闭期间 revision 更新也不请求。
    hold = () => true;
    const closeCount = errorCalls().length;
    await region.getByRole('button', { name: '刷新错误诊断' }).click();
    await waitRequest(closeCount + 1);
    await update({ open: false });
    await region.waitFor({ state: 'detached' });
    for (const finish of held.splice(0)) finish();
    hold = null;
    await update({ revision: 102 });
    await page.waitForLoadState('networkidle');
    assert.equal(errorCalls().length, closeCount + 1);
    // 会话切换晚到响应不能污染新 session。
    await update({ sessionId: 'session-a', open: true });
    await waitReady();
    hold = (url) => url.pathname.includes('session-a');
    const sessionCount = errorCalls().length;
    await region.getByRole('button', { name: '刷新错误诊断' }).click();
    await waitRequest(sessionCount + 1);
    await update({ sessionId: 'session-b' });
    await waitRequest(sessionCount + 2);
    await waitReady();
    for (const finish of held.splice(0)) finish();
    hold = null;
    await page.waitForLoadState('networkidle');
    await toggle.click();
    await region.locator('summary').click();
    await region.getByRole('button', { name: '复制排查信息' }).click();
    assert.match(await page.evaluate(() => (window as any).copied), /sessionId: session-b/);
    // 前序轮次不在最近10轮菜单中，仍沿只读runId查询进入，不发任何恢复或模型请求。
    const parentRead = page.waitForResponse((response: any) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith('/diagnostics') && url.searchParams.get('runId') === 'run-parent'
      );
    });
    await page.getByRole('button', { name: '查看前序轮次', exact: true }).click();
    await parentRead;
    await page.getByText('所选历史轮次 · run-parent', { exact: true }).waitFor();
    await page
      .getByRole('region', { name: '跨轮统计范围', exact: true })
      .getByText('旧记录未采集范围摘要。')
      .waitFor({ state: 'hidden' });
    assert.equal(
      requests
        .filter((url) => url.pathname.endsWith('/diagnostics'))
        .at(-1)!
        .searchParams.get('runId'),
      'run-parent',
    );
    assert.equal(await page.getByRole('button', { name: '查看前序轮次', exact: true }).count(), 0);
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.deepEqual(external, []);
  },
);
