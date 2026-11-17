/** 在离线替身中执行有限 Sequelize 表达式；未知函数报错，避免 SQL 条件被静默忽略。 */
export function matchesSqlExpression(
  row: Record<string, any>,
  condition: any,
): boolean | undefined {
  if (!condition || !('attribute' in condition) || !('comparator' in condition)) return undefined;
  /** 模拟 SQL 函数的 NULL 传播和列读取，不套用业务权限比较函数。 */
  function evaluate(expression: any): any {
    if (typeof expression?.col === 'string') return row[expression.col];
    if (expression?.fn) {
      const value = evaluate(expression.args[0]);
      if (value == null) return null;
      if (expression.fn === 'LOWER') return String(value).toLowerCase();
      if (expression.fn === 'TRIM') return String(value).replace(/^ +| +$/g, '');
      throw new Error(`Unsupported SQL function: ${expression.fn}`);
    }
    return expression;
  }
  if (condition.comparator !== '=') throw new Error('Unsupported SQL comparator');
  const value = evaluate(condition.attribute);
  return value != null && value === condition.logic;
}
