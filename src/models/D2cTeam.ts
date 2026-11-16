import {
  DataTypes,
  Model,
  literal,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

/** D2C 协作团队；角色由团队创建者派生。 */
export class D2cTeam extends Model<InferAttributes<D2cTeam>, InferCreationAttributes<D2cTeam>> {
  declare id: CreationOptional<string>;
  declare teamId: CreationOptional<string>;
  declare name: CreationOptional<string>;
  declare createdUserId: CreationOptional<string>;
  declare creatorName: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** 仅注册模型，不连接、建表或自动迁移。 */
export function initD2cTeam(sequelize: Sequelize) {
  D2cTeam.init(
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
        comment: '团队业务 ID',
      },
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
        defaultValue: '',
        comment: '团队名称',
      },
      createdUserId: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: '创建者用户 ID，去首尾空白并转小写',
      },
      creatorName: { type: DataTypes.STRING(100), allowNull: true, comment: '创建者显示姓名' },
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
      modelName: 'D2cTeam',
      tableName: 'd2c_team',
      freezeTableName: true,
      timestamps: true,
      comment: 'D2C 协作团队',
      indexes: [
        { name: 'uk_d2c_team_teamId', unique: true, fields: ['teamId'] },
        { name: 'idx_d2c_team_creator_createdAt', fields: ['createdUserId', 'createdAt'] },
      ],
    },
  );
  return D2cTeam;
}
