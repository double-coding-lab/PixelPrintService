import { z } from 'zod';

/** 约束说明来自平台注册契约，不取校验器正文或调用参数。 */
function expectedInput(schema: z.ZodType): string {
  try {
    const json = z.toJSONSchema(schema, { unrepresentable: 'any' });
    const nullable = Array.isArray(json.anyOf) ? json.anyOf : [json];
    const value = nullable.find((item) => typeof item !== 'boolean' && item.type !== 'null');
    if (!value || typeof value === 'boolean') return '';
    const parts: string[] = [];
    if (!schema.safeParse(undefined).success) parts.push('必填');
    if (value.type) parts.push(`类型 ${String(value.type)}`);
    const choices = value.enum ?? (value.const !== undefined ? [value.const] : undefined);
    if (choices?.length && choices.length <= 12)
      parts.push(`允许值 ${choices.map((item) => JSON.stringify(item)).join('/')}`);
    if (typeof value.minimum === 'number') parts.push(`最小 ${value.minimum}`);
    if (typeof value.maximum === 'number') parts.push(`最大 ${value.maximum}`);
    if (typeof value.minLength === 'number') parts.push(`最短 ${value.minLength} 字符`);
    if (typeof value.maxLength === 'number') parts.push(`最长 ${value.maxLength} 字符`);
    if (typeof value.pattern === 'string' && value.pattern.length <= 100)
      parts.push(`格式 ${value.pattern}`);
    if (value.type === 'array' && value.items && !Array.isArray(value.items)) {
      if (typeof value.items !== 'boolean' && value.items.type)
        parts.push(`元素类型 ${String(value.items.type)}`);
    }
    if (value.type === 'object' && value.additionalProperties) {
      parts.push('使用对象键值映射');
      if (typeof value.additionalProperties !== 'boolean' && value.additionalProperties.type)
        parts.push(`映射值类型 ${String(value.additionalProperties.type)}`);
    }
    return parts.join('；');
  } catch {
    return '';
  }
}

/** 只从注册契约返回出错字段和固定问题类型，不输出参数值或校验器原始消息。 */
export function toolArgumentDetail(schema: unknown, args: unknown): string | undefined {
  if (!(schema instanceof z.ZodObject)) return;
  const parsed = schema.safeParse(args);
  if (parsed.success) return;
  const fields = new Set(Object.keys(schema.shape));
  const issues = new Set(
    parsed.error.issues.slice(0, 12).map((issue) => {
      const field = issue.path[0];
      const name = typeof field === 'string' && fields.has(field) ? field : '参数对象';
      const expected = expectedInput(name === '参数对象' ? schema : schema.shape[name]);
      const alias = name === 'oldText' ? 'old_text' : name === 'newText' ? 'new_text' : undefined;
      const aliasHint =
        alias &&
        args !== null &&
        typeof args === 'object' &&
        Object.hasOwn(args, alias) &&
        !fields.has(alias)
          ? `；字段名使用 ${name}，不支持 ${alias}`
          : '';
      return `${name}（${issue.code}${expected ? `；${expected}` : ''}${aliasHint}）`;
    }),
  );
  return `请检查字段：${[...issues].join('、')}。按注册工具契约修正类型、必填项或取值范围后重试；不要原样重试。`;
}
