import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const publicScopes = new Set([
  '@tarojs',
  '@react-native',
  '@react-native-community',
  '@fontsource',
  '@types',
]);
const publicHosts = [
  'github.com',
  'githubusercontent.com',
  'figma.com',
  'figmausercontent.com',
  'npmjs.org',
  'jsdelivr.net',
  'unpkg.com',
  'googleapis.com',
  'gstatic.com',
  'example.com',
];

/** 上游模板仅保留可公开使用的适配，未知域名示例转换为待用户补充的资源地址。 */
export async function sanitizeResources(root) {
  const presets = path.join(root, 'templates/adapter-presets');
  for (const name of await fs.readdir(presets)) {
    if (
      ![
        'README.md',
        'rn.json',
        'rn.rpx.ts',
        'rn.reference.md',
        'taro.json',
        'taro.rpx.ts',
        'taro.reference.md',
      ].includes(name)
    ) {
      await fs.rm(path.join(presets, name), { recursive: true, force: true });
    }
  }
  await fs.writeFile(
    path.join(root, 'templates/code-connect/mappings.json'),
    '{"components":[]}\n',
  );
  /** 逐个普通文本文件规范示例；上游更新器已拒绝符号链接。 */
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else if (/\.(md|json|[cm]?js|ts|tsx|scss|css|txt)$/.test(entry.name)) {
        let text = await fs.readFile(filename, 'utf8');
        text = text
          .split('\n')
          .filter((line) => {
            const scopes = [...line.matchAll(/(@[a-z][\w-]*)\/[\w./-]+/gi)];
            return scopes.every((match) => publicScopes.has(match[1]));
          })
          .join('\n');
        text = text.replace(/https?:\/\/[^\s'"`<>|)\]]+/gi, (value) => {
          try {
            const url = new URL(value);
            if (
              publicHosts.some((host) => url.hostname === host || url.hostname.endsWith('.' + host))
            )
              return value;
            return url.pathname.includes('/fonts/')
              ? '/fonts/' + path.posix.basename(url.pathname)
              : 'https://assets.example.com/';
          } catch {
            return value;
          }
        });
        if (entry.name === 'SKILL.md') {
          const note =
            '> 通用发行版字体约定：字体资源仅使用用户提供的真实可访问地址。未配置字体时使用系统回退；/fonts/ 和 example.com 均为示例，禁止当作已存在的远程资源。';
          // 兼容旧发行包：YAML frontmatter必须位于文首，说明放在闭合分隔符后。
          text = text.replace(/^> 通用发行版字体约定[^\n]*\r?\n(?:\r?\n)?/, '');
          if (!text.includes('通用发行版字体约定')) {
            const header = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
            text = header
              ? header[0] +
                '\n' +
                note +
                '\n\n' +
                text.slice(header[0].length).replace(/^\r?\n/, '')
              : note + '\n\n' + text;
          }
        }
        await fs.writeFile(filename, text);
      }
    }
  }
  await walk(root);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await sanitizeResources(path.resolve(process.argv[2] || 'pixelprint'));
}
