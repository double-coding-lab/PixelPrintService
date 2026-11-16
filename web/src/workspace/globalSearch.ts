export type SearchFile = { path: string; content: string };
export type SearchOptions = { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean };
export type SearchMatch = {
  path: string;
  line: number;
  column: number;
  length: number;
  snippet: string;
  snippetColumn: number;
};
export type SearchGroup = { path: string; matches: SearchMatch[] };
export type SearchResults = {
  groups: SearchGroup[];
  count: number;
  truncated: boolean;
  error?: string;
};
export type EditorReveal = Pick<SearchMatch, 'path' | 'line' | 'column' | 'length'> & {
  requestId: number | string;
};

export const SEARCH_LIMITS = {
  results: 500,
  fileCharacters: 2_000_000,
  totalCharacters: 8_000_000,
  files: 2000,
  queryCharacters: 1000,
  timeoutMs: 1500,
};

/** 在发送 Worker 前限制克隆体积；长度以 Monaco 使用的 UTF-16 单位计。 */
export function prepareSearchFiles(files: SearchFile[]): {
  files: SearchFile[];
  truncated: boolean;
} {
  const prepared: SearchFile[] = [];
  let remaining = SEARCH_LIMITS.totalCharacters;
  let truncated = files.length > SEARCH_LIMITS.files;
  for (const file of files.slice(0, SEARCH_LIMITS.files)) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const content = file.content.slice(0, Math.min(remaining, SEARCH_LIMITS.fileCharacters));
    truncated ||= content.length < file.content.length;
    prepared.push({ path: file.path, content });
    remaining -= content.length;
  }
  return { files: prepared, truncated };
}

/** Unicode 标识符边界，支持中文、数字、下划线和 JS 的 $。 */
function wordCharacter(value: string | undefined): boolean {
  return !!value && /[\p{L}\p{N}\p{M}_$]/u.test(value);
}

/** 有界搜索内核。用户正则必须仅在可终止 Worker 内调用。 */
export function searchFileContents(
  files: SearchFile[],
  query: string,
  options: SearchOptions = {},
): SearchResults {
  const prepared = prepareSearchFiles(files);
  const result: SearchResults = { groups: [], count: 0, truncated: prepared.truncated };
  if (!query) return result;
  if (query.length > SEARCH_LIMITS.queryCharacters) {
    return { ...result, error: `查询最多 ${SEARCH_LIMITS.queryCharacters} 个字符` };
  }
  let expression: RegExp;
  try {
    expression = new RegExp(
      options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      options.caseSensitive ? 'gu' : 'giu',
    );
  } catch {
    return { ...result, error: '正则表达式无效' };
  }
  for (const file of prepared.files) {
    expression.lastIndex = 0;
    const matches: SearchMatch[] = [];
    let line = 1;
    let lineStart = 0;
    let scanned = 0;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(file.content))) {
      /** 零宽结果没有可选文本；按 Unicode 码点推进以防零宽表达式循环。 */
      if (!match[0].length) {
        const point = file.content.codePointAt(expression.lastIndex);
        expression.lastIndex += point !== undefined && point > 0xffff ? 2 : 1;
        continue;
      }
      const offset = match.index;
      const end = offset + match[0].length;
      const before = offset
        ? Array.from(file.content.slice(Math.max(0, offset - 2), offset)).at(-1)
        : undefined;
      const after = String.fromCodePoint(file.content.codePointAt(end) ?? 0);
      if (options.wholeWord && (wordCharacter(before) || wordCharacter(after))) continue;
      if (result.count >= SEARCH_LIMITS.results) {
        result.truncated = true;
        if (matches.length) result.groups.push({ path: file.path, matches });
        return result;
      }
      while (scanned < offset) {
        const code = file.content.charCodeAt(scanned++);
        if (code === 10 || (code === 13 && file.content.charCodeAt(scanned) !== 10)) {
          line++;
          lineStart = scanned;
        }
      }
      const snippetStart = Math.max(lineStart, offset - 50);
      const slice = file.content.slice(snippetStart, offset + 150);
      const rawSnippet = slice.split(/[\r\n]/, 1)[0];
      /** 只裁匹配前的行首缩进，保留空白匹配本身及原始 Monaco 坐标。 */
      const indentation = Math.min(
        rawSnippet.match(/^[ \t]+/)?.[0].length ?? 0,
        offset - snippetStart,
      );
      const snippet = rawSnippet.slice(indentation);
      matches.push({
        path: file.path,
        line,
        column: offset - lineStart + 1,
        length: match[0].length,
        snippet,
        snippetColumn: offset - snippetStart - indentation,
      });
      result.count++;
    }
    if (matches.length) result.groups.push({ path: file.path, matches });
  }
  return result;
}

/** 提供属性候选，由用户显式切换；这些词并不代表最终生效的源码。 */
export function propertySearchCandidates(property?: string): string[] {
  if (!property) return [];
  return [
    ...new Set([
      property,
      property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
    ]),
  ];
}
