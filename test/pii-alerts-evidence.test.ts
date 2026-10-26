// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// createPiiAlertsWithDedup used to store
// `{pii_type, evidence: <200-char prefix of source text>}` — no message_id,
// no surface, no masked matched value, so an alert like "Email address
// detected" gave no way to tell whether the match was really in the message
// (the prefix could easily contain no '@' at all if the email appeared past
// char 200). This locks in the enriched shape: {surface, message_id,
// pii_type, masked_value, evidence}.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { jsonText, type TestSql } from './helpers/sql';
import { detectPiiWithMatches } from '@/lib/pii/detect';

let sql: TestSql;
let cleanup: () => Promise<void>;
let createPiiAlertsWithDedup: typeof import('@/lib/alerts/pii-alerts').createPiiAlertsWithDedup;


beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  ({ createPiiAlertsWithDedup } = await import('@/lib/alerts/pii-alerts'));
});

afterAll(async () => cleanup());

describe('createPiiAlertsWithDedup — enriched evidence', () => {
  beforeEach(async () => {
    const now = Math.floor(Date.now() / 1000);
    await sql.run("DELETE FROM alerts WHERE user_id = 'evidence_test_user'");
    await sql.run("DELETE FROM users WHERE id = 'evidence_test_user'");
    await sql.run(`
      INSERT INTO users (id, email, display_name, first_seen_at, last_seen_at)
      VALUES ('evidence_test_user', 'pii-evidence-test@example.com', 'Test User', ?, ?)
    `, [now, now]);
  });

  it('stores surface, message_id, and the masked matched value in raw_evidence', async () => {
    const sourceText = 'a'.repeat(250) + ' contact john@example.com for details';
    const matches = detectPiiWithMatches(sourceText);

    await createPiiAlertsWithDedup('evidence_test_user', matches, sourceText, 'msg-abc-123', 'code');

    const row = (await sql.get<{ raw_evidence: unknown }>(
      "SELECT raw_evidence FROM alerts WHERE user_id = 'evidence_test_user'",
    ))!;
    const evidence = JSON.parse(jsonText(row.raw_evidence));

    expect(evidence.surface).toBe('code');
    expect(evidence.message_id).toBe('msg-abc-123');
    expect(evidence.pii_type).toBe('email');
    expect(evidence.masked_value).toBe('j***@example.com');
    // Short prefix retained for surrounding context, still capped at 200 chars.
    expect(evidence.evidence.length).toBeLessThanOrEqual(200);
  });

  it('still dedups the same pii_type for the same user within 24h', async () => {
    const sourceText = 'contact jane@example.com for details';
    const matches = detectPiiWithMatches(sourceText);

    await createPiiAlertsWithDedup('evidence_test_user', matches, sourceText, 'msg-1', 'cowork');
    await createPiiAlertsWithDedup('evidence_test_user', matches, sourceText, 'msg-2', 'cowork');

    const count = ((await sql.get<{ c: number }>(
      "SELECT COUNT(*) as c FROM alerts WHERE user_id = 'evidence_test_user'",
    ))!).c;
    expect(count).toBe(1);
  });
});
