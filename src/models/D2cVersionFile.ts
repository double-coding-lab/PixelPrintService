import {
  DataTypes,
  Model,
  literal,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import type { D2cFileKind } from './D2cFile';

/** 版本文件复制内容与不可变对象定位，保留完整路径而不引用当前文件行。 */
export class D2cVersionFile extends Model<
  InferAttributes<D2cVersionFile>,
  InferCreationAttributes<D2cVersionFile>
> {
  declare id: CreationOptional<string>;
  declare versionId: string | null;
  declare path: string | null;
  declare pathHash: string | null;
  declare kind: D2cFileKind | null;
  declare content: string | null;
  declare objectLocator: Record<string, unknown> | null;
  declare mimeType: string | null;
  declare size: number | null;
  declare sha256: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** 仅注册版本文件模型；业务层检查所属版本、内容来源和公共下载范围。 */
export function initD2cVersionFile(sequelize: Sequelize) {
  D2cVersionFile.init(
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      versionId: { type: DataTypes.STRING(64), allowNull: true },
      path: { type: DataTypes.TEXT, allowNull: true },
      pathHash: { type: DataTypes.STRING(64), allowNull: true, validate: { is: /^[a-f0-9]{64}$/ } },
      kind: { type: DataTypes.ENUM('source', 'asset', 'attachment', 'internal'), allowNull: true },
      content: { type: DataTypes.TEXT('long'), allowNull: true },
      objectLocator: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '不可变二进制定位，不含上传凭据',
      },
      mimeType: { type: DataTypes.STRING(200), allowNull: true },
      size: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, comment: '文件字节数' },
      sha256: { type: DataTypes.STRING(64), allowNull: true, validate: { is: /^[a-f0-9]{64}$/ } },
      createdAt: {
        type: DataTypes.DATE(3),
        allowNull: false,
        defaultValue: literal('CURRENT_TIMESTAMP(3)'),
      },
      updatedAt: { type: DataTypes.DATE(3), allowNull: false, field: 'datachange_lasttime' },
    },
    {
      sequelize,
      modelName: 'D2cVersionFile',
      tableName: 'd2c_version_file',
      freezeTableName: true,
      timestamps: true,
      indexes: [
        {
          name: 'uk_d2c_version_file_version_pathHash',
          unique: true,
          fields: ['versionId', 'pathHash'],
        },
      ],
    },
  );
  return D2cVersionFile;
}
