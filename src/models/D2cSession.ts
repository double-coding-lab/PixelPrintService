import {
  DataTypes,
  Model,
  literal,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export type D2cTarget = 'h5' | 'rn';

/** 会话行承载文件和时间线修订；事务锁及 activeRunId 共同控制并发执行。 */
export class D2cSession extends Model<
  InferAttributes<D2cSession>,
  InferCreationAttributes<D2cSession>
> {
  declare id: CreationOptional<string>;
  declare sessionId: string | null;
  declare workspaceId: string | null;
  declare createdUserId: string | null;
  declare creatorName: string | null;
  declare name: string | null;
  declare target: D2cTarget | null;
  declare figmaUrl: string | null;
  declare credentialId: string | null;
  declare modelCredentialId: string | null;
  declare fileRevision: CreationOptional<number>;
  declare timelineSeq: CreationOptional<number>;
  declare activeRunId: string | null;
  declare contextSummary: string | null;
  declare summaryThroughSeq: CreationOptional<number>;
  declare validationState: Record<string, unknown> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date | null>;
}

/** 仅注册会话模型；idle/busy 由业务层按运行状态推导。 */
export function initD2cSession(sequelize: Sequelize) {
  D2cSession.init(
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
        comment: '自增内部主键',
      },
      sessionId: { type: DataTypes.STRING(64), allowNull: true, comment: '会话业务 ID' },
      workspaceId: { type: DataTypes.STRING(64), allowNull: true, comment: '工作区业务 ID' },
      createdUserId: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: '会话创建者用户 ID，历史记录允许 NULL',
      },
      creatorName: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: '会话创建者显示姓名，历史记录允许 NULL',
      },
      name: { type: DataTypes.STRING(200), allowNull: true, comment: '显示名称' },
      target: { type: DataTypes.ENUM('h5', 'rn'), allowNull: true, comment: '生成目标 H5 或 RN' },
      figmaUrl: { type: DataTypes.TEXT, allowNull: true, comment: '设计稿链接' },
      credentialId: { type: DataTypes.STRING(64), allowNull: true, comment: '关联凭据业务 ID' },
      modelCredentialId: {
        type: DataTypes.STRING(64),
        allowNull: true,
        defaultValue: null,
        comment: '本人固定模型 Token 修订，NULL 沿用平台模型',
      },
      fileRevision: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: '稳定文件修订号',
      },
      timelineSeq: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: '时间线最后序号',
      },
      activeRunId: { type: DataTypes.STRING(64), allowNull: true, comment: '当前未结束轮次 ID' },
      contextSummary: {
        type: DataTypes.TEXT('long'),
        allowNull: true,
        comment: '私有会话上下文摘要',
      },
      summaryThroughSeq: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: '摘要覆盖的时间线序号',
      },
      validationState: { type: DataTypes.JSON, allowNull: true, comment: '当前产物校验状态' },
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
      modelName: 'D2cSession',
      tableName: 'd2c_session',
      freezeTableName: true,
      comment: 'D2C 会话',
      timestamps: true,
      paranoid: true,
      indexes: [
        { name: 'uk_d2c_session_sessionId', unique: true, fields: ['sessionId'] },
        { name: 'idx_d2c_session_workspace_createdAt', fields: ['workspaceId', 'createdAt'] },
        { name: 'idx_d2c_session_activeRunId', fields: ['activeRunId'] },
      ],
    },
  );
  return D2cSession;
}
