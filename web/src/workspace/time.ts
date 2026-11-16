/** 按浏览器本地日历显示时间：今天仅时分，过去六天带星期，更早带日期，跨年带年份。 */
export function formatTime(value: string | null | undefined, now = new Date()): string {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const day = (at: Date) => Date.UTC(at.getFullYear(), at.getMonth(), at.getDate());
  const distance = (day(now) - day(date)) / 86400000;
  if (distance === 0) return time;
  const calendar = `${date.getMonth() + 1}月${date.getDate()}日`;
  if (date.getFullYear() !== now.getFullYear()) return `${date.getFullYear()}年${calendar} ${time}`;
  if (distance > 0 && distance <= 6) return `星期${'日一二三四五六'[date.getDay()]} ${time}`;
  return `${calendar} ${time}`;
}
