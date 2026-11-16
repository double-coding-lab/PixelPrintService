import assert from 'node:assert/strict';
import postcss from 'postcss';
import test from 'node:test';
import { createPreviewPostcssPlugins } from '../postcss.mjs';

/** 验证实际第三方插件，而非仅比对选项；保留字符串、URL与现有vw。 */
test('H5第三方PostCSS插件转换媒体查询内样式，保留断点、已有vw、URL与字符串', async () => {
  const input =
    '@media(min-width:375px){.page{width:75px;padding:1px;font-size:15px;content:"75px";background:url("75px.png");margin:2vw}}';
  const plugins = createPreviewPostcssPlugins('h5', 'vw', 375);
  assert.equal(plugins[0].postcssPlugin, 'postcss-px-to-viewport');
  const result = await postcss(plugins).process(input, { from: '/workspace/page.scss' });
  assert.match(result.css, /min-width:375px/);
  assert.match(result.css, /width:20vw/);
  assert.match(result.css, /padding:0\.26666667vw/);
  assert.match(result.css, /font-size:4vw/);
  assert.match(result.css, /content:"75px"/);
  assert.match(result.css, /url\("75px.png"\)/);
  assert.match(result.css, /margin:2vw/);
  const wider = await postcss(createPreviewPostcssPlugins('h5', 'vw', 750)).process(
    '.page{width:75px}',
    { from: '/workspace/page.css' },
  );
  assert.match(wider.css, /width:10vw/);
});

/** RN的StyleSheet/rpx不走此插件，RN-Web内部样式也不被二次换算。 */
test('RN不启用单位插件，H5不转换依赖CSS', async () => {
  for (const [target, unit] of [
    ['rn', 'vw'],
    ['rn', 'px'],
  ]) {
    const plugins = createPreviewPostcssPlugins(target, unit, 375);
    assert.equal(plugins.length, 0);
    assert.equal(
      (await postcss(plugins).process('.page{width:75px}', { from: undefined })).css,
      '.page{width:75px}',
    );
  }
  const dependency = await postcss(createPreviewPostcssPlugins('h5', 'vw', 375)).process(
    '.vendor{width:75px}',
    { from: '/workspace/node_modules/vendor/style.css' },
  );
  assert.match(dependency.css, /width:75px/);
});

/** PixelPrint默认输出750基准的px源码，预览应转换为vw而不修改冻结源码。 */
test('H5 px源码仍转换为vw，750基准与现有vw保持正确', async () => {
  const plugins = createPreviewPostcssPlugins('h5', 'px', 750);
  const result = await postcss(plugins).process(
    '.page{width:750px;height:150px;font-size:28px;margin:2vw;background:url("750px.png")}',
    { from: '/workspace/page.scss' },
  );
  assert.match(result.css, /width:100vw/);
  assert.match(result.css, /height:20vw/);
  assert.match(result.css, /font-size:3\.73333333vw/);
  assert.match(result.css, /margin:2vw/);
  assert.match(result.css, /url\("750px.png"\)/);
});
