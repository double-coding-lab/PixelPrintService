import type { NativeRuleScanResult } from './ruleScan/index';

/** 持久图片只保存会话内身份；capture 由预览解析器处理，不接受外部 URL。 */
export type StoredImageReference = { sessionId?: string } & (
  | { attachmentId: string; captureId?: never }
  | { captureId: string; attachmentId?: never }
);
export type StoredImageBlock = { type: 'input_image' } & StoredImageReference;
export type StoredTextBlock = {
  type: 'input_text' | 'output_text';
  text: string;
  annotations?: unknown[];
  providerData?: Record<string, unknown>;
};

/** 已存储的文本和图片引用历史；不持久化模型请求的 data URI。 */
export type StoredAgentMessage =
  | {
      type?: 'message';
      role: 'user' | 'assistant';
      content: string | Array<StoredTextBlock | StoredImageBlock>;
      status?: 'completed' | 'in_progress' | 'incomplete';
      id?: string;
      providerData?: Record<string, unknown>;
    }
  | {
      type: 'function_call';
      callId: string;
      name: string;
      arguments: string;
      status?: 'completed' | 'in_progress' | 'incomplete';
      id?: string;
      namespace?: string | null;
      caller?: { type: string };
      providerData?: Record<string, unknown>;
    }
  | {
      type: 'function_call_result';
      callId: string;
      name?: string;
      status: 'completed' | 'in_progress' | 'incomplete';
      output: string | { type: 'text'; text: string } | Array<{ type: 'input_text'; text: string }>;
      id?: string;
      namespace?: string | null;
      caller?: { type: string };
      providerData?: Record<string, unknown>;
    };

export type AgentRecord = {
  streamId?: string;
  kind: 'message' | 'tool_call' | 'tool_result';
  sdkItem: Record<string, unknown>;
  text?: string;
  name?: string;
  callId?: string;
};

export type SliceDesign = {
  figmaUrl: string;
  baseUrl?: string;
  names?: Record<string, string>;
};

/** 文件与脚本能力由执行器提供，执行内核不持有数据库连接或 Figma 凭据。 */
export interface GenerationTools {
  /** 服务端固定输入摘要，用于子任务恢复失效判断，不注册为模型工具。 */
  subagentContext?(role?: string): Promise<string>;
  /** 本轮统一的目录与合并约定，只由平台生成。 */
  outputPlan?: string;
  /** 按已读文件摘要精确替换一个片段，权限与完整写入相同。 */
  edit?(
    relative: string,
    oldText: string,
    newText: string,
    expectedSha256: string,
  ): Promise<string>;
  list(): Promise<string[]>;
  read(relative: string, resource: boolean, offset?: number, length?: number): Promise<string>;
  write(relative: string, content: string): Promise<string>;
  remove(relative: string): Promise<string>;
  figma(
    command: string,
    args: {
      figmaUrl?: string;
      rootNodeId?: string;
      nodeId?: string;
      depth?: number;
      filename?: string;
      format?: string;
      scale?: number;
      subtree?: boolean;
      offset?: number;
      limit?: number;
    },
  ): Promise<string>;
  rules(relative: string, mode: 'block' | 'merge'): Promise<string>;
  /** 仅计算绑定设计稿规则报告；保存由调用方沿用既有写权限和租约事务。 */
  scanRules?(relative: string, nodeId?: string): Promise<NativeRuleScanResult>;
  slices(
    slug: string,
    options?: Omit<SliceDesign, 'figmaUrl'> & { figmaUrl?: string },
  ): Promise<string>;
  /** 当前会话预览和实际截图；测试或未装配环境可省略，不影响文本工具。 */
  preview?: {
    /** 已有自动编译的有界失败诊断；只读查询，不创建构建，同一失败只返回一次。 */
    feedback?(): Promise<string | undefined>;
    build(entryPath?: string): Promise<string>;
    inspect(entryPath?: string): Promise<string>;
    needsInspection(): Promise<boolean>;
  };
}
