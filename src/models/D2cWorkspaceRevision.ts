import {
  DataTypes,
  Model,
  literal,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export type D2cWorkspaceRevisionStatus = 'preparing' | 'ready' | 'failed';

/** 不可变资源副本，独立 UUID 与工作区内递增 revision 分别标识资源。 */
export class D2cWorkspaceRevision extends Model<
  InferAttributes<D2cWorkspaceRevision>,
  InferCreationAttributes<D2cWorkspaceRevision>
> {
  declare id: CreationOptional<string>;
  declare resourceRevisionId: string | null;
  declare workspaceId: string | null;
  declare revision: number | null;
  declare sourceVersion: string | null;
  declare sourceCommit: string | null;
  declare bundleHash: string | null;
  declare bundleObject: Record<string, unknown> | null;
  declare defaultConfigs: Record<string, unknown> | null;
  declare status: CreationOptional<D2cWorkspaceRevisionStatus>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** 仅注册资源修订模型；所属工作区及不可变性由业务层检查。 */
export function initD2cWorkspaceRevision(sequelize: Sequelize) {
  D2cWorkspaceRevision.init(
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      resourceRevisionId: { type: DataTypes.STRING(64), allowNull: true },
      workspaceId: { type: DataTypes.STRING(64), allowNull: true },
      revision: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      sourceVersion: { type: DataTypes.STRING(64), allowNull: true },
      sourceCommit: { type: DataTypes.STRING(64), allowNull: true },
      bundleHash: { type: DataTypes.STRING(64), allowNull: true },
      bundleObject: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '上传完成后记录不可变资源包定位，不含上传凭据',
      },
      defaultConfigs: { type: DataTypes.JSON, allowNull: true },
      status: {
        type: DataTypes.ENUM('preparing', 'ready', 'failed'),
        allowNull: false,
        defaultValue: 'preparing',
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
      modelName: 'D2cWorkspaceRevision',
      tableName: 'd2c_workspace_revision',
      freezeTableName: true,
      timestamps: true,
      indexes: [
        {
          name: 'uk_d2c_workspace_revision_resourceId',
          unique: true,
          fields: ['resourceRevisionId'],
        },
        {
          name: 'uk_d2c_workspace_revision_workspace_revision',
          unique: true,
          fields: ['workspaceId', 'revision'],
        },
      ],
    },
  );
  return D2cWorkspaceRevision;
}
