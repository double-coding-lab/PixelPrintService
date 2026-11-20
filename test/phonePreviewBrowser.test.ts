import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { build } from 'esbuild';

const chrome = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
].find((path): path is string => !!path && existsSync(path));

test(
  '真实浏览器：手机尺寸、旋转、原生及降级全屏、退出和iframe保留',
  { skip: !chrome || process.env.PIXELPRINT_BROWSER_TESTS !== '1', timeout: 60000 },
  async (t) => {
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import PhonePreview,{PhonePreviewButton,usePhonePreview}from'./web/src/workspace/PhonePreview';
    import{SessionPreviewFrames}from'./web/src/workspace/SessionPreviewPanel';
    function Fixture(){const[available,setAvailable]=useState(true);const phone=usePhonePreview(available);window.disablePreview=()=>setAvailable(false);
      return <section className="session-preview"><PhonePreviewButton preview={phone}/><PhonePreview preview={phone}><SessionPreviewFrames width={375} shown={{url:'/phone',expiresAt:'2099-01-01',preview:{}} as any} incoming={null} onReady={()=>{}}/></PhonePreview></section>}
    window.frameData={};window.addEventListener('message',e=>{if(e.source===document.querySelector('iframe')?.contentWindow)window.frameData=e.data;});
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `,
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    const styles = (
      await Promise.all(
        ['phonePreview.css', 'sessionFeedback.css', 'previewPanel.css'].map((file) =>
          readFile(`web/src/workspace/${file}`, 'utf8'),
        ),
      )
    )
      .join('\n')
      .replace(/^@import.*;$/gm, '');
    let frameLoads = 0;
    const server = createServer((req, res) => {
      if (req.url === '/app.js') {
        res.setHeader('Content-Type', 'text/javascript');
        return res.end(bundle.outputFiles[0].text);
      }
      if (req.url === '/phone') {
        frameLoads++;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(
          `<style>body{margin:0;font-family:system-ui;background:#f5f7fb}header{padding:36px 24px;background:linear-gradient(130deg,#3157ce,#689cf1);color:white}main{padding:24px}article{padding:24px;background:white;border-radius:12px;margin-bottom:18px}</style><header><small>PIXELPRINT PREVIEW</small><h1>手机全屏预览</h1><p>按真实视口检查布局</p></header><main><article>页面交互会保留</article><article style="height:900px">在手机视口内滚动查看内容</article></main><script>let counter=0;const report=()=>parent.postMessage({width:innerWidth,height:innerHeight,counter},'*');addEventListener('resize',report);addEventListener('message',e=>{if(e.data==='increment')counter++;report()});report();</script>`,
        );
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        `<style>body{margin:0;font-family:system-ui;overflow:auto}${styles}</style><div id="root"></div><script src="/app.js"></script>`,
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const port = (server.address() as { port: number }).port;
    const profile = await mkdtemp(join(tmpdir(), 'pixelprint-phone-ui-'));
    const child = spawn(
      chrome!,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    t.after(async () => {
      child.kill('SIGKILL');
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Chrome启动超时')), 20000);
      child.stderr.on('data', (data) => {
        output += String(data);
        const found = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (found) {
          clearTimeout(timer);
          resolve(found[1]);
        }
      });
      child.once('error', reject);
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Chrome退出'));
      });
    });
    const socket = new WebSocket(endpoint);
    await once(socket, 'open');
    t.after(() => socket.close());
    let sequence = 0;
    const pending = new Map<
      number,
      { resolve: (value: any) => void; reject: (error: unknown) => void }
    >();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const item = pending.get(message.id);
      if (item) {
        pending.delete(message.id);
        if (message.error) item.reject(message.error);
        else item.resolve(message.result);
      }
    });
    function command(method: string, params: object = {}, sessionId?: string) {
      return new Promise<any>((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    }
    const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    async function evaluate<T = unknown>(expression: string): Promise<T> {
      const value = await command(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (value.exceptionDetails)
        throw new Error(
          value.exceptionDetails.exception?.description ?? value.exceptionDetails.text,
        );
      return value.result.value as T;
    }
    async function wait(expression: string) {
      await evaluate(
        `(async()=>{for(let i=0;i<150;i++){if(${expression})return;await new Promise(r=>setTimeout(r,20));}throw new Error('等待失败: '+${JSON.stringify(expression)}+' '+document.body.innerText)})()`,
      );
    }
    async function click(text: string, native = false) {
      const selector = `[...document.querySelectorAll('button')].find(e=>e.textContent.replace(/\\s/g,'')===${JSON.stringify(text)}&&!e.disabled&&e.getClientRects().length)`;
      if (native) {
        const point = await evaluate<{ x: number; y: number }>(
          `(()=>{const r=${selector}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        );
        await command(
          'Input.dispatchMouseEvent',
          { type: 'mousePressed', ...point, button: 'left', clickCount: 1 },
          sessionId,
        );
        await command(
          'Input.dispatchMouseEvent',
          { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 },
          sessionId,
        );
      } else await evaluate(`${selector}.click()`);
    }
    await command(
      'Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    await command('Page.navigate', { url: `http://127.0.0.1:${port}/` }, sessionId);
    await wait('window.frameData?.width===375');
    await evaluate(
      `window.originalFrame=document.querySelector('iframe');originalFrame.contentWindow.postMessage('increment','*')`,
    );
    await wait('window.frameData.counter===1');
    await click('全屏预览', true);
    await wait(
      `!!document.querySelector('[aria-label="全屏手机预览"]')&&window.frameData.width===390&&window.frameData.height===844`,
    );
    assert.equal(
      await evaluate('document.fullscreenElement===document.querySelector(".phone-preview-shell")'),
      true,
    );
    assert.equal(await evaluate('document.querySelector("iframe")===window.originalFrame'), true);
    assert.equal(await evaluate('window.frameData.counter'), 1);
    const dimensions = await evaluate<{
      width: number;
      height: number;
      scale: number;
      outerWidth: number;
      outerHeight: number;
    }>(
      `(()=>{const e=document.querySelector('.phone-preview-device'),r=e.getBoundingClientRect();return{width:document.querySelector('iframe').offsetWidth,height:document.querySelector('iframe').offsetHeight,scale:r.width/390,outerWidth:innerWidth,outerHeight:innerHeight}})()`,
    );
    assert.equal(dimensions.width, 390);
    assert.equal(dimensions.height, 844);
    assert.ok(dimensions.scale > 0 && dimensions.scale <= 1);
    await evaluate('document.exitFullscreen()');
    await wait(
      `!document.querySelector('[aria-label="全屏手机预览"]')&&window.frameData.width===375`,
    );
    assert.equal(await evaluate('document.body.style.overflow'), '');
    await evaluate(
      `document.querySelector('.phone-preview-shell').requestFullscreen=()=>Promise.reject(new Error('denied'));document.querySelector('button').focus()`,
    );
    await click('全屏预览');
    await wait(
      'document.querySelector(".phone-preview-shell").classList.contains("is-fullscreen")',
    );
    await evaluate(
      `const select=document.querySelector('[aria-label="手机屏幕比例"]');select.value='android';select.dispatchEvent(new Event('change',{bubbles:true}))`,
    );
    await wait('window.frameData.width===360&&window.frameData.height===800');
    await click('切为横屏');
    await wait('window.frameData.width===800&&window.frameData.height===360');
    assert.equal(
      await evaluate('document.querySelector("iframe").getAttribute("sandbox")'),
      'allow-scripts',
    );
    assert.equal(await evaluate('window.frameData.counter'), 1);
    assert.equal(frameLoads, 1);
    await click('切为竖屏');
    await wait('window.frameData.height===800');
    const screenshot = await command('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile('/tmp/pixelprint-phone-preview.png', Buffer.from(screenshot.data, 'base64'));
    await evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
    );
    await wait(
      '!document.querySelector(".phone-preview-shell").classList.contains("is-fullscreen")',
    );
    assert.equal(
      await evaluate('document.activeElement.textContent.replace(/\\s/g,"")'),
      '全屏预览',
    );
    assert.equal(await evaluate('window.frameData.counter'), 1);
    await click('全屏预览');
    await wait(
      'document.querySelector(".phone-preview-shell").classList.contains("is-fullscreen")',
    );
    await evaluate('window.disablePreview()');
    await wait(
      '!document.querySelector(".phone-preview-shell").classList.contains("is-fullscreen")',
    );
    assert.equal(frameLoads, 1);
  },
);
