// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Creates .env from .env.example with the four values every installation
// needs filled in with random values: the encryption key, the bundled
// database's password and the two telemetry tokens. Never overwrites an
// existing .env.
//
// Run it from the project folder, in PowerShell, macOS Terminal or a Linux shell:
//   docker run --rm -v "${PWD}:/app" -w /app node:22-alpine node scripts/setup.cjs
// (Not a compose service: compose refuses to run anything until .env exists.)

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const example = path.join(root, '.env.example');
const target = path.join(root, '.env');

function read(file, key) {
  const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : '';
}

function printPassword(secret) {
  console.log('');
  console.log('Your bearer token (OTEL_ENDPOINT_SECRET), for connecting Claude:');
  console.log('');
  console.log(`  ${secret}`);
  console.log('');
  console.log('You do not need to copy it now. Once Command Centre is running, the Ingestion page');
  console.log('under Admin shows it, with the Claude settings ready to copy.');
}

if (fs.existsSync(target)) {
  console.log('.env already exists, so nothing was changed.');
  const secret = read(target, 'OTEL_ENDPOINT_SECRET');
  if (secret) printPassword(secret);
  process.exit(0);
}

const random = () => crypto.randomBytes(32).toString('hex');
const values = {
  CCC_ENCRYPTION_KEY: random(),
  CCC_PG_PASSWORD: random(),
  OTEL_ENDPOINT_SECRET: random(),
  CCC_COLLECTOR_TOKEN: random(),
};

let text = fs.readFileSync(example, 'utf8');
for (const [key, value] of Object.entries(values)) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (!pattern.test(text)) {
    console.error(`.env.example has no ${key} line, so .env was not created.`);
    process.exit(1);
  }
  text = text.replace(pattern, `${key}=${value}`);
}

fs.writeFileSync(target, text, { mode: 0o600 });

// On Linux the container writes as root: give the file to whoever owns the
// project folder, so it can be edited without sudo.
const owner = fs.statSync(example);
try { fs.chownSync(target, owner.uid, owner.gid); } catch { /* not permitted or not needed */ }

console.log('Created .env with a new encryption key, database password and two telemetry tokens.');
console.log('Keep CCC_ENCRYPTION_KEY the same for the life of this installation:');
console.log('changing it makes every saved secret unreadable.');
printPassword(values.OTEL_ENDPOINT_SECRET);
