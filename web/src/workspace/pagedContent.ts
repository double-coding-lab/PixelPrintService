/** 展开目标记录所在分组，并只移动指定容器及其内部滚动区，不滚动整个页面。 */
export function revealPagedContent(viewport: HTMLElement, target: HTMLElement) {
  if (!viewport.contains(target)) return;
  for (
    let parent = target.parentElement;
    parent && parent !== viewport;
    parent = parent.parentElement
  ) {
    if (parent.tagName === 'DETAILS' && !(parent as HTMLDetailsElement).open) {
      parent.dataset.pageRevealSeq = target.dataset.entrySeq;
      (parent as HTMLDetailsElement).open = true;
    }
  }
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (parent === viewport || /auto|scroll/.test(getComputedStyle(parent).overflowY)) {
      parent.scrollTop +=
        target.getBoundingClientRect().top - parent.getBoundingClientRect().top - 12;
    }
    if (parent === viewport) break;
  }
}

/** 合并后的工具结果可能沿用开始记录的序号，回退到所在轮次的可见过程。 */
export function findPagedEntry(viewport: HTMLElement, seq: number): HTMLElement | null {
  const direct = viewport.querySelector<HTMLElement>(`[data-entry-seq="${seq}"]`);
  if (direct) return direct;
  const group = [...viewport.querySelectorAll<HTMLElement>('[data-page-first]')].find(
    (element) =>
      Number(element.dataset.pageFirst) <= seq && Number(element.dataset.pageLast) >= seq,
  );
  return group?.querySelector<HTMLElement>('.activity-entries > li') ?? group ?? null;
}
