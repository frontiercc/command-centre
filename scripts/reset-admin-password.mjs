#!/usr/bin/env node
// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Emergency admin password reset.
 *
 * Run inside the hub container (it reads the container's DATABASE_URL and
 * CCC_PG_SSL, the same connection settings the app uses):
 *
 *   docker compose exec hub node scripts/reset-admin-password.mjs
 *
 * Or from any machine that can reach the database, with those two variables
 * set in the environment.
 *
 * The script lists admin accounts, prompts for which to reset and the new
 * password, writes the new scrypt hash, clears any login lockout, and
 * invalidates all active sessions for that user.
 */

import crypto from 'crypto';
import readline from 'readline';
import pg from 'pg';
import { pgSslOption } from './pg-ssl.mjs';

// ─── Connect (same settings as lib/db/client.ts pgConnectionConfig) ──────────

if (!process.env.DATABASE_URL) {
  console.error('\nDATABASE_URL is not set. Run this inside the hub container:');
  console.error('  docker compose exec hub node scripts/reset-admin-password.mjs\n');
  process.exit(1);
}

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslOption(process.env.CCC_PG_SSL, process.env.DATABASE_URL),
});

// ─── Scrypt (must match lib/auth/admin-auth.ts) ──────────────────────────────

const SCRYPT_KEYLEN = 64;
const SALT_LEN = 16;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 2, maxmem: 128 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LEN).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS).toString('hex');
  return `${salt}:${hash}`;
}

// ─── Prompt helper ────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Piped answers can all arrive before the first question is asked, and the
// input then closes, so rl.question would have nothing to read for the later
// questions. Queue each line as it arrives and hand the next one to each
// question; a missing answer reads as blank and fails validation.
const queued = [];
const waiting = [];
let inputClosed = false;
if (!process.stdin.isTTY) {
  rl.on('line', line => (waiting.length ? waiting.shift()(line) : queued.push(line)));
  rl.on('close', () => {
    inputClosed = true;
    while (waiting.length) waiting.shift()('');
  });
}

function ask(question) {
  if (process.stdin.isTTY) return new Promise(resolve => rl.question(question, resolve));
  process.stdout.write(question);
  return new Promise(resolve => {
    if (queued.length) resolve(queued.shift());
    else if (inputClosed) resolve('');
    else waiting.push(resolve);
  });
}

function askHidden(question) {
  return new Promise(resolve => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let password = '';
    stdin.on('data', function handler(ch) {
      ch = ch.toString();
      if (ch === '\n' || ch === '\r' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', handler);
        process.stdout.write('\n');
        resolve(password);
      } else if (ch === '\u0003') {
        process.stdout.write('\n');
        process.exit(0);
      } else if (ch === '\u007f') {
        password = password.slice(0, -1);
      } else {
        password += ch;
      }
    });
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━ Frontier Command Centre: emergency admin password reset ━━━\n');

  try {
    await db.connect();
  } catch (err) {
    console.error('\nCould not connect to the database:', err.message, '\n');
    process.exit(1);
  }

  // Real login accounts only: telemetry auto-enrols every Claude user with a
  // '__otel_pending__' placeholder hash, and those cannot sign in with a password.
  const { rows: admins } = await db.query(
    `SELECT id, email, display_name, role FROM admin_users
      WHERE password_hash <> '__otel_pending__' ORDER BY created_at`,
  );

  if (admins.length === 0) {
    console.error('No admin users found. Run the setup wizard first.\n');
    process.exit(1);
  }

  console.log('Admin accounts:\n');
  admins.forEach((u, i) => {
    const name = u.display_name ? ` (${u.display_name})` : '';
    console.log(`  ${i + 1}. ${u.email}${name}  [${u.role}]`);
  });

  console.log();
  const choice = await ask('Enter the number of the account to reset: ');
  const idx = parseInt(choice, 10) - 1;

  if (isNaN(idx) || idx < 0 || idx >= admins.length) {
    console.error('\nInvalid selection.\n');
    process.exit(1);
  }

  const user = admins[idx];
  console.log(`\nResetting password for: ${user.email}\n`);

  let password;
  // Fall back to visible prompt if stdin is not a TTY (e.g. piped input)
  if (process.stdin.isTTY) {
    password = await askHidden('New password (min 12 chars, hidden): ');
  } else {
    password = await ask('New password (min 12 chars): ');
    password = password.trim();
  }

  if (!password || password.length < 12 /* MIN_PASSWORD_LENGTH in lib/auth/password-policy.ts */) {
    console.error('\nPassword must be at least 12 characters.\n');
    process.exit(1);
  }

  const confirm = process.stdin.isTTY
    ? await askHidden('Confirm new password: ')
    : (await ask('Confirm new password: ')).trim();

  if (password !== confirm) {
    console.error('\nPasswords do not match.\n');
    process.exit(1);
  }

  const hash = hashPassword(password);

  await db.query(
    `UPDATE admin_users
        SET password_hash = $1, failed_login_count = 0, locked_until = NULL,
            updated_at = extract(epoch from now())::bigint
      WHERE id = $2`,
    [hash, user.id],
  );

  const { rowCount } = await db.query('DELETE FROM admin_sessions WHERE user_id = $1', [user.id]);

  console.log(`\n✓ Password updated for ${user.email}`);
  console.log('✓ Login lockout cleared');
  console.log(`✓ ${rowCount ?? 0} active session(s) invalidated`);
  console.log('\nYou can now sign in with the new password.\n');

  rl.close();
  await db.end();
}

main().catch(err => {
  console.error('\nUnexpected error:', err.message, '\n');
  process.exit(1);
});
