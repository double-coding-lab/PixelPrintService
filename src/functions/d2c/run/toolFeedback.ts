import { z } from 'zod';
import { RunExecutionError, type FailureCode, type FailureContext } from './errors';

const definitions = {
  EDIT_REVISION_CONFLICT: [
    'adjust',
    '文件已变化，本次未修改。请重新read_file获取当前内容和sha256，再定位需替换片段。',
  ],
  EDIT_MATCH_INVALID: [
    'adjust',
    '原片段不存在或匹配多次，本次未修改。请重新读取并补充上下文，使oldText恰好匹配一次；不要盲目重写整个文件。',
  ],
  NON_TEXT_FILE: [
    'adjust',
    '此文件不能作为 UTF-8 文本读取。图片请使用 PNG、JPEG 或 WebP 原图路径读取；其他二进制文件只核对文件信息，不按文本分页。',
  ],
  INVALID_ASSET_URL: [
    'adjust',
    '源码包含本地PP图片地址，未写入或验收。请读取.d2c-cache/<设计稿fileKey>/asset-urls.json，用images中已登记的完整URL替换；禁止localhost、127.0.0.1和webapp占位前缀，不追加static目录。主Agent和子Agent遵循同一规则。',
  ],
  DELEGATION_TASK_TOO_LARGE: [
    'adjust',
    '委派说明 task 超过 8000 个 UTF-8 字节（中文通常每字 3 字节）。请缩短为目标、nodeId、必要约束和资料路径，由子 Agent 使用工具读取详细资料；不要复制 Skill、源码或节点 JSON。子任务尚未启动，可调整后重新委派。',
  ],
  UI_DELEGATION_NOT_APPLICABLE: [
    'adjust',
    'UI 子 Agent 只接受真实 sub- 分块，请提供对应 nodeId 并遵循 Skill 的 micro-sub 例外；无 sub- 页面由主 Agent 读取 Rule-Scan 报告后直接生成源码，不得把页面根的虚拟扫描块当作 UI 分块。',
  ],
  BLOCK_DIRECTORY_INVALID: [
    'adjust',
    'blocks 下的区块目录必须使用小写英文字母、数字和连字符，例如 more-benefits。物理目录不要再添加 sub- 前缀；请先确定英文别名并同步 writePaths、import 和报告路径；Figma 中文图层名与 nodeId 保留，在 .d2c-tasks.md 记录映射。未写入文件。',
  ],
  FILE_WRITE_NOT_ALLOWED: [
    'adjust',
    '此路径是受保护的配置、缓存或规则报告，未执行写入。请将执行进度记入页面目录的 .d2c-tasks.md，源码写入正常产物目录；缓存和检查报告由平台工具生成。',
  ],
  FILE_DELETE_NOT_ALLOWED: [
    'adjust',
    '仅允许删除源码；图片、附件和内部资源受保护。请读取最新图片地址表并修正引用，不要因旧读取结果而删除、重切已保存图片。',
  ],
  FILE_NOT_FOUND: ['adjust', '文件不存在，请核对 resource 和实际文件列表，不要重复猜测路径。'],
  FIGMA_CACHE_INCOMPLETE: [
    'adjust',
    '根节点缓存不完整，请先 figma fetch-node 获取会话绑定的完整根节点（不要传 depth），再 inspect-node 或检查规则；不能把被截断节点当作空节点。',
  ],
  INVALID_ARGUMENT: ['adjust', '工具参数无效，请按工具约定调整参数后再调用。'],
  RULES_FAILED: ['adjust', '规则检查未通过，请读取检查报告并修复源码后重查。'],
  NETWORK_RETRY: ['retry', '目标服务暂时不可用，可有限重试；写入结果未知时先核对已有文件。'],
  RATE_LIMITED: ['retry', '目标服务限流，请遵守等待时间后有限重试。'],
  RATE_LIMIT_WAIT: ['user', '目标服务要求较长等待时间，请稍后再继续，不提前重试。'],
  ACCESS_REQUIRED: ['user', '目标服务拒绝访问，请检查凭据、设计稿及资源访问权限。'],
  RESOURCE_UNAVAILABLE: ['user', '目标资源不可用，请核对设计稿地址、节点和访问权限。'],
  TLS_REQUIRED: ['user', 'HTTPS 信任校验失败，请检查部署 CA 与网络环境。'],
  CONFIRMATION_REQUIRED: ['user', '需要用户确认切图或尺寸告警，当前不会伪造确认。'],
  RETRY_EXHAUSTED: ['user', '本轮工具重试次数已用完，请处理服务或网络问题后再继续。'],
  ADJUSTMENT_EXHAUSTED: ['user', '本轮同类工具纠错次数已用完，请核对文件和参数后再继续。'],
} as const;
export type ToolFeedbackCode = keyof typeof definitions;

/** 对外只投影固定分类和提示，不读取上游错误正文来决定分类。 */
export const toolFeedbackSchema = z
  .object({
    type: z.literal('tool_feedback'),
    ok: z.literal(false),
    code: z.enum(Object.keys(definitions) as [ToolFeedbackCode, ...ToolFeedbackCode[]]),
    retryAfterMs: z.number().int().min(0).max(300000).optional(),
    path: z.string().max(1024).optional(),
    resource: z.boolean().optional(),
    detail: z.string().max(2000).optional(),
  })
  .transform((value) => ({
    ...value,
    action: definitions[value.code][0],
    message: definitions[value.code][1] + (value.detail ? ` ${value.detail}` : ''),
    retryable: definitions[value.code][0] === 'retry',
  }));
export type ToolFeedback = z.output<typeof toolFeedbackSchema>;

/** 构造可传给模型的工具结果；false 表示操作未成功，不代表整轮必须终止。 */
export function toolFeedback(
  code: ToolFeedbackCode,
  extra: { path?: string; resource?: boolean; retryAfterMs?: number; detail?: string } = {},
) {
  return toolFeedbackSchema.parse({ type: 'tool_feedback', ok: false, code, ...extra });
}

/** 只解析可信工具返回的结构化反馈，普通正文和任意错误字符串不参与分类。 */
export function readToolFeedback(output: unknown): ToolFeedback | undefined {
  /** SDK 会把字符串工具结果封装为 text 对象；只拆单个文本块，不拼接图片或文件。 */
  const block = Array.isArray(output) && output.length === 1 ? output[0] : output;
  if (block && typeof block === 'object' && ['text', 'input_text'].includes(block.type))
    output = block.text;
  if (typeof output !== 'string') return;
  try {
    const result = toolFeedbackSchema.safeParse(JSON.parse(output));
    return result.success ? result.data : undefined;
  } catch {
    return;
  }
}

/** 可纠正或需用户处理的问题与必须中断的运行异常使用不同类型。 */
export class ToolIssue extends Error {
  constructor(
    public readonly feedback: ToolFeedback,
    public readonly failure: RunExecutionError,
  ) {
    super(feedback.message);
    this.name = 'ToolIssue';
  }
}

/** 将工具问题绑定固定失败码，需用户处理时用于本轮结算与前端提示。 */
export function toolIssue(
  code: ToolFeedbackCode,
  failureCode: FailureCode,
  context: FailureContext,
  extra: { retryAfterMs?: number; path?: string; resource?: boolean; detail?: string } = {},
) {
  return new ToolIssue(
    toolFeedback(code, extra),
    new RunExecutionError(failureCode, { ...context, requiresUser: true }),
  );
}
