import path from 'node:path';
import { normalizeRelativePath } from '../utils/paths';

/** 从固定配置与稳定文件生成本轮唯一的输出约定；历史产物不因默认值被搬迁。 */
export function generationPlan(
  config: {
    project?: { framework?: string };
    output?: { dir?: string };
    images?: { assetsDir?: string };
    merge?: { mode?: string };
  },
  files: string[],
) {
  const outputRoot = normalizeRelativePath(config.output?.dir ?? 'pages');
  const imageRoot = normalizeRelativePath(config.images?.assetsDir ?? 'static');
  const candidates = files.filter(
    (file) => !file.split('/').includes('blocks') && !file.startsWith('.'),
  );
  const jsx = candidates.filter((file) => /\.[jt]sx$/.test(file));
  const inOutput = jsx.filter((file) => file.startsWith(outputRoot + '/'));
  const entries = (
    inOutput.length
      ? inOutput
      : jsx.length
        ? jsx
        : candidates.filter((file) => /(?:^|\/)(?:index|page|App)\.js$/.test(file))
  ).map((file) => path.posix.dirname(file));
  const directories = [...new Set(entries)]
    .sort()
    .filter(
      (dir, _, all) =>
        !all.some((parent) => parent !== dir && (parent === '.' || dir.startsWith(parent + '/'))),
    );
  const pageDirectory = directories.length === 1 ? directories[0] : `${outputRoot}/home`;
  const pagePrefix = pageDirectory === '.' ? '' : pageDirectory + '/';
  return [
    '[平台输出约定]',
    `固定配置 output.dir=${outputRoot}/；images.assetsDir=${imageRoot}/；merge.mode=${config.merge?.mode ?? 'flat'}。`,
    directories.length > 1
      ? `当前已有多个页面目录：${directories.join('、')}。按用户指定目标沿用对应目录，不自动新增home或迁移其他页面。`
      : `本轮页面目录：${pageDirectory === '.' ? '当前会话根目录' : pagePrefix}；区块目录统一为 ${pagePrefix}blocks/<英文别名>/，不能误写为 ${outputRoot}/blocks/。`,
    `默认切图slug为page，图片目录及CDN地址以prepare_slices回执为准，不能由代码目录推算图片URL。`,
    directories.length
      ? '这是已有产物的持续修改：沿用现有入口、import与组件组织，不为了改成默认merge.mode重新拆分或平铺。用户明确要求改变结构时才调整。'
      : '首次生成须在出码前确定目录和merge.mode，并将同一约定传给每个子Agent及writePaths；flat使用区块中间产物时，目录仍位于页面目录内，最后按既定模式合并，不中途切换。',
    '此约定提供生成默认值，不覆盖用户本轮明确指定的目录或结构要求；如需调整，先更新执行清单和后续委派路径，再写对应文件。',
  ].join('\n');
}
