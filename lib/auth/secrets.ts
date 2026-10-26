// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { existsSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT = 'ccc-config-encryption-v1'; // fixed salt — key uniqueness comes from the passphrase
const ENV_KEY_NAME = 'CCC_ENCRYPTION_KEY';

/** Cache so we only derive once per process */
let cachedKey: Buffer | null = null;

/**
 * Derive a 256-bit key from the encryption passphrase.
 * Priority: env var > .env.local file > auto-generate and persist to .env.local
 */
function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  let passphrase = process.env[ENV_KEY_NAME];

  if (!passphrase) {
    // Try to read from .env.local (Next.js loads this, but not on first call)
    const envLocalPath = join(process.cwd(), '.env.local');
    passphrase = readKeyFromEnvFile(envLocalPath);

    if (!passphrase) {
      // Auto-generate and persist
      passphrase = randomBytes(32).toString('hex');
      persistKeyToEnvFile(envLocalPath, passphrase);
      console.log(`[Secrets] Auto-generated ${ENV_KEY_NAME} and saved to .env.local. Back this up!`);
    }

    // Set in process so subsequent reads (and Next.js config) can see it
    process.env[ENV_KEY_NAME] = passphrase;
  }

  cachedKey = scryptSync(passphrase, SALT, 32);
  return cachedKey;
}

/**
 * Read CCC_ENCRYPTION_KEY from a dotenv file without pulling in a dotenv parser.
 */
function readKeyFromEnvFile(filePath: string): string | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${ENV_KEY_NAME}=`)) {
        // Strip optional quotes
        return trimmed.slice(ENV_KEY_NAME.length + 1).replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* file unreadable — fall through */ }
  return undefined;
}

/**
 * Append CCC_ENCRYPTION_KEY to .env.local (creates file if missing).
 */
function persistKeyToEnvFile(filePath: string, key: string): void {
  try {
    const line = `\n# Auto-generated encryption key for config secrets (back this up!)\n${ENV_KEY_NAME}=${key}\n`;
    appendFileSync(filePath, line, 'utf-8');
  } catch (err) {
    console.warn(`[Secrets] Could not write ${ENV_KEY_NAME} to .env.local:`, err);
  }
}

/** Encrypted format: base64(iv + ciphertext + authTag) prefixed with `enc:` */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return plaintext;
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, encrypted, tag]);
  return `enc:${combined.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  if (!stored || !stored.startsWith('enc:')) return stored; // plaintext passthrough
  // Legacy encrypted values — try to decrypt, return empty on failure
  // so the dashboard doesn't crash. User can re-enter the value.
  try {
    const key = getEncryptionKey();
    const combined = Buffer.from(stored.slice(4), 'base64');
    const iv = combined.subarray(0, IV_LENGTH);
    const tag = combined.subarray(combined.length - TAG_LENGTH);
    const ciphertext = combined.subarray(IV_LENGTH, combined.length - TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  } catch {
    console.warn('[Secrets] Failed to decrypt legacy enc: value, returning empty. Re-enter the value in Admin.');
    return '';
  }
}

export function isEncrypted(value: string): boolean {
  return value.startsWith('enc:');
}
