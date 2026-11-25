import { execFile } from 'node:child_process';
import path from 'node:path';

const maxInputBytes = 30_000_000;
const maxOutputBytes = 5_000_000;

/**
 * 异步生成首帧 WebP 缩略图：宽 ≤320、长边 ≤16383，不放大、不裁切、不修改原始字节。
 * 复用部署时准备的 Pillow；15 秒超时或取消会杀死子进程，转换失败交由调用方处理。
 * 本方法只转换字节，不上传、不排队；调用方决定何时在后台调用。
 */
export async function createWebpThumbnail(content: Buffer, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  if (!content.length || content.length > maxInputBytes) {
    throw new Error('THUMBNAIL_INPUT_LIMIT');
  }
  const root = path.resolve('image-compression');
  try {
    const output = await new Promise<Buffer>((resolve, reject) => {
      const child = execFile(
        path.join(root, '.venv', 'bin', 'python3'),
        ['-I', path.join(root, 'thumbnail.py')],
        {
          encoding: 'buffer',
          timeout: 15_000,
          killSignal: 'SIGKILL',
          maxBuffer: maxOutputBytes,
          signal,
        },
        (error, stdout, stderr) => {
          if (error) {
            const reason = stderr.toString().trim();
            reject(
              new Error(
                /^(IMAGE_PIXEL_LIMIT|THUMBNAIL_OUTPUT_LIMIT|INVALID_IMAGE|THUMBNAIL_INPUT_LIMIT)$/.test(
                  reason,
                )
                  ? reason
                  : 'THUMBNAIL_CONVERSION_FAILED',
                { cause: error },
              ),
            );
          } else {
            resolve(stdout);
          }
        },
      );
      // A rejected image or cancellation can close stdin before all input was written.
      child.stdin?.on('error', () => {});
      child.stdin?.end(content);
    });
    signal?.throwIfAborted();
    if (!output.length || output.length > maxOutputBytes) {
      throw new Error('THUMBNAIL_OUTPUT_LIMIT');
    }
    if (output.toString('ascii', 0, 4) !== 'RIFF' || output.toString('ascii', 8, 12) !== 'WEBP') {
      throw new Error('INVALID_THUMBNAIL_OUTPUT');
    }
    return output;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
}
