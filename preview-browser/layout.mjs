/** Validate bounded declarative assertions using the capture protocol's CSS selector rules. */
export function validLayoutChecks(checks, css) {
  if (checks === undefined) return true;
  if (!Array.isArray(checks) || checks.length > 32) return false;
  const number = (value, limit) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= limit;
  return checks.every(
    (check) =>
      check &&
      typeof check === 'object' &&
      !Array.isArray(check) &&
      Object.keys(check).every((key) =>
        ['selector', 'width', 'height', 'container', 'centerX', 'centerY', 'tolerance'].includes(
          key,
        ),
      ) &&
      css(check.selector) &&
      (check.width !== undefined || check.height !== undefined || check.centerX || check.centerY) &&
      (check.width === undefined || (number(check.width, 24000) && check.width > 0)) &&
      (check.height === undefined || (number(check.height, 24000) && check.height > 0)) &&
      (check.tolerance === undefined || number(check.tolerance, 20)) &&
      (check.centerX === undefined || typeof check.centerX === 'boolean') &&
      (check.centerY === undefined || typeof check.centerY === 'boolean') &&
      (check.container === undefined || css(check.container)) &&
      (!(check.centerX || check.centerY) || css(check.container)),
  );
}

/**
 * Runs in the existing opaque renderer immediately before raster capture. No DOM mutations,
 * scrolling, extra browsers or guessed CSS intentions: only explicit border-box assertions.
 */
function auditLayout(checks) {
  const start = performance.now();
  const issues = [];
  let truncated = false;
  const add = (code, selector, expected, actual) => {
    if (issues.length >= 40) {
      truncated = true;
      return;
    }
    issues.push({
      code,
      selector,
      ...(expected === undefined ? {} : { expected, actual: Math.round(actual * 100) / 100 }),
    });
  };
  let invalidInput = false;
  const resolve = (selector) => {
    try {
      const nodes = document.querySelectorAll(selector);
      const first = nodes[0];
      if (!first) {
        add('not_found', selector);
        return;
      }
      if (nodes.length > 1) {
        add('ambiguous_selector', selector);
        return;
      }
      const rect = first.getBoundingClientRect();
      if (
        !first.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
        rect.width <= 0 ||
        rect.height <= 0
      ) {
        add('not_visible', selector);
        return;
      }
      let { left, right, top, bottom } = rect;
      let parent = first.parentElement;
      for (let depth = 0; parent && depth < 128; depth++, parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const bounds = parent.getBoundingClientRect();
        if (/^(hidden|clip|auto|scroll)$/.test(style.overflowX)) {
          left = Math.max(left, bounds.left);
          right = Math.min(right, bounds.right);
        }
        if (/^(hidden|clip|auto|scroll)$/.test(style.overflowY)) {
          top = Math.max(top, bounds.top);
          bottom = Math.min(bottom, bounds.bottom);
        }
      }
      if (parent || right <= left || bottom <= top) {
        add('not_visible', selector);
        return;
      }
      return rect;
    } catch {
      invalidInput = true;
    }
  };
  for (const check of checks) {
    const rect = resolve(check.selector);
    if (!rect) continue;
    const tolerance = check.tolerance ?? 3;
    const compare = (code, expected, actual) => {
      if (Math.abs(expected - actual) > tolerance) add(code, check.selector, expected, actual);
    };
    if (check.width !== undefined) compare('width_mismatch', check.width, rect.width);
    if (check.height !== undefined) compare('height_mismatch', check.height, rect.height);
    if (check.centerX || check.centerY) {
      const container = resolve(check.container);
      if (!container) continue;
      if (check.centerX)
        compare(
          'center_x_mismatch',
          0,
          rect.x + rect.width / 2 - container.x - container.width / 2,
        );
      if (check.centerY)
        compare(
          'center_y_mismatch',
          0,
          rect.y + rect.height / 2 - container.y - container.height / 2,
        );
    }
  }
  return {
    invalidInput,
    durationMs: Math.round((performance.now() - start) * 100) / 100,
    checked: checks.length,
    issues,
    truncated,
  };
}

/** Keep syntax errors inside the fixed invalid-input protocol rather than leaking page exceptions. */
export async function collectLayout(frame, checks) {
  const { invalidInput, ...layout } = await frame.evaluate(auditLayout, checks);
  if (invalidInput) throw new Error('PREVIEW_CAPTURE_INVALID_INPUT');
  return layout;
}
