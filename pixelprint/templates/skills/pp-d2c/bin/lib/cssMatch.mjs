// cssMatch — 无外部依赖的 CSS/SCSS 词法与选择器作用域解析。
// 只返回选择器主体的直接声明；不编译 Sass、执行 mixin 或推断动态插值。

export function deriveScssSuffixes(className) {
  const out = new Set();
  const idxDouble = className.lastIndexOf('__');
  if (idxDouble >= 0) out.add(className.slice(idxDouble)); // "__cd-num"
  const idxDash = className.lastIndexOf('-');
  if (idxDash > 0) out.add('-' + className.slice(idxDash + 1)); // "-num"
  return Array.from(out);
}

/** 跳过字符串、注释、括号和插值中的结构字符，保留原始偏移。 */
function tokens(source) {
  // 注释必须在字符串外识别，不能破坏 url("https://.../*...") 等真实值。
  let text = '', quote = '', block = false, line = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (block || line) {
      if (block && c === '*' && next === '/') {
        text += '  '; i++; block = false;
      } else if (c === '\n' || c === '\r') {
        text += c; line = false;
      } else text += ' ';
    } else if (quote) {
      text += c;
      if (c === '\\' && next !== undefined) text += source[++i];
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") { quote = c; text += c; }
    else if (c === '/' && next === '*') { block = true; text += '  '; i++; }
    // SCSS 行注释；不把未加引号的 https:// 当作注释。
    else if (c === '/' && next === '/' && source[i - 1] !== ':') {
      line = true; text += '  '; i++;
    } else text += c;
  }
  return text;
}

/** 在字符串/函数/属性选择器之外查找结构分隔符。 */
function boundary(text, start, delimiters) {
  let quote = '', parens = 0, brackets = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    // Sass 插值不是规则块；保留标记供上层拒绝动态选择器。
    if (c === '#' && text[i + 1] === '{') {
      let depth = 1;
      i += 2;
      for (; i < text.length && depth; i++) {
        if (text[i] === '{') depth++;
        if (text[i] === '}') depth--;
      }
      i--; continue;
    }
    if (c === '(') parens++;
    else if (c === ')') parens--;
    else if (c === '[') brackets++;
    else if (c === ']') brackets--;
    else if (!parens && !brackets && delimiters.includes(c)) return i;
  }
  return text.length;
}

/** 按顶层逗号拆选择器，不拆 :is(...)、属性值或字符串。 */
function selectors(text) {
  const out = [];
  let start = 0;
  while (start < text.length) {
    const end = boundary(text, start, ',');
    const value = text.slice(start, end).trim();
    if (value) out.push(value);
    start = end + 1;
  }
  return out;
}

/** 仅替换选择器中的 &，不替换字符串和属性选择器内容。 */
function expandSelector(selector, parents) {
  if (selector.includes('#{')) return [];
  let parts = [''], quote = '', brackets = 0, hasParent = false;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '\\') {
      const escaped = selector.slice(i, i + 2); i++;
      parts = parts.map((part) => part + escaped); continue;
    }
    if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '[') brackets++;
    else if (c === ']') brackets--;
    if (c === '&' && !quote && !brackets) {
      hasParent = true;
      parts = parts.flatMap((part) => parents.map((parent) => part + parent));
    } else parts = parts.map((part) => part + c);
  }
  if (hasParent || !parents.length) return parts;
  return parents.flatMap((parent) => parts.map((part) => `${parent} ${part}`));
}

/** 只匹配最右主体复合选择器；祖先、否定参数和伪元素不提供主体声明。 */
function subjectClasses(selector) {
  let start = 0;
  for (let i = 0; i < selector.length;) {
    const end = boundary(selector, i, ' \t\r\n\f>+~');
    if (end === selector.length) break;
    start = end + 1; i = start;
  }
  const subject = selector.slice(start);
  const out = [];
  for (let i = 0; i < subject.length; i++) {
    const c = subject[i];
    if (c === '[' || c === '(') {
      const opening = i;
      const close = c === '[' ? ']' : ')';
      let depth = 1, quote = '';
      for (i++; i < subject.length && depth; i++) {
        const ch = subject[i];
        if (ch === '\\') { i++; continue; }
        if (quote) { if (ch === quote) quote = ''; continue; }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === c) depth++;
        else if (ch === close) depth--;
      }
      // 正向选择器分支可贡献主体类，:not/:has 等参数不能。
      if (c === '(' && /:(is|where)$/i.test(subject.slice(0, opening))) {
        for (const branch of selectors(subject.slice(opening + 1, i - 1)))
          out.push(...subjectClasses(branch));
      }
      i--; continue;
    }
    if (c === ':' && (subject[i + 1] === ':' || /^:(before|after|first-line|first-letter)\b/i.test(subject.slice(i)))) return [];
    if (c !== '.') continue;
    const match = /^(?:[\w\-\u0080-\uFFFF]|\\(?:[\da-fA-F]{1,6}\s?|[^\r\n]))+/.exec(subject.slice(i + 1));
    if (!match) continue;
    out.push(match[0].replace(/\\([\da-fA-F]{1,6})\s?|\\(.)/g, (_, hex, char) => hex ? String.fromCodePoint(parseInt(hex, 16) > 0x10ffff ? 0xfffd : parseInt(hex, 16) || 0xfffd) : char));
    i += match[0].length;
  }
  return out;
}

let lastSource, lastRules;
/** 构造静态规则记录；分组 at-rule 继承当前选择器，其他指令不猜测编译结果。 */
function parseRules(source) {
  if (source === lastSource) return lastRules;
  const text = tokens(source), records = [];
  const lineAt = (offset) => source.slice(0, offset).split('\n').length;
  function block(start, parents, owner, enabled = true) {
    let position = start;
    while (position < text.length) {
      const end = boundary(text, position, ';{}');
      const header = text.slice(position, end).trim();
      const offset = position + text.slice(position, end).search(/\S|$/);
      const delimiter = text[end];
      if (delimiter === '{') {
        // 自定义属性允许平衡的大括号值，不把其中内容当嵌套选择器。
        if (/^--[\w-]+\s*:/.test(header)) {
          let valueEnd = end + 1, depth = 1;
          while (depth && valueEnd < text.length) {
            valueEnd = boundary(text, valueEnd, '{}');
            if (text[valueEnd] === '{') depth++;
            if (text[valueEnd] === '}') depth--;
            valueEnd++;
          }
          position = valueEnd; continue;
        }
        let scope = [], record = null;
        if (enabled && /^@(media|supports|container|layer|starting-style)\b/i.test(header)) {
          scope = parents;
          if (scope.length) record = { classes: new Set(scope.flatMap(subjectClasses)), body: '', line: owner?.line ?? lineAt(offset), conditional: true };
        } else if (enabled && !header.startsWith('@') && header && !header.includes('#{')) {
          scope = selectors(header).flatMap((selector) => expandSelector(selector, parents));
          record = { classes: new Set(scope.flatMap(subjectClasses)), body: '', line: lineAt(offset) };
        }
        if (record) records.push(record);
        // 未知 at-rule 的内部规则不属于外层（mixin/control/keyframes 等）。
        position = block(end + 1, scope, record, Boolean(record) || (enabled && /^@(media|supports|container|layer|starting-style)\b/i.test(header)));
      } else {
        if (owner && /^[\w-]+\s*:/.test(header)) owner.body += header + (delimiter === ';' ? ';' : '');
        position = end + 1;
        if (delimiter === '}' || !delimiter) return position;
      }
    }
    return position;
  }
  block(0, [], null);
  lastSource = source; lastRules = records;
  return records;
}

/** 返回按源码顺序的 { body, line }；line 为选择器的一基行号，条件块直接声明沿用父选择器行号。 */
export function collectRuleBodies(css, className) {
  const cn = (className || '').trim();
  if (!cn) return [];
  return parseRules(css).filter((rule) => (rule.body || !rule.conditional) && rule.classes.has(cn))
    .map(({ body, line }) => ({ body, line }));
}

// 在多个 style 文件里，某 nodeId 的任一 className 是否有规则体命中 propRe。
// classes = classMap[nodeId]（可能多个）；styleFiles = product.style（[{ content, rel }]）。
// 命中返回 { hit:true, rel, line, body }；否则 { hit:false, firstRel, firstLine, firstSnippet }
// （firstX 给出该 className 找到的第一个规则体，便于报错定位）。
export function findProperty(styleFiles, classes, propRe) {
  let firstRel = null, firstLine = 0, firstSnippet = '';
  for (const cls of classes || []) {
    for (const s of styleFiles) {
      const bodies = collectRuleBodies(s.content, cls);
      for (const r of bodies) {
        propRe.lastIndex = 0;
        if (propRe.test(r.body)) {
          return { hit: true, rel: s.rel, line: r.line, body: r.body };
        }
        if (!firstRel) {
          firstRel = s.rel;
          firstLine = r.line;
          firstSnippet = r.body.slice(0, 200);
        }
      }
    }
  }
  return { hit: false, firstRel, firstLine, firstSnippet };
}

// 取某 nodeId 第一个 className 的规则体（用于需要读取声明值的规则，如 R19 padding）。
// 返回 { body, rel, line } 或 null。
export function firstRuleBody(styleFiles, classes) {
  for (const cls of classes || []) {
    for (const s of styleFiles) {
      const bodies = collectRuleBodies(s.content, cls);
      if (bodies.length) return { body: bodies[0].body, rel: s.rel, line: bodies[0].line };
    }
  }
  return null;
}
