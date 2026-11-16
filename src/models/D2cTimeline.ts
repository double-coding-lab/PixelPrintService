import {
  DataTypes,
  Model,
  literal,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

/** 追加式会话时间线，SDK 回放和经过脱敏的 UI 展示分别存储。 */
export class D2cTimeline extends Model<
  InferAttributes<D2cTimeline>,
  InferCreationAttributes<D2cTimeline>
> {
  declare id: CreationOptional<string>;
  declare entryId: string | null;
  declare sessionId: string | null;
  declare runId: string | null;
  declare seq: number | null;
  declare kind: string | null;
  declare messageId: string | null;
  declare toolCallId: string | null;
  declare sdkItem: Record<string, unknown> | null;
  declare displayPayload: Record<string, unknown> | null;
  declare completed: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** 仅注册时间线模型；seq 在锁定会话的事务内递增，完整配对后才用于 SDK 回放。 */
export function initD2cTimeline(sequelize: Sequelize) {
  D2cTimeline.init(
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      entryId: { type: DataTypes.STRING(64), allowNull: true },
      sessionId: { type: DataTypes.STRING(64), allowNull: true },
      runId: { type: DataTypes.STRING(64), allowNull: true },
      seq: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      kind: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: 'message/tool_call/tool_result/stage/text_delta 等事件类型',
      },
      messageId: { type: DataTypes.STRING(64), allowNull: true },
      toolCallId: {
        type: DataTypes.STRING(200),
        allowNull: true,
        comment: 'SDK 调用 ID，非平台业务 UUID',
      },
      sdkItem: { type: DataTypes.JSON, allowNull: true, comment: '私有 SDK 回放记录，不含凭据' },
      displayPayload: { type: DataTypes.JSON, allowNull: true, comment: '已脱敏的 UI 展示记录' },
      completed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      createdAt: {
        type: DataTypes.DATE(3),
        allowNull: false,
        defaultValue: literal('CURRENT_TIMESTAMP(3)'),
      },
      updatedAt: { type: DataTypes.DATE(3), allowNull: false, field: 'datachange_lasttime' },
    },
    {
      sequelize,
      modelName: 'D2cTimeline',
      tableName: 'd2c_timeline',
      freezeTableName: true,
      timestamps: true,
      indexes: [
        { name: 'uk_d2c_timeline_entryId', unique: true, fields: ['entryId'] },
        { name: 'uk_d2c_timeline_session_seq', unique: true, fields: ['sessionId', 'seq'] },
        { name: 'idx_d2c_timeline_run_seq', fields: ['runId', 'seq'] },
        { name: 'idx_d2c_timeline_session_message', fields: ['sessionId', 'messageId'] },
      ],
    },
  );
  return D2cTimeline;
}
