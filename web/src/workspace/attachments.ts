import { data, errorMessage, id } from './api';

export const maxImages = 4;
export const maxImageBytes = 10 * 1024 * 1024;
export const imageTypes = ['image/png', 'image/jpeg', 'image/webp'];
export type MessageAttachment = {
  attachmentId: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  size: number;
};
export type DraftImage = {
  key: string;
  file: File;
  url: string;
  status: 'uploading' | 'ready' | 'failed';
  attachment?: MessageAttachment;
  error?: string;
};

/** 前端限额仅提前反馈，服务端仍按真实类型及通道上限校验。 */
export function imageValidation(file: Pick<File, 'type' | 'size'>) {
  if (!imageTypes.includes(file.type)) return '仅支持 PNG、JPEG 和 WebP 图片';
  if (file.size <= 0 || file.size > maxImageBytes)
    return '单张图片须大于 0 且不超过 10 MiB，服务端可能有更低上限';
  return '';
}

/** 文件读取随会话取消，base64 只用于上传，不放进消息或历史。 */
export function imageBase64(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    /** 所有终态移除取消监听，避免保留图片载荷。 */
    function finish(error?: unknown) {
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(String(reader.result).split(',')[1]);
    }
    /** 会话切换或移除图片时终止本地读取。 */
    function abort() {
      reader.abort();
      finish(new DOMException('已取消', 'AbortError'));
    }
    reader.onload = () => finish();
    reader.onerror = () => finish(reader.error || new Error('图片读取失败'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else reader.readAsDataURL(file);
  });
}

/** 同源上传沿用会话鉴权和 API 错误响应；后端负责持久化二进制。 */
export async function uploadImage(sessionId: string, file: File, signal: AbortSignal) {
  const base64 = await imageBase64(file, signal);
  if (signal.aborted) throw new DOMException('已取消', 'AbortError');
  return data<MessageAttachment>(`/sessions/${id(sessionId)}/attachments`, {
    method: 'POST',
    body: JSON.stringify({ fileName: file.name, mimeType: file.type, base64 }),
    signal,
  });
}

/** 同步预占四张容量，隔离移除、重试与旧会话的异步上传结果。 */
export function createImageDraft({
  sessionId,
  onChange,
  onError,
  upload = uploadImage,
  createUrl = URL.createObjectURL,
  revokeUrl = URL.revokeObjectURL,
}: {
  sessionId: string;
  onChange: (images: DraftImage[]) => void;
  onError: (message: string) => void;
  upload?: typeof uploadImage;
  createUrl?: typeof URL.createObjectURL;
  revokeUrl?: typeof URL.revokeObjectURL;
}) {
  let images: DraftImage[] = [];
  let disposed = false;
  const requests = new Map<string, AbortController>();

  /** 发布新快照，不直接修改 React 正在展示的数组。 */
  function publish() {
    if (!disposed) onChange([...images]);
  }

  /** 失败保留本地缩略图，显式重试才重新上传。 */
  async function start(key: string) {
    const image = images.find((item) => item.key === key);
    if (!image || disposed) return;
    requests.get(key)?.abort();
    const controller = new AbortController();
    requests.set(key, controller);
    images = images.map((item) =>
      item.key === key ? { ...item, status: 'uploading', error: undefined } : item,
    );
    publish();
    try {
      const attachment = await upload(sessionId, image.file, controller.signal);
      if (disposed || controller.signal.aborted) return;
      images = images.map((item) =>
        item.key === key ? { ...item, status: 'ready', attachment } : item,
      );
    } catch (reason) {
      if (disposed || controller.signal.aborted) return;
      images = images.map((item) =>
        item.key === key ? { ...item, status: 'failed', error: errorMessage(reason) } : item,
      );
    } finally {
      if (requests.get(key) === controller) requests.delete(key);
      if (!controller.signal.aborted) publish();
    }
  }

  /** 清除图片和对象 URL，同时取消所有未结束上传。 */
  function clear() {
    for (const request of requests.values()) request.abort();
    requests.clear();
    for (const image of images) revokeUrl(image.url);
    images = [];
    publish();
  }

  return {
    /** 粘贴和文件选择共用校验；超额不会替换已有图片。 */
    add(files: File[]) {
      if (disposed) return;
      let message = '';
      for (const file of files) {
        const invalid = imageValidation(file);
        if (invalid) {
          message = invalid;
          continue;
        }
        if (images.length >= maxImages) {
          message = '每条消息最多 4 张图片';
          continue;
        }
        const key = crypto.randomUUID();
        images = [...images, { key, file, url: createUrl(file), status: 'uploading' }];
        void start(key);
      }
      onError(message);
    },
    /** 移除立即释放容量，晚到上传结果不会恢复已删图片。 */
    remove(key: string) {
      requests.get(key)?.abort();
      requests.delete(key);
      const image = images.find((item) => item.key === key);
      if (image) revokeUrl(image.url);
      images = images.filter((item) => item.key !== key);
      publish();
    },
    retry: start,
    clear,
    /** 卸载后不再向组件写状态。 */
    dispose() {
      disposed = true;
      clear();
    },
  };
}

/** 发送失败重试必须同时比较正文及有序附件身份。 */
export function messageInput(
  content: string,
  images: DraftImage[],
  previous: { content: string; attachmentIds?: string[]; clientRequestId: string } | null,
) {
  if (images.some((image) => image.status !== 'ready' || !image.attachment)) return null;
  const attachmentIds = images.map((image) => image.attachment!.attachmentId);
  if (!content.trim() && !attachmentIds.length) return null;
  if (
    previous?.content === content &&
    JSON.stringify(previous.attachmentIds ?? []) === JSON.stringify(attachmentIds)
  )
    return previous;
  return {
    content,
    ...(attachmentIds.length ? { attachmentIds } : {}),
    clientRequestId: crypto.randomUUID(),
  };
}
