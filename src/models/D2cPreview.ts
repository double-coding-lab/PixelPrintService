import {
  DataTypes,
  Model,
  literal,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export type D2cPreviewStatus = 'queued' | 'building' | 'ready' | 'failed';

/** 固定输入的预览构建；sessionId/versionId 恰有一个非空由业务层验证。 */
export class D2cPreview extends Model<
  InferAttributes<D2cPreview>,
  InferCreationAttributes<D2cPreview>
> {
  declare id: CreationOptional<string>;
  declare previewId: string | null;
  declare sessionId: string | null;
  declare versionId: string | null;
  declare fileRevision: number | null;
  declare manifestHash: string | null;
  declare configSnapshot: Record<string, unknown> | null;
  declare resourceRevisionId: string | null;
  declare runtimeRevision: string | null;
  declare status: CreationOptional<D2cPreviewStatus>;
  declare leaseOwner: string | null;
  declare leaseExpiresAt: Date | null;
  declare buildManifest: Record<string, unknown> | null;
  declare error: Record<string, unknown> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** 仅注册预览模型；缓存命中仍须校验来源权限，租约通过条件更新领取。 */
export function initD2cPreview(sequelize: Sequelize) {
  D2cPreview.init(
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      previewId: { type: DataTypes.STRING(64), allowNull: true },
      sessionId: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: '与 versionId 互斥，由业务层检查',
      },
      versionId: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: '与 sessionId 互斥，由业务层检查',
      },
      fileRevision: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      manifestHash: { type: DataTypes.STRING(64), allowNull: true },
      configSnapshot: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '私有固定配置快照，不含密钥',
      },
      resourceRevisionId: { type: DataTypes.STRING(64), allowNull: true },
      runtimeRevision: { type: DataTypes.STRING(64), allowNull: true },
      status: {
        type: DataTypes.ENUM('queued', 'building', 'ready', 'failed'),
        allowNull: false,
        defaultValue: 'queued',
      },
      leaseOwner: { type: DataTypes.STRING(128), allowNull: true },
      leaseExpiresAt: { type: DataTypes.DATE(3), allowNull: true },
      buildManifest: { type: DataTypes.JSON, allowNull: true },
      error: { type: DataTypes.JSON, allowNull: true },
      createdAt: {
        type: DataTypes.DATE(3),
        allowNull: false,
        defaultValue: literal('CURRENT_TIMESTAMP(3)'),
      },
      updatedAt: { type: DataTypes.DATE(3), allowNull: false, field: 'datachange_lasttime' },
    },
    {
      sequelize,
      modelName: 'D2cPreview',
      tableName: 'd2c_preview',
      freezeTableName: true,
      timestamps: true,
      indexes: [
        { name: 'uk_d2c_preview_previewId', unique: true, fields: ['previewId'] },
        { name: 'idx_d2c_preview_manifest_runtime', fields: ['manifestHash', 'runtimeRevision'] },
        { name: 'idx_d2c_preview_status_createdAt', fields: ['status', 'createdAt'] },
        { name: 'idx_d2c_preview_leaseExpiresAt', fields: ['leaseExpiresAt'] },
        { name: 'idx_d2c_preview_session_createdAt', fields: ['sessionId', 'createdAt'] },
        { name: 'idx_d2c_preview_version_createdAt', fields: ['versionId', 'createdAt'] },
      ],
    },
  );
  return D2cPreview;
}
