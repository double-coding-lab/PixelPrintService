import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sample = '中文预览截图验证';

/** Linux 必须存在覆盖测试中文字形的系统字体；缺字时阻止发布准备成功。 */
export function assertChineseFontCoverage(platform = process.platform) {
  if (platform !== 'linux') return null;
  const charset = [...sample].map((char) => char.codePointAt(0).toString(16)).join(' ');
  let fonts;
  try {
    fonts = execFileSync('fc-list', [`:charset=${charset}`, 'family'], {
      encoding: 'utf8',
      timeout: 10000,
    });
  } catch {
    throw new Error('CHINESE_FONT_CHECK_FAILED: require fontconfig and Noto CJK fonts');
  }
  if (!fonts.trim()) throw new Error('CHINESE_FONT_MISSING: install Noto CJK fonts');
  return new Set(
    fonts
      .split(/[\n,]/)
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

/** 使用实际 Chromium 渲染中文并检查字体使用记录，不依赖 CSS 字体名或 fonts.ready 判定缺字。 */
export async function verifyChineseFonts(page) {
  const coveredFamilies = assertChineseFontCoverage();
  await page.setContent(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><p id="cjk" style="font-family:system-ui,sans-serif;font-size:24px">${sample}</p><p>PixelPrint 123</p></html>`,
  );
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument');
    const { nodeId } = await session.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '#cjk',
    });
    const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
    const used = fonts.filter((font) => font.glyphCount > 0);
    if (
      used.reduce((count, font) => count + font.glyphCount, 0) < [...sample].length ||
      (coveredFamilies && used.some((font) => !coveredFamilies.has(font.familyName)))
    )
      throw new Error('CHINESE_FONT_RENDER_FAILED');
    await page.screenshot();
    console.log(`Chinese screenshot check OK: ${used.map((font) => font.familyName).join(', ')}`);
  } finally {
    await session.detach();
  }
}

/** 部署镜像内以正式运行账号验证；本地准备脚本复用同一方法。 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: false, timeout: 20000 });
  try {
    await verifyChineseFonts(await browser.newPage());
  } finally {
    await browser.close();
  }
}
