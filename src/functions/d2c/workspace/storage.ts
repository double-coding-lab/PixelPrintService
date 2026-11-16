import { createHash } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { StorageFileClient, StorageFileObject } from '@/hooks/tools/storage';
import {
  validateResourceBundle,
  type ResourceBundleLocator,
  type ResourceBundleStore,
} from './resources';

const zip = promisify(gzip);
const unzip = promisify(gunzip);
const maxBytes = 64 * 1024 * 1024;
const bundleFormat = 'pixelprint-resource-bundle-json-gzip-v1';
const digestPattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const locatorKeys = [
  'provider',
  'fileName',
  'url',
  'sha256',
  'size',
  'mimeType',
  'resourceBundleHash',
  'bundleFormat',
];

/** 校验持久定位元数据；固定主机、环境和下载路径的最终信任校验由 Storage 客户端负责。 */
function parseLocator(
  value: unknown,
): StorageFileObject & { resourceBundleHash: string; bundleFormat: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid locator');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== locatorKeys.length ||
    locatorKeys.some((key) => !Object.hasOwn(record, key))
  )
    throw new Error('invalid locator');
  if (
    !['local', 's3'].includes(record.provider as string) ||
    typeof record.fileName !== 'string' ||
    !record.fileName ||
    record.fileName.length > 512 ||
    typeof record.url !== 'string' ||
    typeof record.sha256 !== 'string' ||
    !digestPattern.test(record.sha256) ||
    typeof record.resourceBundleHash !== 'string' ||
    !digestPattern.test(record.resourceBundleHash) ||
    record.bundleFormat !== bundleFormat ||
    record.mimeType !== 'application/gzip' ||
    typeof record.size !== 'number' ||
    !Number.isSafeInteger(record.size) ||
    record.size <= 0 ||
    record.size > maxBytes
  )
    throw new Error('invalid locator');
  const pieces = record.fileName.split('/');
  if (
    pieces.some(
      (piece) =>
        !piece || piece === '.' || piece === '..' || /[\u0000-\u0020\u007f\\%?#]/u.test(piece),
    )
  )
    throw new Error('invalid locator');
  const url = new URL(record.url);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !decodeURIComponent(url.pathname).endsWith('/' + record.fileName)
  )
    throw new Error('invalid locator');
  return record as ReturnType<typeof parseLocator>;
}

/**
 * 将完整模板包以 JSON/GZIP 保存至 Storage，并通过不可变定位在重部署后恢复。
 * save/load 都检查文件及资源摘要；临时目录、上传凭据和底层异常正文不进入返回值。
 * @param client 已封装环境、主机白名单、大小限额与证书校验的文件客户端。
 */
export function createStorageResourceStore(client: StorageFileClient): ResourceBundleStore {
  return {
    /**
     * 校验资源包后压缩上传，复核上游返回的大小和压缩字节摘要。
     * @param context 工作区及资源修订编号，只用于构造可追踪的对象名称。
     * @returns 供数据库保存的对象定位及资源摘要，不保存上传授权或 Token。
     */
    async save(bundle, context) {
      try {
        if (
          typeof context?.workspaceId !== 'string' ||
          typeof context.resourceRevisionId !== 'string' ||
          !identifierPattern.test(context.workspaceId) ||
          !identifierPattern.test(context.resourceRevisionId)
        )
          throw new Error('invalid identity');
        const validated = validateResourceBundle(bundle);
        const json = Buffer.from(JSON.stringify(validated), 'utf8');
        if (json.length > maxBytes) throw new Error('bundle too large');
        const content = await zip(json);
        const fileName = `workspace-${context.workspaceId}-revision-${context.resourceRevisionId}.gz`;
        if (fileName.length > 200) throw new Error('filename too long');
        const object = await client.uploadFile({
          content,
          fileName,
          contentType: 'application/gzip',
        });
        const locator: ResourceBundleLocator = Object.fromEntries(
          locatorKeys.slice(0, 8).map((key) => [key, object[key as keyof StorageFileObject]]),
        );
        locator.resourceBundleHash = validated.hash;
        locator.bundleFormat = bundleFormat;
        const checked = parseLocator(locator);
        if (
          checked.size !== content.length ||
          checked.sha256 !== createHash('sha256').update(content).digest('hex')
        )
          throw new Error('invalid upload metadata');
        return locator;
      } catch {
        throw new Error('模板资源保存失败');
      }
    },
    /**
     * 从持久定位下载压缩包，再有界解压、严格 UTF-8 解码并重建资源元数据。
     * 先校验对象字节摘要，再校验包内资源摘要，损坏数据不回退到本地最新版模板。
     */
    async load(locator) {
      try {
        const checked = parseLocator(locator);
        const content = await client.downloadFile(checked);
        if (
          !Buffer.isBuffer(content) ||
          content.length !== checked.size ||
          createHash('sha256').update(content).digest('hex') !== checked.sha256
        )
          throw new Error('invalid download');
        const json = await unzip(content, { maxOutputLength: maxBytes });
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('invalid bundle');
        const validated = validateResourceBundle(
          value as Parameters<typeof validateResourceBundle>[0],
        );
        if (validated.hash !== checked.resourceBundleHash) throw new Error('invalid bundle hash');
        return validated;
      } catch {
        throw new Error('模板资源读取失败');
      }
    },
  };
}
