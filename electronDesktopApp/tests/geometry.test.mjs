import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validBox, mapBox } = require('../dist/geometry.cjs');

test('validated normalized box maps onto the selected display', () => {
  const box = [200, 100, 500, 400];
  assert.equal(validBox(box), true);
  const result = mapBox(box, { width: 1280, height: 800 }, { width: 1280, height: 800 });
  assert.ok(result.x < 128 && result.x > 100);
  assert.ok(result.y < 160 && result.y > 130);
  assert.ok(result.width > 380 && result.width < 420);
});

test('rejects unsafe coordinates and mismatched capture geometry', () => {
  for (const box of [[0, 0, 1000, 1000], [200, 400, 100, 500], [0, NaN, 100, 200], [0, 0, 100]]) {
    assert.equal(validBox(box), false);
  }
  assert.throws(() => mapBox([100, 100, 300, 300], { width: 3440, height: 1440 }, { width: 1454, height: 1028 }), /shapes differ/);
});

test('small icon highlight opens a small window at the correct wide-screen location', () => {
  const { placeOverlay } = require('../dist/geometry.cjs');
  const display = { x: 0, y: 0, width: 3440, height: 1440 };
  const rect = mapBox([40, 800, 100, 850], { width: 3440, height: 1440 }, display);
  const placement = placeOverlay(rect, display);
  assert.ok(placement.bounds.width < 300);
  assert.ok(placement.bounds.height < 180);
  assert.ok(placement.bounds.x > 2600);
  assert.ok(placement.bounds.y < 150);
  assert.ok(placement.outline.x >= 0 && placement.outline.y >= 0);
});

test('label and outline stay on screen for a target at the lower edge', () => {
  const { placeOverlay } = require('../dist/geometry.cjs');
  const display = { x: -1280, y: 0, width: 1280, height: 800 };
  const placement = placeOverlay({ x: 5, y: 740, width: 100, height: 55 }, display);
  assert.ok(placement.bounds.x >= display.x);
  assert.ok(placement.bounds.y + placement.bounds.height <= display.height);
  assert.ok(placement.label.y >= 0);
  assert.ok(placement.outline.y + placement.outline.height <= placement.bounds.height);
});

test('cropped-window box lands in the app window and can be nudged left or up', () => {
  const { shiftRect } = require('../dist/geometry.cjs');
  const region = { x: 800, y: 150, width: 1200, height: 900 };
  const local = mapBox([200, 300, 260, 400], { width: 1200, height: 900 }, region);
  const rect = shiftRect({ ...local, x: region.x + local.x, y: region.y + local.y },
    { width: 3440, height: 1440 }, { x: -10, y: -5 });
  assert.ok(rect.x > 1100 && rect.x < 1200);
  assert.ok(rect.y > 300 && rect.y < 350);
  assert.equal(shiftRect(rect, { width: 3440, height: 1440 }, { x: -10, y: -5 }).x, rect.x - 10);
});
