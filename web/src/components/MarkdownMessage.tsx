import React, { createContext, useContext } from 'react';
import { Image } from 'antd';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Element, ElementContent } from 'hast';

const ImageLayoutContext = createContext<(() => void) | undefined>(undefined);
const imageBase = 'https://markdown.invalid/';

/** 图片只接受完整 HTTP(S) 地址或同源路径，拒绝空值、协议相对地址及协议混淆。 */
export function safeMarkdownImageUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !value ||
    /[\s\u0000-\u001f\u007f\\]/u.test(value) ||
    /%(?:0[\da-f]|1[\da-f]|7f|5c)/i.test(value)
  )
    return null;
  if (/^(?:\/\/|[?#])/.test(value)) return null;
  const absolute = /^[a-z][a-z\d+.-]*:/i.test(value);
  if (absolute && !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value, imageBase);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (!absolute && url.origin !== new URL(imageBase).origin) return null;
    return value;
  } catch {
    return null;
  }
}

/** 稳定的图片组件类型使流式正文更新复用原节点；加载与失败都通知父级重算布局。 */
function MarkdownImage({ src, alt, title }: React.ComponentProps<'img'>) {
  const onLayoutChange = useContext(ImageLayoutContext);
  const safeSrc = safeMarkdownImageUrl(src);
  if (!safeSrc) return <span>{alt || '图片地址不可用'}</span>;
  return (
    <Image
      src={safeSrc}
      alt={alt || '图片'}
      title={title}
      onLoad={onLayoutChange}
      onError={onLayoutChange}
      preview={{ cover: '放大查看' }}
      styles={{
        root: { display: 'inline-block', maxWidth: '100%', verticalAlign: 'middle' },
        image: {
          width: 'auto',
          height: 'auto',
          maxWidth: '100%',
          maxHeight: 480,
          objectFit: 'contain',
        },
      }}
    />
  );
}

/** Antd Image 的根节点是 div，含图片的段落改用块容器以保持有效 DOM 结构。 */
function containsImage(node: Element | ElementContent): boolean {
  return node.type === 'element' && (node.tagName === 'img' || node.children.some(containsImage));
}

/** 所有 renderer 都在模块级创建，避免流式快照或布局回调变化时重挂图片。 */
const markdownComponents: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  p: ({ node, children }) =>
    node && containsImage(node) ? (
      <div style={{ margin: '0 0 10px' }}>{children}</div>
    ) : (
      <p>{children}</p>
    ),
  table: ({ children }) => (
    <div className="markdown-table">
      <table>{children}</table>
    </div>
  ),
  img: MarkdownImage,
};

/** Markdown 将 HTML 作为文本转义；图片原尺寸内缩略展示并分组预览，布局回调可选。 */
export default function MarkdownMessage({
  text,
  onLayoutChange,
}: {
  text: string;
  /** 图片 onLoad/onError 均调用此回调，供会话维护滚动位置和布局。 */
  onLayoutChange?: () => void;
}) {
  return (
    <div className="event-content markdown-message">
      <ImageLayoutContext.Provider value={onLayoutChange}>
        <Image.PreviewGroup>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {text}
          </ReactMarkdown>
        </Image.PreviewGroup>
      </ImageLayoutContext.Provider>
    </div>
  );
}
