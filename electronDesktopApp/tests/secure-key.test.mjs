import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { canStoreKey, loadStoredKey, storeKey, forgetStoredKey } = require('../dist/secure-key.cjs');

test('remembered key is encrypted and can be forgotten', () => {
  const directory = mkdtempSync(join(tmpdir(), 'screenspot-key-test-'));
  const file = join(directory, 'gemini-key.bin');
  const protector = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: value => Buffer.from('cipher:' + value.split('').reverse().join('')),
    decryptString: value => value.toString().slice(7).split('').reverse().join(''),
  };
  try {
    storeKey(protector, file, 'TEST_KEY_ONLY');
    assert.equal(readFileSync(file, 'utf8').includes('TEST_KEY_ONLY'), false);
    assert.equal(loadStoredKey(protector, file), 'TEST_KEY_ONLY');
    forgetStoredKey(file);
    assert.equal(loadStoredKey(protector, file), '');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('Linux basic_text fallback is refused', () => {
  const protector = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'basic_text',
    encryptString: value => Buffer.from(value),
    decryptString: value => value.toString(),
  };
  assert.equal(canStoreKey(protector, 'linux'), false);
  assert.throws(() => storeKey(protector, '/tmp/screenspot-should-not-exist', 'TEST_KEY_ONLY'), /secure desktop key store/);
});
