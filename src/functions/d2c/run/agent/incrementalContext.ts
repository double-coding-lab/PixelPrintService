import { createHash } from 'node:crypto';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
  ToolMessageChunk,
  type BaseMessage,
} from '@langchain/core/messages';
import type { HistoryArchive } from './archive';
import { confirmedWrite } from './context';
import { readToolFeedback } from '../toolFeedback';
import { estimateTokens } from './tokens';

/** 只接受源码的正常文本分页；规则、设计资料、多媒体及未识别的响应仍原样保留。 */
function sourcePage(text: string, path: string) {
  try {
    const page = JSON.parse(text);
    return (
      page &&
      typeof page === 'object' &&
      !Array.isArray(page) &&
      Object.keys(page).every((key) =>
        ['path', 'content', 'offset', 'totalCharacters', 'nextOffset', 'sha256'].includes(key),
      ) &&
      (page.path === undefined || page.path === path) &&
      typeof page.content === 'string' &&
      Number.isSafeInteger(page.offset) &&
      page.offset >= 0 &&
      Number.isSafeInteger(page.totalCharacters) &&
      page.totalCharacters >= page.offset + page.content.length &&
      (page.nextOffset === null
        ? page.totalCharacters === page.offset + page.content.length
        : page.nextOffset === page.offset + page.content.length) &&
      (page.sha256 === undefined || /^[a-f0-9]{64}$/.test(page.sha256))
    );
  } catch {
    return false;
  }
}

/**
 * 新用户输入之前的大源码成功载荷按版本完整归档，当前轮读取仍直接可见。
 * 仅生成模型视图，不修改消息或检查点；缓存只免除已完成归档的重复写入。
 */
export function createHistoricalSourceView(archive: HistoryArchive, budget: number) {
  const saved = new Set<string>();
  return async (
    messages: BaseMessage[],
    admissionId?: string,
    start = 0,
  ): Promise<BaseMessage[]> => {
    if (!admissionId) return messages;
    const boundaries = messages
      .map((message, index) =>
        HumanMessage.isInstance(message) && message.id === admissionId ? index : -1,
      )
      .filter((index) => index >= 0);
    if (boundaries.length !== 1) return messages;
    const boundary = boundaries[0];
    if (boundary <= start) return messages;
    const callCounts = new Map<string, number>();
    const resultCounts = new Map<string, number>();
    for (const message of messages) {
      if (AIMessage.isInstance(message))
        for (const call of message.tool_calls ?? [])
          if (call.id) callCounts.set(call.id, (callCounts.get(call.id) ?? 0) + 1);
      if (ToolMessage.isInstance(message))
        resultCounts.set(message.tool_call_id, (resultCounts.get(message.tool_call_id) ?? 0) + 1);
    }
    const view = [...messages];
    for (let index = start; index < boundary; index++) {
      const request = messages[index];
      if (!AIMessage.isInstance(request) || AIMessageChunk.isInstance(request)) continue;
      const replacements = new Map<string, string>();
      for (const call of request.tool_calls ?? []) {
        const path = call.args.path;
        if (
          !call.id ||
          callCounts.get(call.id) !== 1 ||
          resultCounts.get(call.id) !== 1 ||
          !['read_file', 'write_file', 'edit_file'].includes(call.name) ||
          typeof path !== 'string' ||
          path.startsWith('/') ||
          path.split('/').some((part) => part === '..' || part === '.d2c-cache') ||
          !/\.(?:[jt]sx?|s?css|sass)$/.test(path) ||
          (call.args.resource !== undefined && call.args.resource !== false)
        )
          continue;
        let resultIndex = index + 1;
        while (resultIndex < boundary && ToolMessage.isInstance(messages[resultIndex])) {
          if ((messages[resultIndex] as ToolMessage).tool_call_id === call.id) break;
          resultIndex++;
        }
        const result = messages[resultIndex];
        if (
          resultIndex >= boundary ||
          !ToolMessage.isInstance(result) ||
          ToolMessageChunk.isInstance(result) ||
          result.tool_call_id !== call.id ||
          result.status === 'error' ||
          (result.name && result.name !== call.name) ||
          typeof result.content !== 'string' ||
          readToolFeedback(result.content)
        )
          continue;
        if (
          call.name === 'read_file'
            ? !sourcePage(result.content, path)
            : !confirmedWrite(result, call.name, path)
        )
          continue;
        const payload = call.name === 'read_file' ? result.content : JSON.stringify(call.args);
        const payloadTokens = estimateTokens(payload);
        if (payloadTokens <= Math.max(128, Math.min(2048, budget * 0.1))) continue;
        const original = JSON.stringify({ request: request.toDict(), result: result.toDict() });
        if (Buffer.byteLength(original) > 8 * 1024 * 1024) continue;
        const sha256 = createHash('sha256').update(original).digest('hex');
        const archivePath = `/history/source_${sha256}.json`;
        const reference = JSON.stringify({
          type: 'historical_source_reference',
          path,
          toolCallId: call.id,
          archivePath,
          characters: original.length,
          sha256,
          message:
            '这只是模型上下文视图省略，真实文件、原始工具参数与消息均未改写，未向文件写入此占位说明。此前成功的源码操作原文及回执已按历史版本完整归档。用read_file(resource=false)读取archivePath并按nextOffset接续；当前源码另读path。此引用不表示当前版本、规则或视觉检查通过，不应重放写入。',
        });
        if (estimateTokens(reference) * (call.name === 'edit_file' ? 2 : 1) + 128 >= payloadTokens)
          continue;
        archive.assertHealthy();
        if (!saved.has(archivePath)) {
          const cached = await archive.load(archivePath);
          if (cached === undefined) await archive.save(archivePath, original);
          else if (cached !== original) throw new Error('DEEP_ARCHIVE_INVALID');
          saved.add(archivePath);
        }
        archive.assertHealthy();
        if (call.name === 'read_file') {
          view[resultIndex] = new ToolMessage({
            content: reference,
            id: result.id,
            name: result.name,
            tool_call_id: result.tool_call_id,
            status: result.status,
            artifact: result.artifact,
            metadata: result.metadata,
            additional_kwargs: result.additional_kwargs,
            response_metadata: result.response_metadata,
          });
        } else replacements.set(call.id, reference);
      }
      if (replacements.size) {
        const { tool_calls: _raw, ...additional_kwargs } = request.additional_kwargs;
        view[index] = new AIMessage({
          id: request.id,
          name: request.name,
          content: request.content,
          response_metadata: request.response_metadata,
          usage_metadata: request.usage_metadata,
          invalid_tool_calls: request.invalid_tool_calls,
          additional_kwargs,
          tool_calls: request.tool_calls!.map((call) => {
            const reference = replacements.get(call.id ?? '');
            return reference
              ? {
                  ...call,
                  args: {
                    ...call.args,
                    ...(call.name === 'edit_file'
                      ? { oldText: reference, newText: reference }
                      : { content: reference }),
                  },
                }
              : call;
          }),
        });
      }
    }
    return view;
  };
}
