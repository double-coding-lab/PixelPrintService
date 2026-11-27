/** 目录只提供真实正文的字符位置，标题预览有界；不代替任何章节或规则的读取。 */
export function markdownOutline(text: string, offset: number, limit: number) {
  const sections: Array<{
    heading: string;
    level: number;
    offset: number;
    end: number;
    labelTruncated: boolean;
  }> = [];
  let position = 0;
  let frontmatter = /^---\r?\n/.test(text);
  let fence: { marker: string; length: number } | undefined;
  for (const line of text.split(/(?<=\n)/)) {
    const content = line.replace(/\r?\n$/, '');
    if (frontmatter) {
      if (position > 0 && /^(---|\.\.\.)\s*$/.test(content)) frontmatter = false;
      position += line.length;
      continue;
    }
    const code = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    if (fence) {
      if (code && code[1][0] === fence.marker && code[1].length >= fence.length && !code[2].trim())
        fence = undefined;
    } else if (code) fence = { marker: code[1][0], length: code[1].length };
    else {
      const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/.exec(content);
      if (heading)
        sections.push({
          heading: heading[2].slice(0, 160),
          level: heading[1].length,
          offset: position,
          end: text.length,
          labelTruncated: heading[2].length > 160,
        });
    }
    position += line.length;
  }
  // 单调栈按同级或上级标题确定章节末尾，保留所有嵌套正文；线性处理长文档。
  const stack: number[] = [];
  for (let i = 0; i < sections.length; i++) {
    while (stack.length && sections[stack.at(-1)!].level >= sections[i].level)
      sections[stack.pop()!].end = sections[i].offset;
    stack.push(i);
  }
  if (!sections.length || sections[0].offset > 0)
    sections.unshift({
      heading: sections.length ? '文档开头' : '正文（无标题）',
      level: 0,
      offset: 0,
      end: sections[0]?.offset ?? text.length,
      labelTruncated: false,
    });
  return {
    totalSections: sections.length,
    offset,
    sections: sections.slice(offset, offset + limit),
    nextOffset: offset + limit < sections.length ? offset + limit : null,
  };
}
