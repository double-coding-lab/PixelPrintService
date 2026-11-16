import path from 'node:path';

const moduleId = '\0pixelprint-preview-rpx';
const source = `import { Dimensions } from 'react-native';
const DESIGN_BASE = 375;
export const screenWidth = Dimensions.get('window').width || DESIGN_BASE;
export const scale = screenWidth / DESIGN_BASE;
/** 与固定 RN 模板一致：在模块加载时按屏宽缩放设计稿数值。 */
export function rpx(size) { return size * scale; }
export default rpx;
`;

/** 仅为 RN 的固定 helper 路径补缺；真实源码始终交由 Vite 优先解析。 */
export function createPreviewRpxCompatibility(target, aliasRoot) {
  return {
    alias:
      target === 'rn'
        ? [
            {
              find: /^@\/utils\/rpx$/,
              replacement: path.join(aliasRoot, 'utils/rpx'),
              async customResolver(id, importer, options) {
                const resolved = await this.resolve(id, importer, { ...options, skipSelf: true });
                return resolved || { id: moduleId };
              },
            },
          ]
        : [],
    plugin: {
      name: 'pixelprint-preview-rpx',
      load(id) {
        if (target === 'rn' && id === moduleId) return source;
      },
    },
  };
}
