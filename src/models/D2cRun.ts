import {
  DataTypes,
  Model,
  literal,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export type D2cRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'stopping'
  | 'paused'
  | 'interrupted'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** 持久化轮次、无密钥快照与 worker 租约；恢复执行创建新的 runId。 */
export class D2cRun extends Model<InferAttributes<D2cRun>, InferCreationAttributes<D2cRun>> {
  declare id: CreationOptional<string>;
  declare runId: string | null;
  declare sessionId: string | null;
  declare requestedUserId: string | null;
  declare clientRequestId: string | null;
  declare status: CreationOptional<D2cRunStatus>;
  declare stage: string | null;
  declare resourceRevisionId: string | null;
  declare configRevision: number | null;
  declare configSnapshot: Record<string, unknown> | null;
  declare modelSnapshot: Record<string, unknown> | null;
  declare credentialId: string | null;
  declare baseFileRevision: number | null;
  declare resumeFromRunId: string | null;
  declare leaseOwner: string | null;
  declare leaseExpiresAt: Date | null;
  declare heartbeatAt: Date | null;
  declare stopRequested: CreationOptional<boolean>;
  declare cancelRequested: CreationOptional<boolean>;
  declare checkpoint: Record<string, unknown> | null;
  declare pendingInteraction: Record<string, unknown> | null;
  declare error: Record<string, unknown> | null;
  declare usage: Record<string, unknown> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** 仅注册执行模型；领取、续租、停止及修订检查由业务层条件更新。 */
export function initD2cRun(sequelize: Sequelize) {
  D2cRun.init(
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
        comment: '自增内部主键',
      },
      runId: { type: DataTypes.STRING(64), allowNull: true, comment: '轮次业务 ID' },
      sessionId: { type: DataTypes.STRING(64), allowNull: true, comment: '会话业务 ID' },
      requestedUserId: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: '本轮实际请求用户 ID，历史记录允许 NULL',
      },
      clientRequestId: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: '客户端幂等请求 ID',
      },
      status: {
        type: DataTypes.ENUM(
          'queued',
          'running',
          'waiting_input',
          'stopping',
          'paused',
          'interrupted',
          'succeeded',
          'failed',
          'cancelled',
        ),
        allowNull: false,
        defaultValue: 'queued',
        comment: '业务状态',
      },
      stage: { type: DataTypes.STRING(64), allowNull: true, comment: '当前执行阶段' },
      resourceRevisionId: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: '本轮固定资源修订 ID',
      },
      configRevision: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, comment: '配置修订号' },
      configSnapshot: { type: DataTypes.JSON, allowNull: true, comment: '固定配置快照，不含密钥' },
      modelSnapshot: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '模型与运行参数快照，不含 API Key',
      },
      credentialId: { type: DataTypes.STRING(64), allowNull: true, comment: '关联凭据业务 ID' },
      baseFileRevision: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
        comment: '本轮基础文件修订号',
      },
      resumeFromRunId: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: '继续执行来源轮次 ID',
      },
      leaseOwner: { type: DataTypes.STRING(128), allowNull: true, comment: '持有租约的执行实例' },
      leaseExpiresAt: { type: DataTypes.DATE(3), allowNull: true, comment: '执行租约到期时间' },
      heartbeatAt: { type: DataTypes.DATE(3), allowNull: true, comment: '最近执行心跳时间' },
      stopRequested: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否已请求停止',
      },
      cancelRequested: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否已请求取消',
      },
      checkpoint: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '私有、无密钥的稳定 SDK 检查点',
      },
      pendingInteraction: { type: DataTypes.JSON, allowNull: true, comment: '等待中的交互请求' },
      error: { type: DataTypes.JSON, allowNull: true, comment: '安全错误诊断' },
      usage: {
        type: DataTypes.JSON,
        allowNull: true,
        field: 'modelUsage',
        comment: '本轮模型用量',
      },
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
    },
    {
      sequelize,
      modelName: 'D2cRun',
      tableName: 'd2c_run',
      freezeTableName: true,
      comment: 'D2C 执行轮次',
      timestamps: true,
      indexes: [
        { name: 'uk_d2c_run_runId', unique: true, fields: ['runId'] },
        {
          name: 'uk_d2c_run_session_request',
          unique: true,
          fields: ['sessionId', 'clientRequestId'],
        },
        { name: 'idx_d2c_run_status_createdAt', fields: ['status', 'createdAt'] },
        { name: 'idx_d2c_run_leaseExpiresAt', fields: ['leaseExpiresAt'] },
        { name: 'idx_d2c_run_session_createdAt', fields: ['sessionId', 'createdAt'] },
      ],
    },
  );
  return D2cRun;
}
