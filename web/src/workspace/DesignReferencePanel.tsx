import React, { useState } from 'react';
import { Alert, Button, Empty, Image, Select, Skeleton, Spin } from 'antd';
import PhonePreview, { PhonePreviewButton, usePhonePreview } from './PhonePreview';
import type { FileInfo } from './types';

/** 只选正式保存的完整目标根基准，不将切图或运行截图冒充设计原图。 */
export function designReferenceFiles(files: FileInfo[] = []) {
  return files
    .filter(
      (file) =>
        ['asset', 'attachment'].includes(file.kind) &&
        /^design-reference\/root-\d+_\d+\.png$/.test(file.path),
    )
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

/** 图片地址只来自现有文件摘要，拒绝脚本、data 和协议相对地址。 */
function imageUrl(value?: string | null) {
  if (!value || value.startsWith('//')) return undefined;
  if (value.startsWith('/') && !value.includes('\\')) return value;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** 一份固定修订的原图；切换图片后重新显示加载状态和尺寸。 */
function ReferenceImage({ file, onRefresh }: { file: FileInfo; onRefresh?: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [dimensions, setDimensions] = useState('');
  const url = imageUrl(file.url);
  const phone = usePhonePreview(loaded && !failed && !!url);
  const node = file.path.match(/root-(\d+)_(\d+)\.png$/);
  return (
    <>
      <div className="design-reference-meta">
        <span>Figma 原设计稿</span>
        {node && (
          <span>
            节点 {node[1]}:{node[2]}
          </span>
        )}
        <span>图片修订 r{file.revision}</span>
        {dimensions && <span>{dimensions}</span>}
        <PhonePreviewButton preview={phone} />
        {onRefresh && (
          <Button
            size="small"
            type="text"
            onClick={() => {
              setFailed(false);
              setLoaded(false);
              onRefresh();
            }}
          >
            刷新
          </Button>
        )}
      </div>
      {!url || failed ? (
        <Alert
          type="warning"
          showIcon
          title="设计稿截图暂不可用"
          description="请刷新重试，或在源码与资源中检查已保存的基准图。"
        />
      ) : (
        <>
          {!loaded && (
            <div className="design-reference-loading" role="status">
              <Spin size="small" />
              <span>正在加载设计稿…</span>
            </div>
          )}
          <PhonePreview preview={phone}>
            <div className="design-reference-canvas">
              <Image
                src={url}
                referrerPolicy="no-referrer"
                alt={`原设计稿截图${node ? `，节点 ${node[1]}:${node[2]}` : ''}`}
                preview={{ mask: '放大查看原图' }}
                onLoad={(event) => {
                  const image = event.target;
                  if (image instanceof HTMLImageElement)
                    setDimensions(`${image.naturalWidth} × ${image.naturalHeight} px`);
                  setLoaded(true);
                }}
                onError={() => setFailed(true)}
              />
            </div>
          </PhonePreview>
        </>
      )}
    </>
  );
}

/** 会话读取当前稳定文件，版本读取冻结文件；均不重新下载 Figma 或生成截图。 */
export default function DesignReferencePanel({
  files,
  loading = false,
  onRefresh,
}: {
  files?: FileInfo[];
  loading?: boolean;
  onRefresh?: () => void;
}) {
  const [selected, setSelected] = useState('');
  const images = designReferenceFiles(files);
  const file = images.find((image) => image.fileId === selected) ?? images[0];
  return (
    <section className="design-reference-panel" aria-label="原设计稿截图">
      {loading && !file ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : !file ? (
        <Empty description="暂无原设计稿截图。Agent 保存完整目标根的设计基准后，会显示在这里。">
          {onRefresh && <Button onClick={onRefresh}>刷新</Button>}
        </Empty>
      ) : (
        <>
          {images.length > 1 && (
            <Select
              aria-label="选择原设计稿截图"
              value={file.fileId}
              onChange={setSelected}
              options={images.map((image) => ({ value: image.fileId, label: image.path }))}
            />
          )}
          <ReferenceImage
            key={`${file.fileId}:${file.revision}:${file.url}`}
            file={file}
            onRefresh={onRefresh}
          />
        </>
      )}
    </section>
  );
}
