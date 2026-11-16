import type { AcceptedPlugin } from 'postcss';

/** H5与RN模板共用的PostCSS插件选择配置。 */
export function createPreviewPostcssPlugins(
  target: 'h5' | 'rn',
  unit: 'px' | 'vw',
  base: number,
): AcceptedPlugin[];
