import {
  DataTypes,
  Model,
  literal,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export type D2cWorkspaceStatus = 'preparing' | 'ready' | 'updating' | 'failed';

/** 工作区归属由服务端 账号认证 设置；配置保存通过 configRevision 条件更新。 */
export class D2cWorkspace extends Model<
  InferAttributes<D2cWorkspace>,
  InferCreationAttributes<D2cWorkspace>
> {
  declare id: CreationOptional<string>;
  declare workspaceId: string | null;
  declare teamId: string | null;
  declare name: string | null;
  declare createdUserId: string | null;
  declare creatorName: string | null;
  declare status: CreationOptional<D2cWorkspaceStatus>;
  declare activeResourceRevisionId: string | null;
  declare configRevision: CreationOptional<number>;
  declare configJson: Record<string, unknown> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date | null>;
}

/** 仅注册工作区模型，不连接数据库或执行 DDL。 */
export function initD2cWorkspace(sequelize: Sequelize) {
  D2cWorkspace.init(
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
        comment: '自增内部主键',
      },
      workspaceId: { type: DataTypes.STRING(64), allowNull: true, comment: '工作区业务 ID' },
      teamId: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: '共享团队业务 ID，NULL 为个人工作区',
      },
      name: { type: DataTypes.STRING(200), allowNull: true, comment: '显示名称' },
      createdUserId: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: '服务端 账号认证 用户 ID',
      },
      creatorName: { type: DataTypes.STRING(100), allowNull: true, comment: '创建者显示姓名' },
      status: {
        type: DataTypes.ENUM('preparing', 'ready', 'updating', 'failed'),
        allowNull: false,
        defaultValue: 'preparing',
        comment: '业务状态',
      },
      activeResourceRevisionId: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: '当前固定资源修订 ID',
      },
      configRevision: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: '配置修订号',
      },
      configJson: { type: DataTypes.JSON, allowNull: true, comment: 'H5/RN 配置集，不含密钥' },
      createdAt: {
        type: DataTypes.DATE(3),
        allowNull: false,
        defaultValue: literal('CURRENT_TIMESTAMP(3)'),
        comment: '数据库创建时间',
      },
      updatedAt: {
        type: DataTypes.DATE(3),
        allowNull: false,
        field: 'datachange_lasttime',
        defaultValue: literal('CURRENT_TIMESTAMP(3)'),
        comment: '数据库最后更新时间',
      },
      deletedAt: {
        type: DataTypes.DATE(3),
        allowNull: true,
        defaultValue: null,
        comment: '软删除时间，NULL 表示正常',
      },
    },
    {
      sequelize,
      modelName: 'D2cWorkspace',
      tableName: 'd2c_workspace',
      freezeTableName: true,
      comment: 'D2C 工作区',
      timestamps: true,
      paranoid: true,
      indexes: [
        { name: 'uk_d2c_workspace_workspaceId', unique: true, fields: ['workspaceId'] },
        { name: 'idx_d2c_workspace_creator_createdAt', fields: ['createdUserId', 'createdAt'] },
        { name: 'idx_d2c_workspace_team_createdAt', fields: ['teamId', 'createdAt'] },
      ],
    },
  );
  return D2cWorkspace;
}
