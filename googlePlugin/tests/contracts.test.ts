import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapBox, validBox } from '../src/contracts';

test('rejects malformed normalized boxes', () => {
  for (const box of [[0, 0, 0, 2], [0, 0, 1001, 2], [4, NaN, 8, 10], [900, 5, 100, 50], [0, 0, 1, 1], [0, 0, 2]]) {
    assert.equal(validBox(box), false);
  }
  assert.equal(validBox([100, 200, 300, 600]), true);
});

test('maps pixel coordinates to CSS viewport at different resolutions', () => {
  const box: [number, number, number, number] = [100, 200, 300, 600];
  const a = mapBox(box, { width: 1280, height: 720 }, { width: 1280, height: 720 });
  const b = mapBox(box, { width: 1920, height: 1080 }, { width: 960, height: 540 });
  assert.equal(a.x, 244);
  assert.equal(a.y, 63.36);
  assert.equal(b.x, 180.48);
  assert.ok(Math.abs(b.y - 47.52) < 1e-6);
  assert.throws(() => mapBox(box, { width: 1280, height: 720 }, { width: 800, height: 900 }));
});
