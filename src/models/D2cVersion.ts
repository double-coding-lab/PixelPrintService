import {
  DataTypes,
  Model,
  literal,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import type { D2cTarget } from './D2cSession';

export type D2cVersionStatus = 'saving' | 'ready' | 'failed';

/** 不可变产物快照；target 固定自源会话，公共列表只读取 ready 版本。 */
export class D2cVersion extends Model<
  InferAttributes<D2cVersion>,
  InferCreationAttributes<D2cVersion>
> {
  declare id: CreationOptional<string>;
  declare versionId: string | null;
  declare sessionId: string | null;
  declare workspaceId: string | null;
  declare clientRequestId: string | null;
  declare name: string | null;
  declare target: D2cTarget | null;
  declare createdUserId: string | null;
  declare creatorName: string | null;
  declare sourceFileRevision: number | null;
  declare resourceRevisionId: string | null;
  declare configRevision: number | null;
  declare configSnapshot: Record<string, unknown> | null;
  declare validationSummary: Record<string, unknown> | null;
  declare manifestHash: string | null;
  declare status: CreationOptional<D2cVersionStatus>;
  declare archiveObject: Record<string, unknown> | null;
  declare error: Record<string, unknown> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** 仅注册版本模型；冻结文件与上传 ZIP 分阶段完成，clientRequestId 保证保存幂等。 */
export function initD2cVersion(sequelize: Sequelize) {
  D2cVersion.init(
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      versionId: { type: DataTypes.STRING(64), allowNull: true },
      sessionId: { type: DataTypes.STRING(64), allowNull: true },
      workspaceId: { type: DataTypes.STRING(64), allowNull: true },
      clientRequestId: { type: DataTypes.STRING(64), allowNull: true },
      name: { type: DataTypes.STRING(200), allowNull: true },
      target: { type: DataTypes.ENUM('h5', 'rn'), allowNull: true },
      createdUserId: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: '服务端 账号认证 用户 ID',
      },
      creatorName: { type: DataTypes.STRING(100), allowNull: true },
      sourceFileRevision: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      resourceRevisionId: { type: DataTypes.STRING(64), allowNull: true },
      configRevision: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      configSnapshot: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '私有固定配置快照，不含密钥',
      },
      validationSummary: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'passed/failed/stale/not_checked 及校验证据',
      },
      manifestHash: { type: DataTypes.STRING(64), allowNull: true },
      status: {
        type: DataTypes.ENUM('saving', 'ready', 'failed'),
        allowNull: false,
        defaultValue: 'saving',
      },
      archiveObject: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '上传完成后记录不可变 ZIP 定位',
      },
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
      modelName: 'D2cVersion',
      tableName: 'd2c_version',
      freezeTableName: true,
      timestamps: true,
      indexes: [
        { name: 'uk_d2c_version_versionId', unique: true, fields: ['versionId'] },
        {
          name: 'uk_d2c_version_session_request',
          unique: true,
          fields: ['sessionId', 'clientRequestId'],
        },
        { name: 'idx_d2c_version_creator_createdAt', fields: ['createdUserId', 'createdAt'] },
        { name: 'idx_d2c_version_status_createdAt', fields: ['status', 'createdAt'] },
        { name: 'idx_d2c_version_session_createdAt', fields: ['sessionId', 'createdAt'] },
        {
          name: 'idx_d2c_version_status_target_createdAt',
          fields: ['status', 'target', 'createdAt'],
        },
      ],
    },
  );
  return D2cVersion;
}
