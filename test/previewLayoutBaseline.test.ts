import assert from 'node:assert/strict';
import test from 'node:test';
import {
  layoutChecksFromCache,
  cachedLayoutChecks,
} from '../src/functions/d2c/preview/layoutBaseline';
import { previewInspectionOptionsSchema } from '../src/functions/d2c/preview/interaction';

/** Cached design geometry is independent of whichever CSS layout strategy the model chooses. */
test('cached fixed axes and centered text become CSS-pixel checks, FILL/HUG and baked children stay flexible', () => {
  const root = {
    id: '0:1',
    type: 'FRAME',
    absoluteBoundingBox: { x: 0, y: 0, width: 750, height: 1000 },
    children: [
      {
        id: '1:1',
        type: 'FRAME',
        layoutSizingHorizontal: 'FIXED',
        absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
        children: [
          {
            id: '1:2',
            type: 'TEXT',
            textAlignHorizontal: 'CENTER',
            textAlignVertical: 'CENTER',
            absoluteBoundingBox: { x: 60, y: 30, width: 80, height: 40 },
          },
        ],
      },
      {
        id: '1:3',
        type: 'FRAME',
        layoutSizingHorizontal: 'FILL',
        layoutSizingVertical: 'HUG',
        absoluteBoundingBox: { x: 0, y: 100, width: 750, height: 20 },
      },
      {
        id: '1:4',
        name: 'bg-card',
        children: [
          {
            id: '1:5',
            type: 'FRAME',
            layoutSizingHorizontal: 'FIXED',
            absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
          },
        ],
      },
    ],
  };
  assert.deepEqual(layoutChecksFromCache({ nodes: { '0:1': { document: root } } }, '0:1'), [
    { selector: '[data-node-id="1:1"]', tolerance: 3, width: 100 },
    {
      selector: '[data-node-id="1:2"]',
      tolerance: 3,
      centerX: true,
      centerY: true,
      container: '[data-node-id="1:1"]',
    },
  ]);
  assert.deepEqual(layoutChecksFromCache(root, '9:9'), []);
});

test('layout protocol rejects executable, empty, excessive and incomplete centering plans', async () => {
  for (const check of [
    { selector: '#a' },
    { selector: '#a', width: 0 },
    { selector: '#a', centerX: true },
    { selector: 'xpath=//div', width: 10 },
    { selector: '#a', width: 10, tolerance: 21 },
  ]) {
    assert.equal(
      previewInspectionOptionsSchema.safeParse({ layoutChecks: [check] }).success,
      false,
    );
  }
  assert.equal(
    previewInspectionOptionsSchema.safeParse({
      layoutChecks: Array.from({ length: 33 }, () => ({ selector: '#a', width: 10 })),
    }).success,
    false,
  );
  assert.deepEqual(
    await cachedLayoutChecks(
      '/unused',
      'https://figma.com/design/key/test?node-id=../../etc/passwd',
    ),
    [],
  );
});

test('coincident boxes without explicit alignment and FILL text do not invent centering failures', () => {
  for (const text of [
    { textAlignHorizontal: 'LEFT' },
    { textAlignHorizontal: 'CENTER', layoutSizingHorizontal: 'FILL' },
  ]) {
    assert.deepEqual(
      layoutChecksFromCache(
        {
          id: '0:1',
          type: 'FRAME',
          absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 50 },
          children: [
            {
              id: '1:1',
              type: 'TEXT',
              ...text,
              absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 50 },
            },
          ],
        },
        '0:1',
      ),
      [],
    );
  }
});
