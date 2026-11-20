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
export class D2cSavedWorkFile extends Model<
  InferAttributes<D2cSavedWorkFile>,
  InferCreationAttributes<D2cSavedWorkFile>
> {
  declare id: CreationOptional<string>;
  declare workId: CreationOptional<string>;
  declare ownerEid: CreationOptional<string>;
  declare workRevision: CreationOptional<number>;
  declare path: string | null;
  declare pathHash: CreationOptional<string>;
  declare kind: CreationOptional<'source' | 'asset' | 'attachment'>;
  declare content: string | null;
  declare contentRef: CreationOptional<Record<string, unknown> | null>;
  declare objectLocator: Record<string, unknown> | null;
  declare size: CreationOptional<number>;
  declare sha256: CreationOptional<string>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
/** 仅注册模型；迁移与 registry 由主集成维护。 */
export function initD2cSavedWorkFile(sequelize: Sequelize) {
  D2cSavedWorkFile.init(
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
        comment: '所属个人作品',
      },
      ownerEid: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: '服务端身份；文件查询必须匹配',
      },
      workRevision: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 1,
        comment: '不可变作品快照修订',
      },
      path: { type: DataTypes.TEXT, allowNull: true, comment: '固定相对文件路径' },
      pathHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: '相对路径 SHA-256',
      },
      kind: {
        type: DataTypes.ENUM('source', 'asset', 'attachment'),
        allowNull: false,
        defaultValue: 'source',
        comment: '可预览或下载产物',
      },
      content: { type: DataTypes.TEXT('long'), allowNull: true, comment: '冻结源码正文' },
      contentRef: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '私有不可变文本正文引用，按schemaReady启用',
      },
      objectLocator: { type: DataTypes.JSON, allowNull: true, comment: '不可变存储定位；不含凭据' },
      size: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: '文件字节数',
      },
      sha256: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: '内容 SHA-256',
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
      modelName: 'D2cSavedWorkFile',
      tableName: 'd2c_saved_work_file',
      freezeTableName: true,
      timestamps: true,
      defaultScope: { attributes: { exclude: ['contentRef'] } },
      scopes: { contentBody: {} },
      indexes: [
        {
          name: 'uk_d2c_saved_file_owner_revision_path',
          unique: true,
          fields: ['ownerEid', 'workId', 'workRevision', 'pathHash'],
        },
      ],
    },
  );
  return D2cSavedWorkFile;
}
