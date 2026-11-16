/** 仅从已脱敏的工具调用提取动作摘要，不公开源码正文、凭据或完整参数。 */
export function describeToolActivity(item: Record<string, unknown>): string | undefined {
  if (item.type !== 'function_call' || typeof item.arguments !== 'string') return;
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(item.arguments);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    args = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  /** 控制摘要长度和控制字符，展示值始终作为文本渲染。 */
  function value(key: string) {
    return typeof args[key] === 'string'
      ? args[key].replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200)
      : '';
  }
  switch (item.name) {
    case 'read_file': {
      const offset = args.offset ?? 0;
      const length = args.length;
      const automatic = length === null || length === undefined;
      const range =
        Number.isSafeInteger(offset) &&
        Number(offset) >= 0 &&
        (automatic ||
          (Number.isSafeInteger(length) &&
            Number(length) > 0 &&
            Number.isSafeInteger(Number(offset) + Number(length)))) &&
        ('offset' in args || 'length' in args)
          ? ` · 字符偏移 ${offset}，${automatic ? '自动页长' : `请求 ${length} 字符`}`
          : '';
      return `读取${args.resource === true ? '固定资源' : '会话文件'}：${value('path')}${range}`;
    }
    case 'report_progress':
      return `保存子任务进度：${value('phase')}`;
    case 'write_file':
      return `写入文件：${value('path')}`;
    case 'delete_file':
      return `删除文件：${value('path')}`;
    case 'list_files':
      return args.resource === true
        ? `列出固定资源：${value('path') || '/resources/'}`
        : '列出当前会话文件';
    case 'prepare_slices':
      return `准备切图：${value('slug')}`;
    case 'build_preview':
      return `编译当前页面：${value('entryPath') || '默认入口'}`;
    case 'inspect_preview':
      return `运行截图并检查：${value('entryPath') || '当前页面'}`;
    case 'check_rules':
      return `检查规则：${value('path')} · ${value('mode')}`;
    case 'figma':
      return `Figma：${value('command')}${value('nodeId') ? ` · 节点 ${value('nodeId')}` : ''}${args.subtree === true ? ` · 子树分页 ${Number.isSafeInteger(args.offset) ? args.offset : 0}` : ''}`;
    case 'wait_subagents':
      return args.wait === false ? '查看子任务状态' : '等待并收集子任务结果';
    case 'delegate_agent':
      return `委派子 Agent：${value('role')}`;
  }
}
