/** 默认会话名由目标决定，与创建入口保持一致。 */
export function defaultSessionName(target: 'h5' | 'rn') {
  return `${target === 'rn' ? 'RN' : 'H5'} 会话`;
}

/** 只为默认名称选取真实节点标题；控制字符清理后遵循会话的200字符限制。 */
export function figmaSessionName(
  current: string | null | undefined,
  target: 'h5' | 'rn',
  nodeName: string,
) {
  if (current?.trim() && current.trim() !== defaultSessionName(target)) return;
  const name = nodeName
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .trim()
    .slice(0, 200)
    .trim();
  if (!name || name === current || name === defaultSessionName(target)) return;
  return name;
}
