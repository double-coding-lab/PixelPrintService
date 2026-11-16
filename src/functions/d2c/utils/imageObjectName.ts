import { randomInt } from 'node:crypto';

const beijingTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** 仅图片使用新对象命名；字体、ZIP 和模板包继续沿用各自的存储协议。 */
export function isImageFileName(fileName: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|ico|svg|avif|bmp|tiff?)$/i.test(fileName);
}

/**
 * 以北京时间和四位密码学随机数创建图片对象名，保留原 basename。
 * 每次上传只调用一次；网络重试与重名冲突交由不可变存储客户端处理。
 */
export function imageObjectName(basename: string, now: Date = new Date()): string {
  if (
    !basename.trim() ||
    basename === '.' ||
    basename === '..' ||
    /[\\/\u0000-\u001f\u007f%?#]/u.test(basename)
  )
    throw new Error('图片对象文件名无效');
  return `${imageObjectDirectory(now)}/${basename}`;
}

/** 分配一个北京时间戳目录；页面/主题的后续上传复用已保存的目录值。 */
export function imageObjectDirectory(now: Date = new Date()): string {
  const parts = beijingTime.formatToParts(now);
  const timestamp = ['year', 'month', 'day', 'hour', 'minute', 'second']
    .map((type) => parts.find((part) => part.type === type)!.value)
    .join('');
  return `${timestamp}_${randomInt(1000, 10000)}`;
}
