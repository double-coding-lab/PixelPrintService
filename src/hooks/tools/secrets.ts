import { isUtf8 } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export type SecretKeyConfig = {
  activeKeyId: string;
  keys: Record<string, string>;
};

export type SecretIdentity = {
  ownerUserId: string;
  credentialId: string;
  kind: string;
};

export type EncryptedSecret = {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyId: string;
};

const unavailableMessage = '凭据不可用';

/** 按固定字段顺序编码 AAD，保留元数据原值并避免分隔符歧义。 */
function encodeIdentity(identity: SecretIdentity): Buffer {
  const fields = [identity.ownerUserId, identity.credentialId, identity.kind];
  if (fields.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
    throw new Error(unavailableMessage);
  }
  return Buffer.from(JSON.stringify(fields), 'utf8');
}

/** 从 项目配置 的指定版本材料派生 32 字节 AES 密钥；不改变材料原值或回退版本。 */
function deriveSecretKey(keyId: string, config: SecretKeyConfig): Buffer {
  const keys = config?.keys;
  if (
    typeof keyId !== 'string' ||
    keyId.trim().length === 0 ||
    !keys ||
    typeof keys !== 'object' ||
    Array.isArray(keys) ||
    !Object.hasOwn(keys, keyId)
  ) {
    throw new Error(unavailableMessage);
  }
  const material = keys[keyId];
  if (
    typeof material !== 'string' ||
    !material.trim() ||
    material !== material.trim() ||
    material.length > 16384 ||
    /[\u0000-\u001f\u007f]/u.test(material)
  ) {
    throw new Error(unavailableMessage);
  }
  return createHash('sha256').update(material, 'utf8').digest();
}

/** 通过重新编码比对，拒绝非法字符、省略 padding 和非零 padding bits 等非规范 Base64。 */
function decodeBase64(value: string): Buffer {
  if (typeof value !== 'string') {
    throw new Error(unavailableMessage);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new Error(unavailableMessage);
  }
  return bytes;
}

/** 用当前密钥和随机 12 字节 IV 加密 UTF-8 凭据；全部失败统一返回脱敏错误。 */
export async function encryptSecret(
  plaintext: string,
  identity: SecretIdentity,
  config: SecretKeyConfig,
): Promise<EncryptedSecret> {
  try {
    if (typeof plaintext !== 'string') {
      throw new Error(unavailableMessage);
    }
    const aad = encodeIdentity(identity);
    const keyId = config.activeKeyId;
    const key = deriveSecretKey(keyId, config);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyId,
    };
  } catch {
    throw new Error(unavailableMessage);
  }
}

/** 按记录的 keyId 解密并验证身份 AAD 与完整性；验证通过后才返回 UTF-8 明文。 */
export async function decryptSecret(
  encrypted: EncryptedSecret,
  identity: SecretIdentity,
  config: SecretKeyConfig,
): Promise<string> {
  try {
    const aad = encodeIdentity(identity);
    const ciphertext = decodeBase64(encrypted.ciphertext);
    const iv = decodeBase64(encrypted.iv);
    const authTag = decodeBase64(encrypted.authTag);
    if (iv.byteLength !== 12 || authTag.byteLength !== 16) {
      throw new Error(unavailableMessage);
    }
    const key = deriveSecretKey(encrypted.keyId, config);
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (!isUtf8(plaintext)) {
      throw new Error(unavailableMessage);
    }
    return plaintext.toString('utf8');
  } catch {
    throw new Error(unavailableMessage);
  }
}
