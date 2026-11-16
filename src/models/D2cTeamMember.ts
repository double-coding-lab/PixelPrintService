import {
  DataTypes,
  Model,
  literal,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

/** D2C 团队成员，创建者同时是不可移除成员；角色由团队创建者派生。 */
export class D2cTeamMember extends Model<
  InferAttributes<D2cTeamMember>,
  InferCreationAttributes<D2cTeamMember>
> {
  declare id: CreationOptional<string>;
  declare teamId: CreationOptional<string>;
  declare userId: CreationOptional<string>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** 仅注册模型，不连接、建表或自动迁移。 */
export function initD2cTeamMember(sequelize: Sequelize) {
  D2cTeamMember.init(
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
        comment: '自增内部主键',
      },
      teamId: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: '所属团队业务 ID',
      },
      userId: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: '成员用户 ID，去首尾空白并转小写',
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
        defaultValue: literal('CURRENT_TIMESTAMP(3)'),
        field: 'datachange_lasttime',
        comment: '数据库最后更新时间',
      },
    },
    {
      sequelize,
      modelName: 'D2cTeamMember',
      tableName: 'd2c_team_member',
      freezeTableName: true,
      timestamps: true,
      comment: 'D2C 团队成员，创建者同时是不可移除成员',
      indexes: [
        { name: 'uk_d2c_team_member_team_userId', unique: true, fields: ['teamId', 'userId'] },
        { name: 'idx_d2c_team_member_userId_team', fields: ['userId', 'teamId'] },
      ],
    },
  );
  return D2cTeamMember;
}
