import assert from 'node:assert/strict';
import test from 'node:test';
import {
  phoneViewports,
  phoneViewportScale,
  previewViewportLayout,
} from '../web/src/workspace/phoneViewport';

test('常见手机视口包含竖屏与全面屏尺寸且标识唯一', () => {
  assert.equal(new Set(phoneViewports.map((item) => item.id)).size, phoneViewports.length);
  for (const device of phoneViewports) {
    assert.ok(device.width >= 320 && device.width <= 450);
    assert.ok(device.height > device.width);
  }
  assert.ok(phoneViewports.some((item) => item.width === 390 && item.height === 844));
  assert.ok(phoneViewports.some((item) => item.width === 360 && item.height === 800));
});

test('等比适应容器并预留边距，不改变真实视口或放大小图', () => {
  assert.equal(phoneViewportScale(1000, 1200, 390, 844), 1);
  const scale = phoneViewportScale(600, 700, 390, 844);
  assert.ok(Math.abs(scale - 668 / 844) < 0.00001);
  assert.ok(390 * scale <= 568 && 844 * scale <= 668);
  const landscape = phoneViewportScale(650, 400, 844, 390);
  assert.ok(844 * landscape <= 618 && 390 * landscape <= 368);
  assert.equal(phoneViewportScale(0, 0, 390, 844), 0.01);
  assert.equal(phoneViewportScale(NaN, 900, 390, 844), 1);
});

test('固定视口百分比缩放保持真实布局，100%不自动缩小，自动适应才计算缩放', () => {
  assert.deepEqual(previewViewportLayout(500, 600, 'standard', 1), {
    width: 390,
    height: 844,
    scale: 1,
  });
  assert.deepEqual(previewViewportLayout(500, 600, 'standard', 0.5), {
    width: 390,
    height: 844,
    scale: 0.5,
  });
  assert.deepEqual(previewViewportLayout(500, 600, 'standard', 2), {
    width: 390,
    height: 844,
    scale: 2,
  });
  assert.ok(previewViewportLayout(500, 600, 'standard', 'fit').scale < 1);
});

test('适合窗口的响应式视口随可用区域及缩放计算，显示范围始终填满窗口', () => {
  assert.deepEqual(previewViewportLayout(532, 632, 'responsive', 1), {
    width: 500,
    height: 600,
    scale: 1,
  });
  assert.deepEqual(previewViewportLayout(532, 632, 'responsive', 0.5), {
    width: 1000,
    height: 1200,
    scale: 0.5,
  });
  assert.deepEqual(previewViewportLayout(732, 932, 'responsive', 'fit'), {
    width: 700,
    height: 900,
    scale: 1,
  });
});
