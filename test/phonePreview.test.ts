import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { phoneViewports, phoneViewportScale } from '../web/src/workspace/phoneViewport';

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
