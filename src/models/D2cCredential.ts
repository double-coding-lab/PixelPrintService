import {
  DataTypes,
  Model,
  literal,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export type D2cCredentialStatus = 'active' | 'revoked';

/** AES-256-GCM 密文、IV 和标签使用 Base64；keyId 对应服务端 RuntimeConfig 的固定材料。 */
export class D2cCredential extends Model<
  InferAttributes<D2cCredential>,
  InferCreationAttributes<D2cCredential>
> {
  declare id: CreationOptional<string>;
  declare credentialId: string | null;
  declare ownerUserId: string | null;
  declare kind: CreationOptional<'figma' | 'model'>;
  declare ciphertext: string | null;
  declare iv: string | null;
  declare authTag: string | null;
  declare keyId: string | null;
  declare revision: number | null;
  declare status: CreationOptional<D2cCredentialStatus>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** 仅注册凭据模型；可信加解密服务通过 unscoped() 读取密文，AAD 绑定 ownerUserId/credentialId/kind。 */
export function initD2cCredential(sequelize: Sequelize) {
  D2cCredential.init(
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      credentialId: { type: DataTypes.STRING(64), allowNull: true },
      ownerUserId: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: '服务端 账号认证 用户 ID',
      },
      kind: { type: DataTypes.ENUM('figma', 'model'), allowNull: false, defaultValue: 'figma' },
      ciphertext: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'AES-256-GCM 密文，Base64 编码',
      },
      iv: {
        type: DataTypes.STRING(32),
        allowNull: true,
        comment: '独立随机 12 字节 IV，Base64 编码',
      },
      authTag: {
        type: DataTypes.STRING(32),
        allowNull: true,
        comment: '16 字节 GCM 认证标签，Base64 编码',
      },
      keyId: { type: DataTypes.STRING(128), allowNull: true, comment: '外部密钥版本标识' },
      revision: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      status: {
        type: DataTypes.ENUM('active', 'revoked'),
        allowNull: false,
        defaultValue: 'active',
      },
      createdAt: {
        type: DataTypes.DATE(3),
        allowNull: false,
        defaultValue: literal('CURRENT_TIMESTAMP(3)'),
      },
      updatedAt: { type: DataTypes.DATE(3), allowNull: false, field: 'datachange_lasttime' },
    },
    {
      sequelize,
      modelName: 'D2cCredential',
      tableName: 'd2c_credential',
      freezeTableName: true,
      timestamps: true,
      defaultScope: { attributes: { exclude: ['ciphertext', 'iv', 'authTag', 'keyId'] } },
      indexes: [
        { name: 'uk_d2c_credential_credentialId', unique: true, fields: ['credentialId'] },
        { name: 'idx_d2c_credential_owner_kind', fields: ['ownerUserId', 'kind'] },
        {
          name: 'uk_d2c_credential_owner_kind_revision',
          unique: true,
          fields: ['ownerUserId', 'kind', 'revision'],
        },
      ],
    },
  );
  return D2cCredential;
}
