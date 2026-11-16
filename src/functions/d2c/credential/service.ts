import { randomUUID } from 'node:crypto';
import { UniqueConstraintError, type Sequelize } from 'sequelize';
import { decryptSecret, encryptSecret, type SecretKeyConfig } from '@/hooks/tools/secrets';
import type { D2cCredential } from '@/models/D2cCredential';

/** 服务端用户 ID 是唯一归属来源，不接受空值或超出数据库长度的身份。 */
function requireOwner(ownerUserId: string) {
  if (
    typeof ownerUserId !== 'string' ||
    !ownerUserId ||
    ownerUserId !== ownerUserId.trim() ||
    ownerUserId.length > 64 ||
    /[\u0000-\u001f\u007f]/u.test(ownerUserId)
  ) {
    throw new Error('用户身份无效');
  }
}

/** 创建凭据服务，直接读取 RuntimeConfig 密钥材料；缺配置时明确失败。 */
export function createFigmaCredentialService(
  mysql: Sequelize,
  readKeyConfig: () => SecretKeyConfig | undefined,
) {
  const credentials = mysql.models.D2cCredential as typeof D2cCredential | undefined;
  if (!credentials) throw new Error('凭据模型尚未注册');

  /** 在可信服务边界读取固定密钥材料，不向接口或数据库复制密钥。 */
  function encryptionConfig(): SecretKeyConfig {
    const config = readKeyConfig();
    if (!config) throw new Error('凭据加密接入尚未就绪');
    return config;
  }

  return {
    /**
     * 使用当前 RuntimeConfig 密钥材料加密 Token，只将密文及认证元数据保存至 MySQL。
     * 生成独立凭据编号和递增修订；同用户并发修订冲突最多尝试三次，不撤销旧修订。
     * @param ownerUserId 服务端 账号认证 获取的用户 ID，不能直接信任请求传入的归属。
     * @param token 仅在可信加密边界临时使用的 Figma Token 明文。
     * @returns configured、credentialId 和 revision，不返回密文、明文或密钥。
     */
    async save(ownerUserId: string, token: string) {
      requireOwner(ownerUserId);
      if (
        typeof token !== 'string' ||
        !token.trim() ||
        token.trim().length > 8192 ||
        /[\u0000-\u001f\u007f]/u.test(token)
      ) {
        throw new Error('Figma Token 无效');
      }
      const config = encryptionConfig();
      const credentialId = randomUUID();
      const encrypted = await encryptSecret(
        token.trim(),
        { ownerUserId, credentialId, kind: 'figma' },
        config,
      );
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const previous = Number(
            (await credentials.max('revision', { where: { ownerUserId, kind: 'figma' } })) ?? 0,
          );
          if (!Number.isSafeInteger(previous) || previous < 0 || previous >= 4294967295)
            throw new Error('Invalid revision');
          const revision = previous + 1;
          await credentials.create({
            credentialId,
            ownerUserId,
            kind: 'figma',
            revision,
            status: 'active',
            ...encrypted,
          });
          return { credentialId, configured: true, revision };
        } catch (error) {
          if (error instanceof UniqueConstraintError && attempt < 2) continue;
          throw new Error('保存 Figma 凭据失败');
        }
      }
      throw new Error('保存 Figma 凭据失败');
    },

    /** 只返回是否已配置和修订元数据，不能通过该方法读取密文或明文。 */
    async getStatus(ownerUserId: string) {
      requireOwner(ownerUserId);
      try {
        const record = await credentials.findOne({
          where: { ownerUserId, kind: 'figma', status: 'active' },
          attributes: ['credentialId', 'revision', 'updatedAt'],
          order: [['revision', 'DESC']],
        });
        if (!record) return { configured: false };
        if (
          typeof record.credentialId !== 'string' ||
          !record.credentialId.trim() ||
          typeof record.revision !== 'number' ||
          !Number.isSafeInteger(record.revision) ||
          record.revision < 1
        )
          throw new Error('凭据记录不完整');
        return {
          configured: true,
          credentialId: record.credentialId,
          revision: record.revision,
          updatedAt: record.updatedAt,
        };
      } catch {
        throw new Error('查询 Figma 凭据失败');
      }
    },

    /**
     * 仅供受控 Figma 工具读取并解密指定的有效凭据。
     * unscoped 用于取回默认查询隐藏的密文，之后仍核对用户、编号、类型和状态。
     * @returns 临时明文，仅注入可信工具；禁止通过 HTTP、日志或模型上下文返回。
     */
    async getToken(ownerUserId: string, credentialId: string): Promise<string> {
      requireOwner(ownerUserId);
      if (
        typeof credentialId !== 'string' ||
        !credentialId ||
        credentialId !== credentialId.trim() ||
        credentialId.length > 64 ||
        /[\u0000-\u001f\u007f]/u.test(credentialId)
      )
        throw new Error('凭据不可用');
      const config = encryptionConfig();
      try {
        const record = await credentials.unscoped().findOne({
          where: { credentialId, ownerUserId, kind: 'figma', status: 'active' },
        });
        if (
          !record ||
          record.ownerUserId !== ownerUserId ||
          record.credentialId !== credentialId ||
          record.kind !== 'figma' ||
          record.status !== 'active'
        ) {
          throw new Error('凭据不可用');
        }
        if (
          typeof record.ciphertext !== 'string' ||
          typeof record.iv !== 'string' ||
          typeof record.authTag !== 'string' ||
          typeof record.keyId !== 'string'
        )
          throw new Error('凭据不可用');
        return await decryptSecret(
          {
            ciphertext: record.ciphertext,
            iv: record.iv,
            authTag: record.authTag,
            keyId: record.keyId,
          },
          { ownerUserId, credentialId, kind: 'figma' },
          config,
        );
      } catch {
        throw new Error('凭据不可用');
      }
    },
  };
}
