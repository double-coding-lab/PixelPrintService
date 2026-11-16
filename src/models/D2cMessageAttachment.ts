import {
  DataTypes,
  Model,
  literal,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

/** 用户截图单独持久化；二进制只在 Storage，消息和检查点只保存 attachmentId。 */
export class D2cMessageAttachment extends Model<
  InferAttributes<D2cMessageAttachment>,
  InferCreationAttributes<D2cMessageAttachment>
> {
  declare id: CreationOptional<string>;
  declare attachmentId: string;
  declare sessionId: string;
  declare messageId: string | null;
  declare userId: string;
  declare fileName: string;
  declare mimeType: string;
  declare size: number;
  declare sha256: string;
  declare width: number;
  declare height: number;
  declare objectLocator: Record<string, unknown> | null;
  declare expiresAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** 仅注册结构，不执行 sync/alter；由主接线加入 models/index。 */
export function initD2cMessageAttachment(sequelize: Sequelize) {
  D2cMessageAttachment.init(
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
        comment: '内部自增主键',
      },
      attachmentId: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: '附件业务标识',
      },
      sessionId: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: '所属会话标识',
      },
      messageId: {
        type: DataTypes.STRING(64),
        allowNull: true,
        defaultValue: null,
        comment: '关联用户消息；未发送为空',
      },
      userId: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: '上传用户；访问仍校验会话归属',
      },
      fileName: {
        type: DataTypes.STRING(200),
        allowNull: false,
        defaultValue: '',
        comment: '原始展示文件名',
      },
      mimeType: {
        type: DataTypes.STRING(100),
        allowNull: false,
        defaultValue: '',
        comment: '实际图片媒体类型',
      },
      size: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: '二进制字节数',
      },
      sha256: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: '',
        comment: '二进制 SHA256',
      },
      width: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: '图片像素宽度',
      },
      height: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: '图片像素高度',
      },
      objectLocator: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Storage 不可变定位；无授权材料',
      },
      expiresAt: {
        type: DataTypes.DATE(3),
        allowNull: true,
        defaultValue: null,
        comment: '未发送附件到期时间；关联后为空',
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
      modelName: 'D2cMessageAttachment',
      tableName: 'd2c_message_attachment',
      freezeTableName: true,
      timestamps: true,
      indexes: [
        { name: 'uk_d2c_attachment_id', unique: true, fields: ['attachmentId'] },
        { name: 'idx_d2c_attachment_message', fields: ['sessionId', 'messageId'] },
        { name: 'idx_d2c_attachment_expiry', fields: ['expiresAt'] },
      ],
    },
  );
  return D2cMessageAttachment;
}
