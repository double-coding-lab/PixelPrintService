import {
  DataTypes,
  Model,
  literal,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

/** d2c_agent_checkpoint 的离线声明；初始化不连接数据库或执行 DDL。 */
export class D2cAgentCheckpoint extends Model<
  InferAttributes<D2cAgentCheckpoint>,
  InferCreationAttributes<D2cAgentCheckpoint>
> {
  declare id: CreationOptional<string>;
  declare sessionId: CreationOptional<string>;
  declare threadId: CreationOptional<string>;
  declare namespaceHash: CreationOptional<string>;
  declare checkpointNs: string | null;
  declare checkpointId: CreationOptional<string>;
  declare parentCheckpointId: string | null;
  declare checkpointType: CreationOptional<string>;
  declare checkpoint: Buffer | null;
  declare metadataType: CreationOptional<string>;
  declare metadata: Buffer | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** 注册候选模型，由主注册器显式装配；禁止 sync/alter。 */
export function initD2cAgentCheckpoint(sequelize: Sequelize) {
  D2cAgentCheckpoint.init(
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
      parentCheckpointId: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: '同 namespace 的父检查点 ID',
      },
      checkpointType: {
        type: DataTypes.STRING(128),
        allowNull: false,
        defaultValue: '',
        comment: 'serde typed 检查点编码',
      },
      checkpoint: {
        field: 'checkpointPayload',
        type: DataTypes.BLOB('long'),
        allowNull: true,
        comment: '完整 typed 检查点，含全部 channel_values 与版本',
      },
      metadataType: {
        type: DataTypes.STRING(128),
        allowNull: false,
        defaultValue: '',
        comment: 'serde typed 元数据编码',
      },
      metadata: {
        field: 'metadataPayload',
        type: DataTypes.BLOB('long'),
        allowNull: true,
        comment: 'typed 元数据',
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
      modelName: 'D2cAgentCheckpoint',
      tableName: 'd2c_agent_checkpoint',
      freezeTableName: true,
      timestamps: true,
      charset: 'utf8mb4',
      collate: 'utf8mb4_bin',
      indexes: [
        {
          name: 'uk_d2c_agent_checkpoint_key',
          unique: true,
          fields: ['sessionId', 'namespaceHash', 'checkpointId'],
        },
      ],
    },
  );
  return D2cAgentCheckpoint;
}
