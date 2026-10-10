import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type KeyProtector = {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

export function canStoreKey(protector: KeyProtector, platform = process.platform): boolean {
  return protector.isEncryptionAvailable() &&
    (platform !== 'linux' || protector.getSelectedStorageBackend() !== 'basic_text');
}

export function loadStoredKey(protector: KeyProtector, file: string): string {
  if (!existsSync(file)) return '';
  if (!canStoreKey(protector)) throw new Error('Your desktop key store is unavailable.');
  return protector.decryptString(readFileSync(file));
}

export function storeKey(protector: KeyProtector, file: string, key: string): void {
  if (!canStoreKey(protector)) throw new Error('A secure desktop key store is unavailable. The key was kept only for this session.');
  if (!key.trim()) throw new Error('Enter a Gemini key before choosing Remember key.');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const encrypted = protector.encryptString(key.trim());
  const temporary = file + '.tmp';
  writeFileSync(temporary, encrypted, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

export function forgetStoredKey(file: string): void {
  if (existsSync(file)) unlinkSync(file);
}
