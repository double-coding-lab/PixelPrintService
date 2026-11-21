import {
  DataTypes,
  Model,
  literal,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export type D2cFileKind = 'source' | 'asset' | 'attachment' | 'internal';

/** 当前文件，文本存 content，二进制存 objectLocator；路径 hash 命中后仍须核对完整 path。 */
export class D2cFile extends Model<InferAttributes<D2cFile>, InferCreationAttributes<D2cFile>> {
  declare id: CreationOptional<string>;
  declare fileId: string | null;
  declare sessionId: string | null;
  declare path: string | null;
  declare pathHash: string | null;
  declare kind: D2cFileKind | null;
  declare content: string | null;
  declare contentRef: CreationOptional<Record<string, unknown> | null>;
  declare objectLocator: Record<string, unknown> | null;
  declare mimeType: string | null;
  declare size: number | null;
  declare sha256: string | null;
  declare revision: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** 仅注册当前文件模型；业务层校验内容来源并通过 revision 条件更新。 */
export function initD2cFile(sequelize: Sequelize) {
  D2cFile.init(
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      fileId: { type: DataTypes.STRING(64), allowNull: true },
      sessionId: { type: DataTypes.STRING(64), allowNull: true },
      path: { type: DataTypes.TEXT, allowNull: true },
      pathHash: { type: DataTypes.STRING(64), allowNull: true, validate: { is: /^[a-f0-9]{64}$/ } },
      kind: { type: DataTypes.ENUM('source', 'asset', 'attachment', 'internal'), allowNull: true },
      content: { type: DataTypes.TEXT('long'), allowNull: true },
      contentRef: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '私有不可变文本正文引用，按schemaReady启用',
      },
      objectLocator: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '不可变二进制定位，不含上传凭据',
      },
      mimeType: { type: DataTypes.STRING(200), allowNull: true },
      size: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, comment: '文件字节数' },
      sha256: { type: DataTypes.STRING(64), allowNull: true, validate: { is: /^[a-f0-9]{64}$/ } },
      revision: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      createdAt: {
        type: DataTypes.DATE(3),
        allowNull: false,
        defaultValue: literal('CURRENT_TIMESTAMP(3)'),
      },
      updatedAt: { type: DataTypes.DATE(3), allowNull: false, field: 'datachange_lasttime' },
    },
    {
      sequelize,
      modelName: 'D2cFile',
      tableName: 'd2c_file',
      freezeTableName: true,
      timestamps: true,
      defaultScope: { attributes: { exclude: ['contentRef'] } },
      scopes: { contentBody: {} },
      indexes: [
        { name: 'uk_d2c_file_fileId', unique: true, fields: ['fileId'] },
        { name: 'uk_d2c_file_session_pathHash', unique: true, fields: ['sessionId', 'pathHash'] },
      ],
    },
  );
  return D2cFile;
}
