/** 常见手机的CSS视口尺寸，用于预览布局，不模拟设备像素比或浏览器UA。 */
export const phoneViewports = [
  { id: 'classic', label: '经典屏 · 375 × 667', width: 375, height: 667 },
  { id: 'compact', label: '全面屏 · 375 × 812', width: 375, height: 812 },
  { id: 'standard', label: '全面屏 · 390 × 844', width: 390, height: 844 },
  { id: 'large', label: '大屏 · 430 × 932', width: 430, height: 932 },
  { id: 'android', label: '安卓 · 360 × 800', width: 360, height: 800 },
  { id: 'android-large', label: '安卓大屏 · 412 × 915', width: 412, height: 915 },
] as const;

/** 等比缩放仅影响展示，iframe本身仍保持所选CSS视口尺寸。 */
export function phoneViewportScale(
  availableWidth: number,
  availableHeight: number,
  width: number,
  height: number,
) {
  if (
    ![availableWidth, availableHeight, width, height].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  )
    return 1;
  return Math.max(
    0.01,
    Math.min(
      1,
      Math.max(0, availableWidth - 32) / width,
      Math.max(0, availableHeight - 32) / height,
    ),
  );
}
