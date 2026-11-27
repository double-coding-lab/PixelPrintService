import { z } from 'zod';

/** CSS only: no Playwright engines, frame traversal, XPath or executable expressions. */
const selector = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !/[\x00-\x1f\x7f]/.test(value) &&
      !/>>|(?:^|\s)(?:xpath|text|id|css)=|:has-text\(|:text\(/i.test(value),
    'Use a bounded CSS selector',
  );
const coordinate = z.number().finite().min(-24000).max(24000);
const text = z.string().max(256);
const numericExpectation = { min: coordinate.optional(), max: coordinate.optional() };
const boundedExpectation = (value: { min?: number; max?: number }) =>
  (value.min !== undefined || value.max !== undefined) &&
  !(value.min !== undefined && value.max !== undefined && value.min > value.max);
const expectations = [
  z.object({ type: z.literal('expect'), selector, state: z.literal('visible') }).strict(),
  z.object({ type: z.literal('expect'), selector, state: z.literal('text'), text }).strict(),
  z
    .object({
      type: z.literal('expect'),
      selector,
      state: z.literal('attribute'),
      attribute: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
      value: text,
    })
    .strict(),
  z
    .object({
      type: z.literal('expect'),
      selector,
      state: z.literal('scrollLeft'),
      ...numericExpectation,
    })
    .strict()
    .refine(boundedExpectation),
  z
    .object({
      type: z.literal('expect'),
      selector,
      state: z.literal('centered'),
      container: selector,
      tolerance: z.number().finite().min(0).max(100).default(5),
    })
    .strict(),
] as const;

/** Bounded geometry assertions use CSS pixels in the existing screenshot viewport. */
export const previewLayoutCheckSchema = z
  .object({
    selector,
    width: z.number().finite().positive().max(24000).optional(),
    height: z.number().finite().positive().max(24000).optional(),
    container: selector.optional(),
    centerX: z.boolean().optional(),
    centerY: z.boolean().optional(),
    overflow: z.boolean().optional(),
    tolerance: z.number().finite().min(0).max(20).default(3),
  })
  .strict()
  .refine(
    (value) =>
      (value.width !== undefined ||
        value.height !== undefined ||
        value.centerX ||
        value.centerY ||
        value.overflow) &&
      (!(value.centerX || value.centerY) || value.container !== undefined),
  );
export type PreviewLayoutCheck = z.infer<typeof previewLayoutCheckSchema>;

/** Browser diagnostics expose bounded geometry only, never page text or stylesheets. */
export const previewLayoutResultSchema = z
  .object({
    durationMs: z.number().finite().nonnegative().max(75000),
    checked: z.number().int().min(0).max(300),
    truncated: z.boolean(),
    issues: z
      .array(
        z
          .object({
            code: z.enum([
              'width_mismatch',
              'height_mismatch',
              'center_x_mismatch',
              'center_y_mismatch',
              'not_found',
              'ambiguous_selector',
              'not_visible',
              'overflow',
            ]),
            selector,
            expected: z.number().finite().optional(),
            actual: z.number().finite().optional(),
          })
          .strict(),
      )
      .max(40),
  })
  .strict();
export type PreviewLayoutResult = z.infer<typeof previewLayoutResultSchema>;

/** Every interaction is declarative, bounded and limited to the isolated preview DOM. */
export const previewInspectionOptionsSchema = z
  .object({
    focusSelector: selector.optional(),
    layoutChecks: z.array(previewLayoutCheckSchema).max(32).optional(),
    actions: z
      .array(
        z.union([
          z.object({ type: z.literal('click'), selector }).strict(),
          z
            .object({
              type: z.literal('swipe'),
              selector,
              deltaX: z.number().finite().min(-1000).max(1000),
              deltaY: z.number().finite().min(-1000).max(1000),
              pointer: z.enum(['touch', 'mouse']).default('touch'),
              during: z
                .array(
                  z
                    .object({
                      atStep: z.number().int().min(1).max(11),
                      expect: z.union([expectations[1], expectations[2]]),
                    })
                    .strict(),
                )
                .min(1)
                .max(3)
                .optional(),
            })
            .strict()
            .refine((value) => value.deltaX !== 0 || value.deltaY !== 0)
            .refine(
              (value) =>
                value.during?.every(
                  (sample, index, previous) =>
                    index === 0 || sample.atStep > previous[index - 1].atStep,
                ) ?? true,
            ),
          z
            .object({
              type: z.literal('scroll'),
              selector: selector.optional(),
              x: coordinate,
              y: coordinate,
            })
            .strict(),
          ...expectations,
        ]),
      )
      .max(12)
      .optional(),
  })
  .strict();
export type PreviewInspectionOptions = z.input<typeof previewInspectionOptionsSchema>;

/** Trusted protocol strips page exception text and only exposes fixed failure reasons. */
export const previewInteractionResultSchema = z
  .object({
    passed: z.boolean(),
    focus: z
      .object({
        passed: z.boolean(),
        reason: z.enum([
          'completed',
          'not_found',
          'ambiguous_selector',
          'invalid_selector',
          'not_visible',
          'action_failed',
          'timeout',
          'interaction_budget_exceeded',
        ]),
      })
      .strict()
      .optional(),
    steps: z
      .array(
        z
          .object({
            step: z.number().int().min(1).max(12),
            type: z.enum(['click', 'swipe', 'scroll', 'expect']),
            passed: z.boolean(),
            reason: z.enum([
              'completed',
              'matched',
              'not_found',
              'ambiguous_selector',
              'invalid_selector',
              'not_visible',
              'assertion_failed',
              'action_failed',
              'timeout',
              'gesture_out_of_bounds',
              'interaction_budget_exceeded',
            ]),
            during: z
              .array(
                z
                  .object({
                    atStep: z.number().int().min(1).max(11),
                    observed: z.union([z.boolean(), z.string().max(256)]),
                  })
                  .strict(),
              )
              .max(3)
              .optional(),
            observed: z
              .union([z.boolean(), z.number().finite().min(-1e9).max(1e9), z.string().max(256)])
              .optional(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict()
  .refine(
    (value) =>
      value.passed === (value.steps.every((step) => step.passed) && value.focus?.passed !== false),
  );
export type PreviewInteractionResult = z.infer<typeof previewInteractionResultSchema>;

/** Document coordinates describe precisely which portion of a page was rasterized. */
export const previewCoverageSchema = z
  .object({
    mode: z.enum(['page', 'focused']),
    reason: z.enum(['height_limit', 'byte_limit', 'nested_scroll']).optional(),
    documentHeight: z.number().finite().min(0).max(1e9),
    x: z.number().finite().min(0).max(1e9),
    y: z.number().finite().min(0).max(1e9),
    width: z.number().int().min(1).max(1440),
    height: z.number().int().min(1).max(12000),
    viewportHeight: z.literal(900),
    nestedScroll: z.boolean(),
  })
  .strict();
export type PreviewCoverage = z.infer<typeof previewCoverageSchema>;
