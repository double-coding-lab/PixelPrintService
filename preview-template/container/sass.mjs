import fs from 'node:fs';
import path from 'node:path';
import * as sass from 'sass';

/** 自定义非 file: importer，仅允许读取工作区内的 Sass/CSS，禁用原生磁盘 importer。 */
export function boundedSass(root) {
  /** 拒绝文件路径越界；实际输入不能携带符号链接。 */
  function checked(filename) {
    if (!filename.startsWith(`${root}/`)) throw new Error('PREVIEW_SASS_BOUNDARY');
    return filename;
  }
  const importer = {
    canonicalize(url, context) {
      if (url.startsWith('sass:')) return null;
      if (/^(?:file:|https?:|\/\/)/i.test(url)) throw new Error('PREVIEW_SASS_BOUNDARY');
      const parent =
        context.containingUrl?.protocol === 'preview:'
          ? path.dirname(decodeURIComponent(context.containingUrl.pathname))
          : root;
      const filename = checked(
        url.startsWith('preview:')
          ? decodeURIComponent(new URL(url).pathname)
          : path.resolve(parent, url),
      );
      const directory = path.dirname(filename);
      const basename = path.basename(filename);
      const candidates = [filename, path.join(directory, `_${basename}`)];
      if (!path.extname(filename)) {
        for (const extension of ['.scss', '.sass', '.css']) {
          candidates.push(
            `${filename}${extension}`,
            path.join(directory, `_${basename}${extension}`),
          );
          candidates.push(
            path.join(filename, `index${extension}`),
            path.join(filename, `_index${extension}`),
          );
        }
      }
      const found = candidates.find((candidate) => {
        try {
          return /\.(?:scss|sass|css)$/.test(candidate) && fs.statSync(checked(candidate)).isFile();
        } catch {
          return false;
        }
      });
      return found ? new URL(`preview:${found}`) : null;
    },
    load(url) {
      const filename = checked(decodeURIComponent(url.pathname));
      return {
        contents: fs.readFileSync(filename, 'utf8'),
        syntax: filename.endsWith('.sass')
          ? 'indented'
          : filename.endsWith('.css')
            ? 'css'
            : 'scss',
      };
    },
  };
  return {
    name: 'pixelprint-bounded-sass',
    enforce: 'pre',
    async transform(source, id) {
      const filename = id.split('?')[0];
      if (!/\.(scss|sass)$/.test(filename)) return;
      checked(filename);
      let result;
      try {
        result = await sass.compileStringAsync(source, {
          url: new URL(`preview:${filename}`),
          importer,
          importers: [importer],
          loadPaths: [],
          syntax: filename.endsWith('.sass') ? 'indented' : 'scss',
          logger: sass.Logger.silent,
        });
      } catch (error) {
        // 将 Sass 的零基定位转换为编译协议；源码与原始异常只保留在 cause 中。
        const span = error?.span;
        const file = span?.url?.protocol === 'preview:'
          ? checked(decodeURIComponent(span.url.pathname))
          : filename;
        const failed = new Error('PREVIEW_STYLE_COMPILE_FAILED', { cause: error });
        failed.pluginCode = /^Undefined variable[.]/.test(error?.sassMessage ?? '')
          ? 'SASS_UNDEFINED_VARIABLE'
          : 'PARSE_ERROR';
        failed.id = file;
        if (Number.isInteger(span?.start?.line) && Number.isInteger(span?.start?.column))
          failed.loc = { file, line: span.start.line + 1, column: span.start.column };
        throw failed;
      }
      // Vite's CSS preprocessor sees plain CSS here; it cannot load user Sass imports again.
      return { code: result.css, map: null };
    },
  };
}
