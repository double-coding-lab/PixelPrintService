import {
  DataTypes,
  Model,
  literal,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

/** d2c_agent_write 的离线声明；初始化不连接数据库或执行 DDL。 */
export class D2cAgentWrite extends Model<
  InferAttributes<D2cAgentWrite>,
  InferCreationAttributes<D2cAgentWrite>
> {
  declare id: CreationOptional<string>;
  declare sessionId: CreationOptional<string>;
  declare threadId: CreationOptional<string>;
  declare namespaceHash: CreationOptional<string>;
  declare checkpointNs: string | null;
  declare checkpointId: CreationOptional<string>;
  declare taskHash: CreationOptional<string>;
  declare taskId: string | null;
  declare taskPath: string | null;
  declare idx: CreationOptional<number>;
  declare channel: string | null;
  declare valueType: CreationOptional<string>;
  declare value: Buffer | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** 注册候选模型，由主注册器显式装配；禁止 sync/alter。 */
export function initD2cAgentWrite(sequelize: Sequelize) {
  D2cAgentWrite.init(
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
        comment: '内部自增 ID，应用按字符串处理',
      },
      sessionId: {
        type: DataTypes.STRING(36),
        allowNull: false,
        defaultValue: '',
        comment: '所属会话 UUID',
      },
      threadId: {
        type: DataTypes.STRING(40),
        allowNull: false,
        defaultValue: '',
        comment: '固定 d2c:会话UUID，按原文核对',
      },
      namespaceHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: 'namespace UTF-8 SHA-256 索引',
      },
      checkpointNs: {
        type: DataTypes.TEXT('long'),
        allowNull: true,
        comment: '完整 namespace，hash 命中后核对原文',
      },
      checkpointId: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: '检查点 ID，ASCII 字节顺序',
      },
      taskHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: 'taskId UTF-8 SHA-256 索引',
      },
      taskId: {
        type: DataTypes.TEXT('long'),
        allowNull: true,
        comment: '完整 taskId，hash 命中后核对原文',
      },
      taskPath: {
        type: DataTypes.TEXT('long'),
        allowNull: true,
        comment: 'SDK writesSortKey 的任务路径',
      },
      idx: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '普通写序号；特殊写使用 WRITES_IDX_MAP 负序号',
      },
      channel: {
        field: 'channelName',
        type: DataTypes.TEXT('long'),
        allowNull: true,
        comment: '完整 channel 名称',
      },
      valueType: {
        type: DataTypes.STRING(128),
        allowNull: false,
        defaultValue: '',
        comment: 'serde typed 写值编码',
      },
      value: {
        field: 'writePayload',
        type: DataTypes.BLOB('long'),
        allowNull: true,
        comment: 'typed pending write 值',
      },
      createdAt: {
        type: DataTypes.DATE(3),
        allowNull: false,
        defaultValue: literal('CURRENT_TIMESTAMP(3)'),
        comment: '创建时间',
      },
      updatedAt: {
        type: DataTypes.DATE(3),
        allowNull: false,
        defaultValue: literal('CURRENT_TIMESTAMP(3)'),
        field: 'datachange_lasttime',
        comment: '数据库变更时间',
      },
    },
    {
      sequelize,
      modelName: 'D2cAgentWrite',
      tableName: 'd2c_agent_write',
      freezeTableName: true,
      timestamps: true,
      charset: 'utf8mb4',
      collate: 'utf8mb4_bin',
      indexes: [
        {
          name: 'uk_d2c_agent_write_key',
          unique: true,
          fields: ['sessionId', 'namespaceHash', 'checkpointId', 'taskHash', 'idx'],
        },
      ],
    },
  );
  return D2cAgentWrite;
}
