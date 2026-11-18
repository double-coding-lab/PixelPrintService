import {
  DataTypes,
  Model,
  literal,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
/** 独立持久快照；不关联公开版本或源会话删除。 */
export class D2cSavedWork extends Model<
  InferAttributes<D2cSavedWork>,
  InferCreationAttributes<D2cSavedWork>
> {
  declare id: CreationOptional<string>;
  declare workId: CreationOptional<string>;
  declare ownerEid: CreationOptional<string>;
  declare name: CreationOptional<string>;
  declare target: CreationOptional<'h5' | 'rn'>;
  declare revision: CreationOptional<number>;
  declare editId: CreationOptional<string>;
  declare editRevision: CreationOptional<number>;
  declare lastSaveKey: CreationOptional<string>;
  declare sourceId: CreationOptional<string>;
  declare baseFileRevision: CreationOptional<number>;
  declare entryPath: string | null;
  declare entries: string[] | null;
  declare configSnapshot: Record<string, unknown> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
/** 仅注册模型；迁移与 registry 由主集成维护。 */
export function initD2cSavedWork(sequelize: Sequelize) {
  D2cSavedWork.init(
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
        comment: '自增主键',
      },
      workId: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: '个人作品业务标识',
      },
      ownerEid: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: '服务端身份；所有查询必须匹配',
      },
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
        defaultValue: '',
        comment: '个人作品名称',
      },
      target: {
        type: DataTypes.ENUM('h5', 'rn'),
        allowNull: false,
        defaultValue: 'h5',
        comment: '固定预览目标',
      },
      revision: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 1,
        comment: '作品乐观锁修订',
      },
      editId: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: '首次保存的副本标识；后续不改',
      },
      editRevision: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: '首次保存的副本修订；后续不改',
      },
      lastSaveKey: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: '最近一次 editId/revision 摘要；重试重放',
      },
      sourceId: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: '来源标识，仅溯源，无外键或生命周期依赖',
      },
      baseFileRevision: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: '最近保存时的副本基线修订',
      },
      entryPath: { type: DataTypes.TEXT, allowNull: true, comment: '固定预览入口' },
      entries: { type: DataTypes.JSON, allowNull: true, comment: '冻结入口清单' },
      configSnapshot: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '仅预览运行时白名单，不保存模型或凭据',
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
        comment: '更新时间',
      },
    },
    {
      sequelize,
      modelName: 'D2cSavedWork',
      tableName: 'd2c_saved_work',
      freezeTableName: true,
      timestamps: true,
      indexes: [
        { name: 'uk_d2c_saved_work_id', unique: true, fields: ['workId'] },
        {
          name: 'uk_d2c_saved_work_owner_edit',
          unique: true,
          fields: ['ownerEid', 'editId', 'editRevision'],
        },
        { name: 'idx_d2c_saved_work_owner_updated', fields: ['ownerEid', 'datachange_lasttime'] },
      ],
    },
  );
  return D2cSavedWork;
}
