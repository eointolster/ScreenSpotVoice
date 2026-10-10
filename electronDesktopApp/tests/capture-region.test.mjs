import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseActiveWindowId, parseWindowBounds, windowRegion } = require('../dist/capture-region.cjs');

test('active X11 window is cropped and mapped into selected display coordinates', () => {
  assert.equal(parseActiveWindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x2200017'), '0x2200017');
  const bounds = parseWindowBounds('Absolute upper-left X:  -16\nAbsolute upper-left Y:  43\nWidth: 1779\nHeight: 1343');
  assert.deepEqual(windowRegion(bounds, { x: 0, y: 0, width: 3440, height: 1440 }),
    { x: 0, y: 43, width: 1763, height: 1343 });
});
test('missing or wrong-display window does not authorize a whole-screen fallback', () => {
  assert.equal(parseActiveWindowId('window id # 0x0'), null);
  assert.equal(parseWindowBounds('not geometry'), null);
  assert.equal(windowRegion({ x: 4000, y: 0, width: 500, height: 500 },
    { x: 0, y: 0, width: 3440, height: 1440 }), null);
});
