import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseWorkspaceConfigs, type WorkspaceConfigs } from '../utils/config';
import { normalizeRelativePath } from '../utils/paths';

export interface ResourceFile {
  path: string;
  content: string;
}
export interface ResourceBundle {
  format: 1;
  files: ResourceFile[];
  hash: string;
  sourceVersion: string;
  sourceCommit: string;
  defaultConfigs: WorkspaceConfigs;
}

/** 定位对象由真实持久存储实现提供，不包含上传凭据；不能指向临时本地目录。 */
export type ResourceBundleLocator = Record<string, unknown>;

/** save 必须持久化完整包；load 必须在重部署后仍能恢复相同字节。 */
export interface ResourceBundleStore {
  save(
    bundle: ResourceBundle,
    context: { workspaceId: string; resourceRevisionId: string },
  ): Promise<ResourceBundleLocator>;
  load(locator: ResourceBundleLocator): Promise<ResourceBundle>;
}

/** 按路径和原始字节计算稳定摘要，不使用文件时间戳或平台遍历顺序。 */
function bundleHash(files: ResourceFile[]) {
  const hash = createHash('sha256');
  for (const file of files) {
    const content = Buffer.from(file.content, 'base64');
    hash.update(JSON.stringify([file.path, content.length]) + '\n');
    hash.update(content);
  }
  return hash.digest('hex');
}

/**
 * 校验并规范化完整模板资源包，路径、编码、必需脚本及 H5/RN 配置缺一即失败。
 * 文件按路径稳定排序，版本信息及默认配置从包内文件解析，摘要按原始字节重算。
 * @param value 从发布目录收集或从对象存储恢复的资源包，不信任其声明的 hash。
 * @returns 带可信摘要、版本和默认配置的资源副本，不执行包内脚本。
 */
export function validateResourceBundle(
  value: Pick<ResourceBundle, 'format' | 'files'> & { hash?: string },
): ResourceBundle {
  if (value?.format !== 1 || !Array.isArray(value.files) || !value.files.length)
    throw new Error('模板资源包格式无效');
  const seen = new Set<string>();
  const files = value.files
    .map((file) => {
      if (typeof file?.path !== 'string' || typeof file.content !== 'string')
        throw new Error('模板资源文件无效');
      const relative = normalizeRelativePath(file.path);
      if (relative !== file.path || seen.has(relative)) throw new Error('模板资源路径重复或不规范');
      seen.add(relative);
      if (Buffer.from(file.content, 'base64').toString('base64') !== file.content)
        throw new Error('模板资源编码无效');
      return { path: relative, content: file.content };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of files) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++)
      if (seen.has(parts.slice(0, i).join('/'))) throw new Error('模板资源路径冲突');
  }
  /** 必需资源必须实际存在且非空，避免只保存 SKILL 而漏掉执行与校验脚本。 */
  function text(relative: string) {
    const file = files.find((item) => item.path === relative);
    if (!file || !file.content) throw new Error(`缺少模板资源：${relative}`);
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(file.content, 'base64'));
  }
  for (const skill of ['pp-d2c', 'pp-d2c-rn']) {
    const prefix = `templates/skills/${skill}`;
    text(`${prefix}/SKILL.md`);
    text(`${prefix}/bin/figma.mjs`);
    text(`${prefix}/bin/check-rules.mjs`);
    if (
      !files.some(
        (file) =>
          file.path.startsWith(`${prefix}/rules/`) && file.path.endsWith('.md') && file.content,
      ) ||
      !files.some(
        (file) =>
          file.path.startsWith(`${prefix}/bin/rules/`) &&
          file.path.endsWith('.mjs') &&
          file.content,
      )
    ) {
      throw new Error(`缺少模板规则：${skill}`);
    }
  }
  /** 两种生成 Skill 共用正式切图契约，固定副本必须携带完整依赖。 */
  text('templates/skills/pp-d2c-reskin/reskin-slice.mjs');
  text('templates/skills/pp-d2c-reskin/SLICE-CONTRACT.md');
  const version = JSON.parse(text('VERSION.json'));
  if (
    typeof version.version !== 'string' ||
    !version.version.trim() ||
    version.version.length > 64 ||
    typeof version.sourceRevision !== 'string' ||
    !/^[a-f0-9]{40,64}$/i.test(version.sourceRevision)
  )
    throw new Error('模板版本元数据无效');
  const defaultConfigs = parseWorkspaceConfigs({
    h5: JSON.parse(text('templates/pp-d2c.config.json')),
    rn: JSON.parse(text('templates/pp-d2c.rn.config.json')),
  });
  const hash = bundleHash(files);
  if (value.hash !== undefined && value.hash !== hash) throw new Error('模板资源摘要不匹配');
  return {
    format: 1,
    files,
    hash,
    sourceVersion: version.version,
    sourceCommit: version.sourceRevision,
    defaultConfigs,
  };
}

/**
 * 读取发布携带的完整 pixelprint 目录，供创建工作区和显式模板升级使用。
 * 检查目录祖先及文件的符号链接，读取前后复核文件身份和时间，拒绝读取中被替换的资源。
 * @param root 本项目携带的模板根目录。
 * @param platformSkillsRoot 可选平台扩展目录；显式指定时必须存在，缺省skills目录存在时一并冻结。
 * @returns 校验通过的内存资源包；持久化由 ResourceBundleStore 负责。
 */
export async function readTemplateResources(
  root: string,
  platformSkillsRoot?: string,
): Promise<ResourceBundle> {
  const roots = [path.resolve(root)];
  const extensions = path.resolve(platformSkillsRoot ?? 'skills');
  // 社区发行包可以只携带核心模板；显式扩展路径与其他读取错误仍严格校验。
  try {
    await fs.lstat(extensions);
    roots.push(extensions);
  } catch (error) {
    if (platformSkillsRoot !== undefined || (error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error;
  }
  for (const absolute of roots) {
    let ancestor = path.parse(absolute).root;
    for (const segment of absolute.slice(ancestor.length).split(path.sep).filter(Boolean)) {
      ancestor = path.join(ancestor, segment);
      if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new Error('模板目录不能包含符号链接');
    }
  }
  const files: ResourceFile[] = [];
  /** 递归收集全部普通文件，包括脚本依赖与参考文档，拒绝链接和特殊设备。 */
  async function walk(directory: string, prefix: string) {
    const before = await fs.lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('模板目录无效');
    for (const name of (await fs.readdir(directory)).sort()) {
      const relative = normalizeRelativePath(prefix ? `${prefix}/${name}` : name);
      const filename = path.join(directory, name);
      const info = await fs.lstat(filename);
      if (info.isSymbolicLink()) throw new Error('模板资源不能包含符号链接');
      if (info.isDirectory()) await walk(filename, relative);
      else if (info.isFile()) {
        const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev)
            throw new Error('模板资源读取时发生变化');
          const content = await handle.readFile();
          const after = await handle.stat();
          if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
            throw new Error('模板资源读取时发生变化');
          files.push({ path: relative, content: content.toString('base64') });
        } finally {
          await handle.close();
        }
      } else throw new Error('模板资源必须为普通文件');
    }
    const after = await fs.lstat(directory);
    if (after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs)
      throw new Error('模板目录读取时发生变化');
  }
  await walk(roots[0], '');
  /** 平台Skill随工作区资源一起冻结，独立于上游同步目录，升级时才替换。 */
  if (roots[1]) await walk(roots[1], 'platform-skills');
  // 新资源包采用平台的 RN 输出默认值；旧冻结包仍按原字节验证和恢复。
  // 仅归一上游的标准默认目录，自定义根目录保持原值。
  const rnTemplate = files.find((file) => file.path === 'templates/pp-d2c.rn.config.json');
  if (rnTemplate) {
    const config = JSON.parse(Buffer.from(rnTemplate.content, 'base64').toString('utf8'));
    if (config.project?.framework === 'rn' && /^src\/pages\/?$/.test(config.output?.dir ?? '')) {
      config.output.dir = 'pages/';
      rnTemplate.content = Buffer.from(JSON.stringify(config, null, 2) + '\n').toString('base64');
    }
  }
  return validateResourceBundle({ format: 1, files });
}
