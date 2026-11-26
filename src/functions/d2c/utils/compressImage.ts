import { execFile } from 'node:child_process';
import path from 'node:path';
import { applicationRoot } from '../../../paths';

export type ImageCompression = {
  content: Buffer;
  beforeBytes: number;
  afterBytes: number;
  status: 'compressed' | 'unchanged' | 'unsupported' | 'unavailable';
};

/**
 * 按 pp-image-compress 优化单图，不改变路径、尺寸、格式或解码像素。
 * Pillow 在部署时安装；超时、解码失败或无收益保留原图，取消仍终止任务。
 */
export async function compressImage(
  filename: string,
  content: Buffer,
  signal?: AbortSignal,
): Promise<ImageCompression> {
  signal?.throwIfAborted();
  const original = (status: ImageCompression['status']): ImageCompression => ({
    content,
    beforeBytes: content.length,
    afterBytes: content.length,
    status,
  });
  if (!/\.(?:png|jpe?g)$/i.test(filename)) return original('unsupported');
  const valid = /\.png$/i.test(filename)
    ? content.length >= 33 && content.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : content.length >= 4 && content.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  if (!valid || content.length > 30_000_000) return original('unchanged');
  const root = path.join(applicationRoot, 'image-compression');
  try {
    const output = await new Promise<Buffer>((resolve, reject) => {
      const child = execFile(
        path.join(root, '.venv', 'bin', 'python3'),
        ['-I', path.join(root, 'compress.py')],
        {
          encoding: 'buffer',
          maxBuffer: content.length + 65536,
          timeout: 15000,
          killSignal: 'SIGKILL',
          signal,
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(content);
    });
    signal?.throwIfAborted();
    if (!output.length || output.length >= content.length) return original('unchanged');
    return {
      content: output,
      beforeBytes: content.length,
      afterBytes: output.length,
      status: 'compressed',
    };
  } catch {
    signal?.throwIfAborted();
    return original('unavailable');
  }
}
