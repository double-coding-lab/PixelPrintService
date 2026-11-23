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

/** Every interaction is declarative, bounded and limited to the isolated preview DOM. */
export const previewInspectionOptionsSchema = z
  .object({
    focusSelector: selector.optional(),
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
            })
            .strict()
            .refine((value) => value.deltaX !== 0 || value.deltaY !== 0),
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
export type PreviewInspectionOptions = z.infer<typeof previewInspectionOptionsSchema>;

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
