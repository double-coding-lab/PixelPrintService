import { Op, type Attributes, type FindOptions, type Model, type ModelStatic } from 'sequelize';

/**
 * 只用稳定标识排序和分页，再在原事务内读取正文，避免 TEXT/JSON/BLOB 进入 filesort。
 * key 必须在当前 where 范围内唯一；第二次查询保留原筛选、投影与锁，并按标识恢复顺序。
 */
export async function findOrderedRows<M extends Model>(
  model: ModelStatic<M>,
  key: string | string[],
  options: FindOptions<Attributes<M>>,
): Promise<M[]> {
  const keys = typeof key === 'string' ? [key] : key;
  const heads = await model.findAll({ ...options, attributes: keys, raw: true });
  if (!heads.length) return [];
  if (heads.some((row) => keys.some((field) => row[field as keyof M] == null)))
    throw new Error('ORDERED_READ_KEY_MISSING');
  const identify = (row: M) => JSON.stringify(keys.map((field) => row[field as keyof M]));
  const selected =
    keys.length === 1
      ? { [keys[0]]: { [Op.in]: heads.map((row) => row[keys[0] as keyof M]) } }
      : {
          [Op.or]: heads.map((row) =>
            Object.fromEntries(keys.map((field) => [field, row[field as keyof M]])),
          ),
        };
  const attributes = Array.isArray(options.attributes)
    ? [...new Set([...options.attributes, ...keys])]
    : options.attributes;
  const rows = await model.findAll({
    ...options,
    attributes,
    order: undefined,
    limit: undefined,
    offset: undefined,
    where: { ...options.where, [Op.and]: [options.where ?? {}, selected] },
  });
  const byId = new Map(rows.map((row) => [identify(row), row]));
  return heads.flatMap((row) => {
    const full = byId.get(identify(row));
    return full ? [full] : [];
  });
}

/** 最新记录同样先选标识；复用原来的排序、事务和更新锁。 */
export async function findOrderedOne<M extends Model>(
  model: ModelStatic<M>,
  key: string,
  options: FindOptions<Attributes<M>>,
): Promise<M | null> {
  return (await findOrderedRows(model, key, { ...options, limit: 1 }))[0] ?? null;
}

/** 列表计数仍按原筛选执行，正文读取遵循标识分页结果。 */
export async function findOrderedPage<M extends Model>(
  model: ModelStatic<M>,
  key: string,
  options: FindOptions<Attributes<M>>,
) {
  const rows = await findOrderedRows(model, key, options);
  const count = await model.count({ where: options.where, transaction: options.transaction });
  return { rows, count };
}
