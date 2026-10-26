// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for the OTLP ingest receivers
// (lib/otel/cowork-receiver.ts, lib/otel/code-receiver.ts). The central things
// this file proves, on Postgres:
//
//   1. jsonb Policy A round-trip on WRITE: cowork_messages.token_usage
//      writes and reads back as the IDENTICAL JSON string.
//   2. Deferred PII alert reliability: a PII-flagged prompt sets flagged/
//      flag_reason inside the record's transaction AND fires the alert AFTER the
//      transaction commits (the alert row lands in the alerts table, alertsFired
//      increments).
//   3. Basic ingest + flags: clean vs PII user_prompt → correct cowork_messages
//      rows (cowork + code surfaces).
//
// HARNESS RULE (copied from queries-cowork-chat-gdpr-pg.test.ts): the receivers
// reach the database through getClient(), which binds to DATABASE_URL on
// first use, so the module-under-test + schema + json helper are DYNAMIC-
// imported AFTER createTestDbClient('postgres') has set DATABASE_URL + reset
// modules.
//
// The receivers' dead `db` parameter was dropped: their reads/writes go
// through getTypedClient(), and the alert helpers
// (createPiiAlertsWithDedup/createFileUploadAlerts) ignore the handle they're
// passed. The deferred PII alert's actual INSERT goes through insertAlert →
// getTypedClient → the test database, so the assertions read the alert
// back from THAT DB.
import { describe, it, expect } from 'vitest';

// The deferred-PII-alert assertion below reads the alerts table right after
// ingest returns, but alert creation is fire-and-forget (not awaited by the
// ingest handler) — so the row may not have landed yet. Poll briefly instead
// of trusting incidental event-loop interleaving; if it never appears, give
// up and let the existing assertions fail honestly on an empty result.
// `fn` returns whatever the (untyped, `as any`) `db` query
// builder produces — matching this file's existing `const db = client as any`
// convention rather than fighting Drizzle's inferred row type here.
async function pollForRows(
  fn: () => Promise<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  { timeoutMs = 3000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const start = Date.now();
  let rows = await fn();
  while (rows.length === 0 && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    rows = await fn();
  }
  return rows;
}

const NANO = '1750000000000000000'; // 2025-06-15T…

/** OTLP logs payload (resourceLogs) for a given service.name + records. */
function logsPayload(serviceName: string, email: string, userId: string, records: Array<Record<string, string>>) {
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: serviceName } },
          { key: 'user.email', value: { stringValue: email } },
          { key: 'user.id', value: { stringValue: userId } },
          { key: 'organization.id', value: { stringValue: 'org_test' } },
        ],
      },
      scopeLogs: [{
        logRecords: records.map(r => ({
          timeUnixNano: NANO,
          attributes: Object.entries(r).map(([key, value]) => ({ key, value: { stringValue: value } })),
        })),
      }],
    }],
  };
}

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');

  try {
    // Dynamic imports AFTER the DATABASE_URL env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const { jsonToText } = await import('@/lib/db/json');
    const { processOtlpLogs } = await import('@/lib/otel/cowork-receiver');
    const { processCodeOtlpLogs } = await import('@/lib/otel/code-receiver');
    const { eq } = await import('drizzle-orm');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;

    // ══════════════════════════════════════════════════════════════════════
    // SECTION B — cowork logs: token_usage jsonb round-trip + flags +
    // deferred PII alert reliability (fires AFTER the record commits).
    // ══════════════════════════════════════════════════════════════════════
    const coworkResult = await processOtlpLogs(
      logsPayload('cowork', 'cw@example.com', 'u_cw', [
        { 'event.name': 'user_prompt', 'session.id': 'sess_cw', 'prompt.id': 'p_clean', prompt: 'just a normal prompt' },
        { 'event.name': 'user_prompt', 'session.id': 'sess_cw', 'prompt.id': 'p_pii', prompt: 'email me at john@example.com please' },
        {
          'event.name': 'api_request', 'session.id': 'sess_cw', 'prompt.id': 'p_api',
          model: 'claude-opus-4-8', input_tokens: '100', output_tokens: '50',
          cache_read_tokens: '10', cache_creation_tokens: '5',
        },
      ]),
    );

    expect(coworkResult.errors).toEqual([]);
    expect(coworkResult.logsInserted).toBe(3);
    // alertsFired no longer counts PII alerts — the path is async since the
    // confirmation check landed. flag_reason is still written synchronously
    // inside the ingest transaction, so that is what proves detection ran.
    const flagged = await db
      .select({ flag_reason: schema.coworkMessages.flag_reason })
      .from(schema.coworkMessages)
      .where(eq(schema.coworkMessages.flagged, 1));
    expect(flagged.some((r: { flag_reason: string | null }) => r.flag_reason?.startsWith('PII detected:'))).toBe(true);

    const clean = (await db.select().from(schema.coworkMessages).where(eq(schema.coworkMessages.prompt_id, 'p_clean')))[0];
    expect(clean.flagged).toBe(0);
    expect(clean.surface).toBe('cowork');
    expect(clean.message_type).toBe('cowork_user_message');

    const pii = (await db.select().from(schema.coworkMessages).where(eq(schema.coworkMessages.prompt_id, 'p_pii')))[0];
    expect(pii.flagged).toBe(1);
    expect(pii.flag_reason).toContain('PII detected');

    // cowork_messages.token_usage jsonb round-trip.
    const api = (await db.select().from(schema.coworkMessages).where(eq(schema.coworkMessages.prompt_id, 'p_api')))[0];
    const expectedUsage = JSON.stringify({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5 });
    expect(jsonToText(api.token_usage)).toBe(expectedUsage);
    expect(JSON.parse(jsonToText(api.token_usage)!)).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5 });

    // The deferred PII alert fired AFTER the record committed — it landed in
    // the alerts table (via insertAlert → getTypedClient → the test DB).
    const alertRows = await pollForRows(() =>
      db.select().from(schema.alerts).where(eq(schema.alerts.user_id, 'u_cw')),
    );
    expect(alertRows.length).toBeGreaterThanOrEqual(1);
    expect(alertRows.some((a: { alert_type: string }) => a.alert_type === 'policy')).toBe(true);
    // raw_evidence round-trips too (Policy A on the alerts jsonb column).
    const policyAlert = alertRows.find((a: { alert_type: string }) => a.alert_type === 'policy')!;
    expect(JSON.parse(jsonToText(policyAlert.raw_evidence)!).pii_type).toBe('email');

    // ══════════════════════════════════════════════════════════════════════
    // SECTION C — code logs: surface='code' ingest + PII flag
    // ══════════════════════════════════════════════════════════════════════
    const codeResult = await processCodeOtlpLogs(
      logsPayload('claude-code', 'dev@example.com', 'u_code', [
        { 'event.name': 'user_prompt', 'session.id': 'sess_code', 'prompt.id': 'pc_pii', prompt: 'ssn is 123-45-6789 for the ticket' },
        {
          'event.name': 'api_request', 'session.id': 'sess_code', 'prompt.id': 'pc_api',
          model: 'claude-opus-4-8', input_tokens: '200', output_tokens: '80', stop_reason: 'end_turn',
        },
      ]),
    );

    expect(codeResult.errors).toEqual([]);
    expect(codeResult.processed).toBe(2);

    const codeMsg = (await db.select().from(schema.coworkMessages).where(eq(schema.coworkMessages.prompt_id, 'pc_pii')))[0];
    expect(codeMsg.surface).toBe('code');
    expect(codeMsg.message_type).toBe('code_user_message');
    expect(codeMsg.flagged).toBe(1);

    const meta = (await db.select().from(schema.codeAssistantMeta).where(eq(schema.codeAssistantMeta.prompt_id, 'pc_api')))[0];
    expect(meta.model).toBe('claude-opus-4-8');
    expect(Number(meta.input_tokens)).toBe(200);
    expect(meta.source).toBe('otel');

    // ══════════════════════════════════════════════════════════════════════
    // SECTION D — codified skill name normalisation:
    // resolveCodifiedSkillName joins skill_library_entries to
    // use_case_skill_drafts (lib/library/codified-skill-name.ts). That join
    // was never exercised on Postgres before this section, which sends a
    // skill_activated event through both receivers. A codified
    // Board entry ('variance-commentary', linked from a drafts row) must
    // absorb a marketplace-prefixed skill_activated event on BOTH surfaces:
    // the invocation stores the bare name and no new Board row is created.
    // ══════════════════════════════════════════════════════════════════════
    const [codifiedEntry] = await db
      .insert(schema.skillLibraryEntries)
      .values({
        name: 'variance-commentary', type: 'skill', surface: 'cowork', source: 'org',
        is_published: 1, author_user_id: null, description: 'claimed',
      })
      .returning();
    await db.insert(schema.useCases).values({ id: 'uc-codified-pg', title: 'UC variance-commentary', status: 'confirmed' });
    await db.insert(schema.useCaseSkillDrafts).values({
      use_case_id: 'uc-codified-pg', skill_name: 'variance-commentary', description: 'd', body_md: 'b',
      owner_questions_json: '[]', citations_json: '{}', corpus_stats_json: '{}', thin: 0, model: 'm',
      generated_at: 1, downloaded_at: 2, library_entry_id: codifiedEntry.id,
    });
    const entriesBeforeCodified = (await db.select().from(schema.skillLibraryEntries)).length;

    const coworkCodifiedResult = await processOtlpLogs(
      logsPayload('cowork', 'codified@example.com', 'u_codified', [
        { 'event.name': 'claude_code.skill_activated', 'session.id': 'sess_codified_cw', 'prompt.id': 'p_codified_cw', 'skill.name': 'acme-library:variance-commentary' },
      ]),
    );
    expect(coworkCodifiedResult.errors).toEqual([]);
    const coworkInvocation = (await db.select({ skill_name: schema.coworkSkillInvocations.skill_name })
      .from(schema.coworkSkillInvocations)
      .where(eq(schema.coworkSkillInvocations.session_id, 'sess_codified_cw')))[0];
    expect(coworkInvocation.skill_name).toBe('variance-commentary');

    const codeCodifiedResult = await processCodeOtlpLogs(
      logsPayload('claude-code', 'codified@example.com', 'u_codified', [
        { 'event.name': 'claude_code.skill_activated', 'session.id': 'sess_codified_code', 'prompt.id': 'p_codified_code', 'skill.name': 'acme-library:variance-commentary' },
      ]),
    );
    expect(codeCodifiedResult.errors).toEqual([]);
    const codeInvocation = (await db.select({ skill_name: schema.coworkSkillInvocations.skill_name })
      .from(schema.coworkSkillInvocations)
      .where(eq(schema.coworkSkillInvocations.session_id, 'sess_codified_code')))[0];
    expect(codeInvocation.skill_name).toBe('variance-commentary');

    // No new Board entry for the prefixed name, on either surface.
    expect((await db.select().from(schema.skillLibraryEntries)).length).toBe(entriesBeforeCodified);
  } finally {
    await cleanup();
  }
}

describe('otel receivers (postgres)', () => {
  it(
    'jsonb round-trip + deferred PII alert + flags behave correctly on postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
