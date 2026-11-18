import React, { lazy, Suspense, useEffect, useState } from 'react';
import { Alert, Image } from 'antd';
import { data, errorMessage, id } from './api';
import type { FileInfo, TextFile } from './types';
import { formatFileSize, isPreviewImage } from './fileTree';
import Icon from '../components/Icon';

const CodePreview = lazy(() => import('./CodePreview'));

/** 只以转义文本展示文件，不解析 HTML 或执行生成代码。 */
export function FileContent({ content }: { content: string }) {
  return (
    <pre className="code-editor file-preview-content" aria-label="文件内容">
      <code>{content}</code>
    </pre>
  );
}

/** 文本通过接口读取，图片使用产物直链；切换或刷新时重置加载状态。 */
export default function FilePreview({
  sessionId,
  fileId,
  current,
  apiRoot,
}: {
  apiRoot?: string;
  sessionId: string;
  fileId: string;
  current?: FileInfo;
}) {
  const [file, setFile] = useState<TextFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [dimensions, setDimensions] = useState('');
  const imageFile = isPreviewImage(current);
  const image = imageFile
    ? apiRoot
      ? `/api/d2c${apiRoot}/files/${id(fileId)}`
      : current?.url
    : null;
  const binary = !!current && ['asset', 'attachment'].includes(current.kind);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFile(null);
    setDimensions('');
    setError('');
    const path = `${apiRoot ?? `/sessions/${id(sessionId)}`}/files/${id(fileId)}`;
    if (imageFile) {
      if (!image) {
        setLoading(false);
        setError('图片链接暂不可用，请刷新文件列表');
      }
    } else if (binary) {
      setLoading(false);
    } else
      data<TextFile>(path, {
        signal: controller.signal,
      }).then(
        (value) => {
          if (!controller.signal.aborted) {
            setFile(value);
            setLoading(false);
          }
        },
        (reason) => {
          if (!controller.signal.aborted) {
            setError(errorMessage(reason));
            setLoading(false);
          }
        },
      );
    return () => controller.abort();
  }, [sessionId, fileId, current?.revision, reload, imageFile, image, binary, apiRoot]);
  return (
    <section className="file-editor" aria-label="只读文件预览">
      <div className="editor-toolbar">
        <strong title={current?.path}>{current?.path.split('/').at(-1) ?? '文件预览'}</strong>
        <button
          type="button"
          className="quiet icon-button"
          aria-label="刷新文件内容"
          title="刷新文件内容"
          disabled={loading}
          onClick={() => setReload((value) => value + 1)}
        >
          <Icon name="refresh" />
        </button>
      </div>
      <div className="file-preview-meta">
        <span title={current?.path}>{current?.path}</span>
        <small>{current ? `${formatFileSize(current.size)} · r${current.revision}` : ''}</small>
      </div>
      <div className="file-preview-body">
        {error && <Alert type="error" showIcon title={error} className="feedback-alert" />}
        {loading && (
          <p role="status" className="muted">
            正在读取文件…
          </p>
        )}
        {file && (
          <Suspense fallback={<FileContent content={file.content} />}>
            <CodePreview content={file.content} path={current?.path ?? file.path} />
          </Suspense>
        )}
        {image && (
          <div className="image-preview-canvas">
            <Image
              key={`${image}:${current?.revision}:${reload}`}
              src={image}
              referrerPolicy="no-referrer"
              alt={current?.path ?? '产物图片'}
              onLoad={(event) => {
                setLoading(false);
                const img = event.target;
                if (img instanceof HTMLImageElement)
                  setDimensions(`${img.naturalWidth} × ${img.naturalHeight}`);
              }}
              onError={() => {
                setLoading(false);
                setError('图片加载失败，可打开原图链接检查');
              }}
              preview={{ mask: '放大查看' }}
            />
          </div>
        )}
        {binary && !imageFile && <div className="editor-empty">暂不支持预览，可下载查看</div>}
      </div>
      <p className="file-preview-hint">
        {imageFile ? dimensions : ''}
        {current?.url && (
          <a
            className="file-direct-link"
            href={current.url}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            {imageFile ? '打开原图' : '打开文件链接'}
          </a>
        )}
      </p>
    </section>
  );
}
