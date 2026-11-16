/** 固定模板版本与生成页面入口；入口相对于 preview-template/，由接入方按产物路径调整。 */
export const previewConfig = {
  revision: 'h5-react-scss-v3',
  target: 'h5',
  unit: { outputUnit: 'vw', outputBase: 750 },
  entry: 'pages/page/index.tsx',
} as const;
