import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import responseData from '@/common/response';
import { parseD2cRuntimeConfig } from '@/config/d2c';

/** D2C 打标前缀规则，与设计侧插件保持一致。 */
const PREFIX_RULES: ReadonlyArray<readonly [string, string]> = [
  ['sub', '页面里的一级区块或独立功能区域'],
  ['img', '整块图片 / 需要切图的视觉资产'],
  ['bg', '背景图'],
  ['bgc', '父级背景装饰'],
  ['btn', '可点击区域(按钮)'],
  ['input', '输入框'],
  ['scrollx', '横向滚动容器'],
  ['scrolly', '纵向滚动容器'],
  ['fixed', '固定定位(吸顶 / 吸底 / 悬浮)'],
  ['end', '底部品牌背书区'],
  ['x', '忽略,不生成代码'],
];

const ALLOWED_PREFIX = new Set(PREFIX_RULES.map(([key]) => key));

function buildPrompt(node: unknown): string {
  return [
    '你是 Figma 设计稿打标助手。根据下面的节点结构,从「前缀规则」里选一个最合适的,并给一个简短英文小写基础名。',
    '',
    '前缀规则:',
    ...PREFIX_RULES.map(([key, desc]) => `- ${key}: ${desc}`),
    '',
    '节点结构(JSON):',
    JSON.stringify(node, null, 2),
    '',
    '只返回一个 JSON 对象,不要任何多余文字或 markdown:',
    '{"prefix":"btn","baseName":"submit","confidence":0.85,"reason":"一句话理由"}',
  ].join('\n');
}

type AiSuggestion = { prefix: string; baseName?: string; confidence?: number; reason?: string };

function parseAiJson(text: string): AiSuggestion {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const jsonStr = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    return JSON.parse(jsonStr) as AiSuggestion;
  } catch {
    // 模型偶尔输出截断或带多余字符的 JSON，按字段兜底，避免整条请求失败。
    console.warn('[d2c] 模型返回非法 JSON:', jsonStr.slice(0, 200));
    return {
      prefix: (jsonStr.match(/"prefix"\s*:\s*"([a-zA-Z]+)"/) || [])[1] || 'sub',
      baseName: (jsonStr.match(/"baseName"\s*:\s*"([^"]*)"/) || [])[1] || '',
      confidence: 0,
      reason: '模型返回格式异常，已按字段兜底',
    };
  }
}

type ModelConfig = { MODEL_BASE_URL: string; MODEL_NAME: string; MODEL_API_KEY: string };

/**
 * 单轮对话调模型网关（OpenAI 兼容），返回 assistant 文本。
 * Qwen 和 deepseek 系列默认带思考，reasoning_content 会吃光 max_tokens 导致正文空返回，必须关闭。
 */
async function callModel(cfg: ModelConfig, prompt: string): Promise<string> {
  const base = cfg.MODEL_BASE_URL.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');
  const disableThinking = /^(Qwen|deepseek)/i.test(cfg.MODEL_NAME);
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.MODEL_API_KEY}` },
    body: JSON.stringify({
      model: cfg.MODEL_NAME,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0,
      ...(disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    }),
  });
  if (!resp.ok)
    throw new Error(`模型网关 HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const body = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('模型返回内容为空');
  return text.trim();
}

/**
 * 注册 D2C 打标插件接口，挂载于 d2c 模块下，继承 registerAuthGuard 的登录校验。
 * Figma 插件可使用项目配置中的个人 API Token；
 * 面向跨源调用，不做同源标记检查。
 */
export default async function pluginRoutes(app: FastifyInstance) {
  /**
   * POST /api/d2c/plugin/suggest-prefix：根据节点结构推荐一个打标前缀。
   * 请求体接受 node 和可选 prompt；身份取服务端 userId。
   * 模型优先取 RuntimeConfig modelConfigs 第二项（小模型），未配置时用第一项。
   */
  app.post('/plugin/suggest-prefix', async (request, reply) => {
    const user = await request.getUser();
    if (!user?.userId) return reply.code(401).send(responseData.error({ message: '登录失效' }));
    const { node, prompt } = z
      .object({ node: z.unknown(), prompt: z.string().optional() })
      .parse(request.body);
    const runtime = parseD2cRuntimeConfig(app.runtimeConfig.get());
    // 打标是 11 选 1 的分类任务，优先用 RuntimeConfig 第二项的小模型；未配置时回落主模型。
    const cfg = runtime.modelConfigs[1] ?? runtime.modelConfigs[0];
    const promptText = prompt?.trim() || buildPrompt(node);
    const startedAt = Date.now();
    const raw = await callModel(cfg, promptText);
    const modelMs = Date.now() - startedAt;
    const result = parseAiJson(raw);
    // 模型和插件提示词都会把前缀写成 btn-，这里统一去掉尾部短横线再校验。
    result.prefix = String(result.prefix || '').replace(/-+$/, '');
    if (!ALLOWED_PREFIX.has(result.prefix)) result.prefix = 'sub';
    app.logging.info(
      {
        message: '插件 AI 打标推荐',
        addInfo: {
          userId: user.userId,
          model: cfg.MODEL_NAME,
          promptChars: promptText.length,
          modelMs,
          prefix: result.prefix,
        },
      },
      request,
    );
    return responseData.success({
      data: { ...result, userId: user.userId, modelMs, promptChars: promptText.length },
    });
  });
}
