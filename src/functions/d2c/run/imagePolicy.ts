import { projectConfig } from '@/config/project';

/** 主、子 Agent 共用的平台图片契约，优先于固定 Skill 的本地 PP 地址公式。 */
export const platformImageInstructions =
  '平台图片地址：prepare_slices.assetUrls返回.d2c-cache/<设计稿fileKey>/asset-urls.json；生成前用read_file(resource=false)读images的相对路径→真实URL。地址表由平台维护，只读；替代 Skill §4.4 及其他章节的 imageBaseUrl + assetsDir + filename 本地PP前缀拼接公式。固定Skill中的ASSET_PREFIX、$asset-prefix示例不是平台地址。只能使用部署存储配置对应的真实上传URL；本地存储可使用本站 /files 地址，不能把本地static目录追加到上传URL。H5 JSX/TSX用统一映射、SCSS用每张图的完整URL变量；RN使用完整uri字面量。只能引用地址表中已登记的完整URL，不自行猜测前缀、文件名或上传目录；没有地址先报告缺图。已有源码和rule-hits中的本地图片示例也须以当前地址表为准。保留本地图片及清单验规。';

/** 仅投影模型读取的配置，固定快照与脚本输入保持原样以便摘要和规则复核。 */
export function modelImageConfig(config: Record<string, unknown>) {
  const images = config.images;
  if (!images || typeof images !== 'object' || Array.isArray(images)) return config;
  const { imageBaseUrl: _localPrefix, ...rest } = images as Record<string, unknown>;
  return { ...config, images: rest };
}

/** 检测源码中的本地图片地址；本地业务 API、相对图片和合法远端地址保持可用。 */
export function hasLocalImageUrl(relative: string, content: string): boolean {
  if (!/\.(?:[cm]?[jt]sx?|css|scss|sass|less|styl|html|vue|svelte)$/i.test(relative)) return false;
  const urls = content.match(/https?\\?:\\?\/\\?\/[^\s'"`<>)}]+/g) ?? [];
  return urls.some((raw) => {
    try {
      const url = new URL(raw.replace(/\\([:/])/g, '$1'));
      const configured = new URL(projectConfig.storage.publicUrl.replace(/\/?$/, '/'));
      if (url.origin === configured.origin && url.pathname.startsWith(configured.pathname))
        return false;
      const local =
        url.hostname === 'localhost' ||
        url.hostname.endsWith('.localhost') ||
        /^127\./.test(url.hostname) ||
        ['[::1]', '0.0.0.0'].includes(url.hostname);
      return (
        local &&
        /(?:\/(?:static|assets|images)(?:\/|$)|\/webapp\/|\.(?:png|jpe?g|svg|webp|gif|avif|ico)(?:$|[?#]))/i.test(
          url.pathname,
        )
      );
    } catch {
      return false;
    }
  });
}
