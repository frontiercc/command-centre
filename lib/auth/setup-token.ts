// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// One-time setup token for the first-admin page.
// Before this, /admin/setup was open to whoever reached a fresh install first,
// and two simultaneous requests with different emails could BOTH become admin.
//
// At boot, while no admin exists, the hub generates a random token, stores only
// its SHA-256 hash in the config table, and prints the token in the server log.
// POST /api/admin/setup must present it. The route CLAIMS the token by deleting
// the hash row in one statement, so exactly one request can ever win the race.
//
// Several instances booting together: the first to write the hash prints the
// token; the others see a hash written in the last FRESH_S seconds and log that
// a token was already issued. A later restart (hash older than FRESH_S) issues a
// new token, so an operator who lost the log can always get one by restarting.
// The hash row is a raw config key: never in allowedKeys, never returned by
// GET /api/config (getAllConfig reads only typed keys).
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export const SETUP_TOKEN_KEY = 'setup_token_hash';
const FRESH_S = 600;

export function hashSetupToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex');
}

export type IssueResult = { status: 'issued'; token: string } | { status: 'already_issued' } | { status: 'not_needed' };

/** Issue a token when no admin exists. Pure of logging; the caller prints. */
export async function issueSetupTokenIfNeeded(adminCount: () => Promise<number>, nowS = Math.floor(Date.now() / 1000)): Promise<IssueResult> {
  const db = await getTypedClient();
  const t = schema.config;
  if ((await adminCount()) > 0) {
    await db.delete(t).where(eq(t.key, SETUP_TOKEN_KEY)); // leftover from an old install
    return { status: 'not_needed' };
  }
  const token = randomBytes(24).toString('base64url');
  const hash = hashSetupToken(token);
  const rows = await db.insert(t).values({ key: SETUP_TOKEN_KEY, value: hash, updated_at: nowS })
    .onConflictDoUpdate({
      target: t.key,
      set: { value: hash, updated_at: nowS },
      setWhere: sql`${t.updated_at} IS NULL OR ${t.updated_at} < ${nowS - FRESH_S}`,
    })
    .returning({ key: t.key });
  return rows.length ? { status: 'issued', token } : { status: 'already_issued' };
}

/** Consume the token. True for exactly one caller holding the right token. */
export async function claimSetupToken(token: string): Promise<{ claimed: boolean; hash: string }> {
  const hash = hashSetupToken(token);
  const db = await getTypedClient();
  const t = schema.config;
  const rows = await db.delete(t).where(and(eq(t.key, SETUP_TOKEN_KEY), eq(t.value, hash))).returning({ key: t.key });
  return { claimed: rows.length === 1, hash };
}

/** Put a claimed token back when setup then failed for a reason not the caller's. */
export async function restoreSetupToken(hash: string, nowS = Math.floor(Date.now() / 1000)): Promise<void> {
  const db = await getTypedClient();
  const t = schema.config;
  await db.insert(t).values({ key: SETUP_TOKEN_KEY, value: hash, updated_at: nowS }).onConflictDoNothing();
}
