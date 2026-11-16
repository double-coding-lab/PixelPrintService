import React from 'react';

export type FileIconKind =
  | 'folder'
  | 'javascript'
  | 'typescript'
  | 'react-javascript'
  | 'react-typescript'
  | 'css'
  | 'sass'
  | 'json'
  | 'html'
  | 'markdown'
  | 'image'
  | 'file';

export type FileTypeIconProps = {
  path: string;
  directory?: boolean;
  expanded?: boolean;
};

const extensions: Record<string, FileIconKind> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  jsx: 'react-javascript',
  tsx: 'react-typescript',
  css: 'css',
  less: 'css',
  scss: 'sass',
  sass: 'sass',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'image',
  tif: 'image',
  tiff: 'image',
};

/** Classify only the final filename extension; directory status takes precedence. */
export function fileIconKind(path: string, directory = false): FileIconKind {
  if (directory) return 'folder';
  const name = path.split(/[\\/]/).at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'file';
  const extension = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(extensions, extension) ? extensions[extension] : 'file';
}

/** Render decorative, local SVG marks beside the existing accessible filename. */
export default function FileTypeIcon({
  path,
  directory = false,
  expanded = false,
}: FileTypeIconProps) {
  const kind = fileIconKind(path, directory);
  let mark: React.ReactNode;
  switch (kind) {
    case 'folder':
      mark = expanded ? (
        <>
          <path d="M2 6V3.5h6l2 2H22v3H6Z" fill="currentColor" opacity=".45" />
          <path d="M2 7h20l-3 13H2Z" fill="currentColor" />
        </>
      ) : (
        <path d="M2 4h7l2 2h11v14H2Z" fill="currentColor" />
      );
      break;
    case 'react-javascript':
    case 'react-typescript':
      mark = (
        <>
          <circle cx="12" cy="12" r="1.8" fill="currentColor" />
          {[0, 60, 120].map((angle) => (
            <ellipse
              key={angle}
              cx="12"
              cy="12"
              rx="10"
              ry="4"
              transform={`rotate(${angle} 12 12)`}
            />
          ))}
        </>
      );
      break;
    case 'javascript':
    case 'typescript':
      mark = (
        <>
          <rect x="2" y="2" width="20" height="20" rx="2" fill="currentColor" stroke="none" />
          <text x="12" y="17" textAnchor="middle" className="file-type-icon-letter">
            {kind === 'javascript' ? 'JS' : 'TS'}
          </text>
        </>
      );
      break;
    case 'css':
    case 'sass':
      mark = (
        <>
          <path d="m3 2 2 18 7 2 7-2 2-18Z" />
          <path d="M16 7H8l1 5h6l-1 4-3 1-3-1" />
        </>
      );
      break;
    case 'json':
      mark = (
        <>
          <path d="M9 3H7v6l-3 3 3 3v6h2M15 3h2v6l3 3-3 3v6h-2" />
          <circle cx="12" cy="9" r="1" fill="currentColor" stroke="none" />
          <circle cx="12" cy="15" r="1" fill="currentColor" stroke="none" />
        </>
      );
      break;
    case 'html':
      mark = <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" />;
      break;
    case 'markdown':
      mark = (
        <>
          <rect x="1.5" y="4" width="21" height="16" rx="2" />
          <path d="M5 16V8l3 4 3-4v8m6-8v8m-3-3 3 3 3-3" />
        </>
      );
      break;
    case 'image':
      mark = (
        <>
          <rect x="2" y="2" width="20" height="20" rx="2" />
          <circle cx="8" cy="8" r="2" />
          <path d="m3 19 6-6 4 4 4-6 5 7" />
        </>
      );
      break;
    default:
      mark = <path d="M5 2h9l5 5v15H5Zm9 0v6h5M8 13h8m-8 4h6" />;
  }
  return (
    <svg
      className={`file-type-icon file-type-icon--${kind}`}
      data-file-icon={kind}
      data-expanded={directory ? expanded : undefined}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {mark}
    </svg>
  );
}
