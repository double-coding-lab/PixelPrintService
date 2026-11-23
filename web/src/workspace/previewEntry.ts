/** 根据目录语义排列入口，保持输入数组原样；区块组件始终排在页面之后。 */
export function comparePreviewEntries(left: string, right: string) {
  function priority(value: string) {
    if (/(?:^|\/)(?:blocks?|components?|__tests__|tests?)(?:\/|$)/i.test(value)) return 100;
    const home = /^(?:src\/)?pages\/(home|index|page|main)\/index\.(?:tsx|jsx)$/i.exec(value);
    if (home) return ['home', 'index', 'page', 'main'].indexOf(home[1].toLowerCase());
    if (/^(?:src\/)?pages\/(?:home|index|main)\.(?:tsx|jsx)$/i.test(value)) return 4;
    if (/^(?:src\/)?(?:App|index|main)\.(?:tsx|jsx)$/i.test(value)) return 10;
    if (/^(?:src\/)?pages\/[^/]+\/index\.(?:tsx|jsx)$/i.test(value)) return 20;
    if (/(?:^|\/)(?:home|index|main)\.(?:tsx|jsx)$/i.test(value)) return 30;
    return 50;
  }
  return (
    priority(left) - priority(right) ||
    left.split('/').length - right.split('/').length ||
    left.localeCompare(right, 'en', { numeric: true })
  );
}
