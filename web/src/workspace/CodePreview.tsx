import React, { useMemo, useState } from 'react';
import Prism from 'prismjs';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-scss';

Prism.manual = true;

const languages: Record<string, { name: string; grammar: string }> = {
  json: { name: 'JSON', grammar: 'json' },
  js: { name: 'JavaScript', grammar: 'javascript' },
  mjs: { name: 'JavaScript', grammar: 'javascript' },
  cjs: { name: 'JavaScript', grammar: 'javascript' },
  jsx: { name: 'JSX', grammar: 'jsx' },
  ts: { name: 'TypeScript', grammar: 'typescript' },
  tsx: { name: 'TSX', grammar: 'tsx' },
  css: { name: 'CSS', grammar: 'css' },
  scss: { name: 'SCSS', grammar: 'scss' },
  html: { name: 'HTML', grammar: 'markup' },
  htm: { name: 'HTML', grammar: 'markup' },
  svg: { name: 'SVG', grammar: 'markup' },
};

/** 根据扩展名选择已内置的语法，未知类型保持纯文本。 */
export function codeLanguage(path: string) {
  return languages[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? { name: '纯文本', grammar: '' };
}

/** JSON 仅调整字符串外的空白，保留大整数、转义及键顺序的原始写法。 */
export function formatJsonView(content: string): string | null {
  try {
    JSON.parse(content);
  } catch {
    return null;
  }
  const tokens = content.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? [];
  let depth = 0;
  let output = '';
  const newline = () => '\n' + '  '.repeat(depth);
  for (const [index, token] of tokens.entries()) {
    if (token === '{' || token === '[') {
      output += token;
      depth++;
      if (depth > 100) return null;
      if (!['}', ']'].includes(tokens[index + 1])) output += newline();
    } else if (token === '}' || token === ']') {
      depth--;
      if (!['{', '['].includes(tokens[index - 1])) output += newline();
      output += token;
    } else if (token === ',') output += ',' + newline();
    else if (token === ':') output += ': ';
    else output += token;
  }
  return output;
}

type Fragment = { text: string; classes: string };

/** 将多行语法 token 拆成逐行片段，React 转义正文，注释和模板字符串保留颜色。 */
export function highlightLines(content: string, grammar: string): Fragment[][] {
  const lines: Fragment[][] = [[]];
  /** 递归展开库提供的 token，不将源码写入 innerHTML。 */
  function visit(token: string | Prism.Token | (string | Prism.Token)[], classes = '') {
    if (Array.isArray(token)) {
      token.forEach((child) => visit(child, classes));
      return;
    }
    if (typeof token !== 'string') {
      visit(
        token.content,
        `${classes} token ${token.type} ${[token.alias ?? []].flat().join(' ')}`,
      );
      return;
    }
    token.split('\n').forEach((text, index) => {
      if (index) lines.push([]);
      if (text) lines.at(-1)!.push({ text, classes: classes.trim() });
    });
  }
  const language = Prism.languages[grammar];
  visit(language ? Prism.tokenize(content, language) : content);
  return lines;
}

/** 轻量只读代码查看器；格式化与换行只改变视图，复制始终使用原文。 */
export default function CodePreview({ content, path }: { content: string; path: string }) {
  const [wrap, setWrap] = useState(false);
  const [formatted, setFormatted] = useState(true);
  const [copyStatus, setCopyStatus] = useState('');
  const language = codeLanguage(path);
  const large = content.length > 150_000 || content.split('\n').length > 3000;
  const json = useMemo(
    () => (language.grammar === 'json' && !large ? formatJsonView(content) : null),
    [content, language.grammar, large],
  );
  const display = formatted && json !== null ? json : content;
  const lines = useMemo(
    () => (large ? null : highlightLines(display.replace(/\r\n/g, '\n'), language.grammar)),
    [display, language.grammar, large],
  );

  /** 剪贴板权限被拒绝时给出提示，保持原文可选择复制。 */
  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopyStatus('已复制原文');
    } catch {
      setCopyStatus('复制失败，请手动选择');
    }
  }

  return (
    <div className="code-preview">
      <div className="code-preview-toolbar">
        <span className="code-language">{language.name}</span>
        <span className="code-line-count">{display.split('\n').length} 行</span>
        <div className="code-preview-actions">
          {json !== null && (
            <button
              type="button"
              className="quiet"
              aria-pressed={formatted}
              onClick={() => setFormatted((value) => !value)}
            >
              {formatted ? '查看原文' : '格式化 JSON'}
            </button>
          )}
          <button
            type="button"
            className="quiet"
            aria-pressed={wrap}
            onClick={() => setWrap((value) => !value)}
          >
            自动换行
          </button>
          <button type="button" className="quiet" onClick={() => void copy()}>
            复制
          </button>
        </div>
      </div>
      {copyStatus && (
        <span className="code-preview-status" role="status">
          {copyStatus}
        </span>
      )}
      {large && <span className="code-preview-status">文件较大，使用原文展示。</span>}
      {language.grammar === 'json' && json === null && !large && (
        <span className="code-preview-status">JSON 格式不完整，保留原文展示。</span>
      )}
      <pre className={`code-surface${wrap ? ' code-wrap' : ''}`} aria-label="文件内容" tabIndex={0}>
        <code>
          {lines
            ? lines.map((line, index) => (
                <span className="code-line" key={index}>
                  <span className="code-line-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="code-line-text">
                    {line.length
                      ? line.map((fragment, part) => (
                          <span className={fragment.classes || undefined} key={part}>
                            {fragment.text}
                          </span>
                        ))
                      : '\u200b'}
                  </span>
                </span>
              ))
            : content}
        </code>
      </pre>
    </div>
  );
}
