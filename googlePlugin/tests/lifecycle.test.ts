import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleAction } from '../src/lifecycle';

test('switching away pauses without authorizing the newly active tab', () => {
  assert.equal(lifecycleAction(7, { kind: 'activated', tabId: 8 }), 'pause');
  assert.equal(lifecycleAction(7, { kind: 'activated', tabId: 7 }), 'none');
  assert.equal(lifecycleAction(7, { kind: 'zoom', tabId: 7 }), 'pause');
});

test('top-level navigation and removal end only the shared source', () => {
  assert.equal(lifecycleAction(7, { kind: 'updated', tabId: 7, loading: true, urlChanged: false }), 'end');
  assert.equal(lifecycleAction(7, { kind: 'updated', tabId: 7, loading: false, urlChanged: true }), 'end');
  assert.equal(lifecycleAction(7, { kind: 'removed', tabId: 7 }), 'end');
  assert.equal(lifecycleAction(7, { kind: 'updated', tabId: 8, loading: true, urlChanged: true }), 'none');
});
