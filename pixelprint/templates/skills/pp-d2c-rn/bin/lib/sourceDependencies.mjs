/**
 * 跳过注释并提取字面量依赖，将动态或不支持的引用标记为不确定。
 */
export function dependencies(src, isStyle) {
  // SCSS 也允许未加引号的远程 url，不能把其中 // 误当作行注释吞掉后续 import。
  if (isStyle) src = src.replace(/url\(\s*((?:https?:|\/\/)[^'"\s)]+)\s*\)/g, (_, url) => `url(${JSON.stringify(url)})`);
  const tokens = (src.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g) || [])
    .filter((t) => !t.startsWith('//') && !t.startsWith('/*'));
  const values = [];
  let uncertain = false;
  const literal = (s) => s && /^['"`]/.test(s);
  const add = (s) => {
    if (!literal(s)) { uncertain = true; return; }
    values.push(s.slice(1, -1));
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (isStyle) {
      if (t !== '@' || !['import', 'use', 'forward'].includes(tokens[i + 1])) continue;
      const statement = [];
      for (i += 2; i < tokens.length && tokens[i] !== ';'; i++) statement.push(tokens[i]);
      const refs = statement.filter(literal);
      if (!refs.length && !/^url\(https?:/.test(statement.join(''))) uncertain = true;
      if (statement.some((part) => part.startsWith('$') || part === '#')) uncertain = true;
      for (const ref of refs) add(ref);
      continue;
    }
    if (t !== 'import' && t !== 'export' && t !== 'require') continue;
    if (tokens[i + 1] === '.') {
      // import.meta 本身不是动态依赖；glob/context 是。
      if (t === 'require' || tokens.slice(i + 2, i + 6).includes('glob') || tokens.slice(i + 2, i + 6).includes('globEager')) uncertain = true;
      continue;
    }
    if (tokens[i + 1] === '(') {
      if (literal(tokens[i + 2]) && tokens[i + 3] === ')') add(tokens[i + 2]);
      else uncertain = true;
    } else if (t === 'import' && literal(tokens[i + 1])) add(tokens[i + 1]);
    else if (t !== 'require') {
      // static import / export ... from '...'; 不跨到下一条 import/export。
      for (let j = i + 1; j < tokens.length && ![';', 'import', 'export'].includes(tokens[j]); j++) {
        if (tokens[j] === 'from') { add(tokens[j + 1]); break; }
      }
    }
  }
  return { values, uncertain };
}
