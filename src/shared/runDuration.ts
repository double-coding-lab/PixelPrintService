const endedStatuses = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'paused']);

type DurationEvent = { status: string; at: number | null };

/** 按持久化生命周期累计区间；等待回答冻结，明确重新排队后续计，缺失端点保持未知。 */
export function measureRunDuration(
  initialStart: number | null,
  status: string,
  events: DurationEvent[],
  observedAt: number | null,
) {
  let start = initialStart;
  let elapsedMs = 0;
  let finishedAt: number | null = null;
  let waitingAt: number | null = null;
  let seenStart = start !== null;
  let valid = true;
  for (const event of events) {
    const state = event.status;
    if (state !== 'queued' && state !== 'waiting_input' && !endedStatuses.has(state)) continue;
    const at = event.at;
    if (at === null || !Number.isFinite(at)) {
      valid = false;
      continue;
    }
    if (state === 'queued') {
      if (start === null) {
        const previous = finishedAt ?? waitingAt;
        if (previous !== null && at < previous) valid = false;
        start = at;
        seenStart = true;
        finishedAt = null;
        waitingAt = null;
      }
    } else if (start !== null) {
      if (at < start) valid = false;
      else elapsedMs += at - start;
      start = null;
      if (state === 'waiting_input') waitingAt = at;
      else finishedAt = at;
    } else if (waitingAt !== null && state !== 'waiting_input') {
      // 等待期间可主动结束或失败；成功必须有重新入队的执行区间。
      if (at < waitingAt || state === 'succeeded') valid = false;
      finishedAt = at;
      waitingAt = null;
    }
  }
  if (start !== null) {
    if (
      endedStatuses.has(status) ||
      status === 'waiting_input' ||
      observedAt === null ||
      observedAt < start
    )
      valid = false;
    else elapsedMs += observedAt - start;
  } else if (!endedStatuses.has(status) && status !== 'waiting_input') valid = false;
  if (status === 'waiting_input' && waitingAt === null) valid = false;
  return {
    elapsedMs: valid && seenStart ? elapsedMs : null,
    runningCount: valid && seenStart && start !== null ? 1 : 0,
    finishedAt: valid && seenStart ? finishedAt : null,
    waitingAt: valid && seenStart ? waitingAt : null,
  };
}
