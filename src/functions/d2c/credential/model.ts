import { randomUUID } from 'node:crypto';
import { UniqueConstraintError, type Sequelize, type Transaction } from 'sequelize';
import { z } from 'zod';
import { decryptSecret, encryptSecret, type SecretKeyConfig } from '@/hooks/tools/secrets';
import type { D2cCredential } from '@/models/D2cCredential';

export type ModelCredentialStatus =
  | { configured: true; credentialId: string; modelName: string }
  | { configured: false; credentialId?: never; modelName: string };
export type CredentialModel = { MODEL_BASE_URL: string; MODEL_NAME: string };
export const modelTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(8192)
  .refine((value) => !/[\u0000-\u0020\u007f]/u.test(value));
const identifier = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
const payloadSchema = z
  .object({
    token: modelTokenSchema,
    MODEL_BASE_URL: z.string().url(),
    MODEL_NAME: z.string().min(1),
  })
  .strict();

/** 只接受服务器默认模型；连接身份随 Token 修订加密，不接受浏览器提供的 URL。 */
export function createModelCredentialService(
  mysql: Sequelize,
  readKeys: () => SecretKeyConfig | undefined,
  readModels: () => readonly CredentialModel[],
) {
  const credentials = mysql.models.D2cCredential as typeof D2cCredential;
  if (!credentials) throw new Error('凭据模型尚未注册');
  function keys() {
    const value = readKeys();
    if (!value) throw new Error('模型凭据不可用');
    return value;
  }
  function defaultModel() {
    const model = readModels()[0];
    if (!model?.MODEL_BASE_URL || !model.MODEL_NAME) throw new Error('模型配置不可用');
    return { MODEL_BASE_URL: model.MODEL_BASE_URL, MODEL_NAME: model.MODEL_NAME };
  }
  function safeModelName(model: CredentialModel) {
    // 对外只提供有限字符的名称，不投影 endpoint 或任意配置对象。
    return /^[a-zA-Z0-9][a-zA-Z0-9._/ -]{0,127}$/.test(model.MODEL_NAME)
      ? model.MODEL_NAME
      : '默认模型';
  }
  async function read(
    ownerUserId: string,
    credentialId: string,
    expected?: CredentialModel,
    transaction?: Transaction,
  ) {
    identifier.parse(ownerUserId);
    identifier.parse(credentialId);
    try {
      const record = await credentials.unscoped().findOne({
        where: { credentialId, ownerUserId, kind: 'model', status: 'active' },
        transaction,
      });
      if (
        !record ||
        record.ownerUserId !== ownerUserId ||
        record.credentialId !== credentialId ||
        record.kind !== 'model' ||
        record.status !== 'active'
      )
        throw new Error();
      const payload = payloadSchema.parse(
        JSON.parse(
          await decryptSecret(
            {
              ciphertext: record.ciphertext!,
              iv: record.iv!,
              authTag: record.authTag!,
              keyId: record.keyId!,
            },
            { ownerUserId, credentialId, kind: 'model' },
            keys(),
          ),
        ),
      );
      const current = defaultModel();
      if (
        [current, ...(expected ? [expected] : [])].some(
          (model) =>
            payload.MODEL_BASE_URL !== model.MODEL_BASE_URL ||
            payload.MODEL_NAME !== model.MODEL_NAME,
        )
      )
        throw new Error();
      return payload;
    } catch {
      throw new Error('模型凭据不可用，请配置本人默认模型 Token');
    }
  }
  return {
    async save(ownerUserId: string, token: string) {
      identifier.parse(ownerUserId);
      const payload = { ...defaultModel(), token: modelTokenSchema.parse(token) };
      const credentialId = randomUUID();
      const encrypted = await encryptSecret(
        JSON.stringify(payload),
        { ownerUserId, credentialId, kind: 'model' },
        keys(),
      );
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const previous = Number(
            (await credentials.max('revision', { where: { ownerUserId, kind: 'model' } })) ?? 0,
          );
          if (!Number.isSafeInteger(previous) || previous < 0 || previous >= 4294967295)
            throw new Error();
          await credentials.create({
            credentialId,
            ownerUserId,
            kind: 'model',
            status: 'active',
            revision: previous + 1,
            ...encrypted,
          });
          return { configured: true, credentialId, modelName: safeModelName(payload) };
        } catch (error) {
          if (error instanceof UniqueConstraintError && attempt < 2) continue;
          throw new Error('保存模型凭据失败');
        }
      }
      throw new Error('保存模型凭据失败');
    },
    async getStatus(ownerUserId: string): Promise<ModelCredentialStatus> {
      identifier.parse(ownerUserId);
      const modelName = safeModelName(defaultModel());
      try {
        const record = await credentials.findOne({
          where: { ownerUserId, kind: 'model', status: 'active' },
          attributes: ['credentialId'],
          order: [['revision', 'DESC']],
        });
        if (!record?.credentialId) return { configured: false, modelName };
        // 模型默认配置改变后旧 Token 不会发送到新的服务地址。
        try {
          await read(ownerUserId, record.credentialId);
        } catch {
          return { configured: false, modelName };
        }
        return { configured: true, credentialId: record.credentialId, modelName };
      } catch {
        throw new Error('查询模型凭据失败');
      }
    },
    /** 仅执行器使用；严格按固定 ID、发起人、类型及管理员默认模型解密，失败绝不回退。 */
    async getToken(
      ownerUserId: string,
      credentialId: string,
      expected?: CredentialModel,
      transaction?: Transaction,
    ) {
      return (await read(ownerUserId, credentialId, expected, transaction)).token;
    },
  };
}
