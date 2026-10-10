import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { reconcileAnswer } = require('../dist/response.cjs');

test('a displayed box overrides a contradictory cannot-find answer', () => {
  assert.equal(
    reconcileAnswer('Find Lucas.jpg on the screen, please.', "I can't find a file named Lucas.jpg on the screen.", 'Lucas.jpg'),
    'I highlighted Lucas.jpg on your screen.',
  );
});

test('speech does not claim a box when no highlight appeared', () => {
  assert.equal(
    reconcileAnswer('Highlight Lucas.jpg.', 'I highlighted Lucas.jpg.', null),
    'I could not place a box on this screen. Try asking about a larger visible target.',
  );
});

test('useful model explanation remains when it agrees with the shown box', () => {
  assert.equal(
    reconcileAnswer('Where is Transactions?', 'Transactions is in the left navigation.', 'Transactions'),
    'Transactions is in the left navigation.',
  );
});
