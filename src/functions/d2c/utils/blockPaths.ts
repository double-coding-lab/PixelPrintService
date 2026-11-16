/** 返回不符合命名约定的区块目录；图片名称、Figma标签和源码文件名不在此限制范围。 */
export function invalidBlockDirectory(relative: string): string | undefined {
  const parts = relative.split('/');
  for (let index = 0; index < parts.length - 2; index++) {
    if (
      parts[index] === 'blocks' &&
      (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parts[index + 1]) || parts[index + 1].startsWith('sub-'))
    )
      return parts.slice(0, index + 2).join('/');
  }
  return undefined;
}
