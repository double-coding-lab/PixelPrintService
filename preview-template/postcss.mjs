import pxToViewport from 'postcss-px-to-viewport-8-plugin';

/** H5预览始终将CSS中的px转为vw；源码输出单位不控制预览适配，RN保持原有缩放。 */
export function createPreviewPostcssPlugins(target, _unit, base) {
  if (target !== 'h5') return [];
  return [
    pxToViewport({
      unitToConvert: 'px',
      viewportWidth: base,
      unitPrecision: 8,
      propList: ['*'],
      viewportUnit: 'vw',
      fontViewportUnit: 'vw',
      selectorBlackList: [],
      minPixelValue: 0,
      mediaQuery: true,
      replace: true,
      exclude: /node_modules/,
      landscape: false,
    }),
  ];
}
