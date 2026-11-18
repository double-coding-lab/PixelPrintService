import {
  DataTypes,
  Model,
  literal,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

/** 每个会话保留一条发布状态；撤销后重新发布轮换 shareId，旧链接不复活。 */
export class D2cSessionShare extends Model<
  InferAttributes<D2cSessionShare>,
  InferCreationAttributes<D2cSessionShare>
> {
  declare id: CreationOptional<string>;
  declare sessionId: string;
  declare shareId: string;
  declare enabled: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** 仅声明结构；注册、审核 SQL 与执行迁移由应用入口管理，不自动 sync。 */
export function initD2cSessionShare(sequelize: Sequelize) {
  D2cSessionShare.init(
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
        comment: '内部自增主键',
      },
      sessionId: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: '唯一会话业务标识',
      },
      shareId: {
        type: DataTypes.STRING(36),
        allowNull: false,
        defaultValue: '',
        comment: '当前发布 UUID；重新发布轮换，撤销期间不可访问',
      },
      enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否对全部已登录用户公开',
      },
      createdAt: {
        type: DataTypes.DATE(3),
        allowNull: false,
        defaultValue: literal('CURRENT_TIMESTAMP(3)'),
        comment: '发布状态首次创建时间',
      },
      updatedAt: {
        type: DataTypes.DATE(3),
        allowNull: false,
        defaultValue: literal('CURRENT_TIMESTAMP(3)'),
        field: 'datachange_lasttime',
        comment: '发布状态最后更新时间',
      },
    },
    {
      sequelize,
      modelName: 'D2cSessionShare',
      tableName: 'd2c_session_share',
      freezeTableName: true,
      timestamps: true,
      comment: 'D2C 会话广场发布状态',
      indexes: [
        { name: 'uk_d2c_session_share_sessionId', unique: true, fields: ['sessionId'] },
        { name: 'uk_d2c_session_share_shareId', unique: true, fields: ['shareId'] },
        { name: 'idx_d2c_session_share_enabled_createdAt', fields: ['enabled', 'createdAt'] },
      ],
    },
  );
  return D2cSessionShare;
}
