import React, { type CSSProperties } from 'react';

const paths = {
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  chevron: 'm9 5 7 7-7 7',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  file: 'M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 13h8M8 17h5',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  external: 'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  maximize: 'M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5',
  minimize: 'M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5',
  panels: 'M3 4h18v16H3V4Zm11 0v16',
  folder: 'M3 7V5h6l2 2h10v12H3V7Z',
  trash: 'M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1',
  chat: 'M4 4h16v12H9l-5 4V4Z',
  code: 'm8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  pause: 'M7 5h3v14H7V5Zm7 0h3v14h-3V5Z',
  offline: 'M12 3v9M6.3 5.8a9 9 0 1 0 11.4 0',
  play: 'M9 5.8c0-.8.9-1.2 1.5-.8l8 6c.7.5.7 1.5 0 2l-8 6c-.6.4-1.5 0-1.5-.8V5.8Z',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  key: 'M14 10a5 5 0 1 0-4 4l8 7 3-3-7-8ZM6 7h.01',
};

/** 本地线性图标，不依赖网络资源，也不覆盖按钮的可访问名称。 */
export default function Icon({ name, style }: { name: keyof typeof paths; style?: CSSProperties }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path
        d={paths[name]}
        fill={name === 'play' ? 'currentColor' : undefined}
        stroke={name === 'play' ? 'none' : undefined}
      />
    </svg>
  );
}
