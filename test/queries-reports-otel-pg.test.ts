// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for the Reports + Compliance + OTel reads
// group of lib/db/queries.ts: getReports, getReportById, insertReport,
// getComplianceEvents, getComplianceEventById, getRecentComplianceEvents,
// getEventsLast24h, getEventsLast24hCombined, getOtelEvents,
// getRecentOtelEvents, getCoworkSessionCount, getCoworkSessionCountThisWeek.
//
// This group is the second heavy user of Policy A (jsonb read/write
// normalisation via lib/db/json.ts's jsonToText/textToJsonValue):
// compliance_events.metadata and otel_events.tool_input/token_usage/
// file_paths are `jsonb`. The central assertion is
// the ROUND TRIP — write a JSON string in (via textToJsonValue, mirroring
// how a real inserter would call it), read the SAME JSON string back out —
// getComplianceEvents' LEFT JOIN-to-users department
// filter and every count (getEventsLast24h/getEventsLast24hCombined/
// getCoworkSessionCount*) coming back as a real `number` are also proved.
//
// HARNESS RULE (copied from queries-alerts-pg.test.ts): queries.ts reaches
// the database through getClient(), which binds to DATABASE_URL on first
// use, so the module-under-test (and schema/json helpers) are
// DYNAMIC-imported AFTER createTestDbClient() has set DATABASE_URL +
// reset modules.
import { describe, it, expect } from 'vitest';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  try {
    // Dynamic import AFTER the DATABASE_URL env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const { textToJsonValue } = await import('@/lib/db/json');
    const queries = await import('@/lib/db/queries');
    const {
      getReports, getReportById, insertReport,
      getComplianceEvents, getComplianceEventById, getRecentComplianceEvents,
      getEventsLast24h, getEventsLast24hCombined,
      getOtelEvents, getRecentOtelEvents,
      getCoworkSessionCount, getCoworkSessionCountThisWeek,
    } = queries;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schema.users).values([
      { id: 'user-1', email: 'u1@test.local', department: 'Eng' },
      { id: 'user-2', email: 'u2@test.local', department: 'Sales' },
    ]);

    // ── insertReport / getReportById / getReports ───────────────────────
    await insertReport({
      id: 'report-1', report_type: 'weekly', period_start: '2026-06-01', period_end: '2026-06-07',
      generated_by: 'admin-1', content_md: '# Week 1', content_summary: 'summary 1',
    });
    await insertReport({
      id: 'report-2', report_type: 'weekly', period_start: '2026-06-08', period_end: '2026-06-14',
      generated_by: 'admin-1', content_md: '# Week 2', content_summary: null,
    });

    const r1 = await getReportById('report-1');
    expect(r1?.content_md).toBe('# Week 1');
    expect(r1?.generated_by).toBe('admin-1');
    expect(await getReportById('does-not-exist')).toBeUndefined();

    const allReports = await getReports();
    expect(allReports.length).toBe(2);
    // ORDER BY generated_at DESC — report-2 was inserted after report-1, so
    // on any clock granularity it's either strictly newer or tied; either
    // way both ids must be present.
    expect(allReports.map((r) => r.id).sort()).toEqual(['report-1', 'report-2']);
    expect((await getReports(1)).length).toBe(1);

    // ── compliance_events fixtures — metadata Policy A round trip ───────
    // ce-1/2 carry real metadata JSON (the round-trip proof); ce-3 carries
    // null to prove the null path stays null too.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schema.complianceEvents).values([
      {
        id: 'ce-1', user_id: 'user-1', event_type: 'user_prompt', surface: 'chat',
        content_preview: 'Please Reset my password', flagged: 1, flag_reason: 'pii', occurred_at: NOW - 10,
        metadata: textToJsonValue(JSON.stringify({ pii_type: 'email' })),
      },
      {
        id: 'ce-2', user_id: 'user-2', event_type: 'user_prompt', surface: 'code',
        flagged: 0, occurred_at: NOW - 5,
        metadata: textToJsonValue(JSON.stringify({ note: 'ok' })),
      },
      {
        id: 'ce-3', user_id: 'user-1', event_type: 'user_prompt', surface: 'chat',
        flagged: 0, occurred_at: NOW - (2 * DAY),
        metadata: textToJsonValue(null),
      },
    ]);

    // ── getComplianceEventById: round trip + null path ──────────────────
    const ce1 = await getComplianceEventById('ce-1');
    expect(ce1?.metadata).toBe(JSON.stringify({ pii_type: 'email' }));
    expect(typeof ce1?.metadata).toBe('string');
    // A second parse must still work — proves it's real JSON text, not a
    // double-encoded string (the pg jsonb write-inverse landmine).
    expect(JSON.parse(ce1!.metadata!)).toEqual({ pii_type: 'email' });

    const ce3 = await getComplianceEventById('ce-3');
    expect(ce3?.metadata).toBeNull();
    expect(await getComplianceEventById('does-not-exist')).toBeUndefined();

    // ── getComplianceEvents: filters (surface / userId / department JOIN /
    //    flaggedOnly / dateFrom / limit+offset) ──────────────────────────
    expect((await getComplianceEvents()).length).toBe(3);
    expect((await getComplianceEvents({ surface: 'chat' })).map((e) => e.id).sort()).toEqual(['ce-1', 'ce-3']);
    expect((await getComplianceEvents({ userId: 'user-2' })).map((e) => e.id)).toEqual(['ce-2']);
    expect((await getComplianceEvents({ department: 'Eng' })).map((e) => e.id).sort()).toEqual(['ce-1', 'ce-3']);
    expect((await getComplianceEvents({ flaggedOnly: true })).map((e) => e.id)).toEqual(['ce-1']);
    expect((await getComplianceEvents({ dateFrom: NOW - DAY })).map((e) => e.id).sort()).toEqual(['ce-1', 'ce-2']);
    expect((await getComplianceEvents({ limit: 1, offset: 1 })).length).toBe(1);
    // search: content (case-insensitive), user id, and no match at all.
    expect((await getComplianceEvents({ search: 'reset MY' })).map((e) => e.id)).toEqual(['ce-1']);
    expect((await getComplianceEvents({ search: 'user-2' })).map((e) => e.id)).toEqual(['ce-2']);
    expect(await getComplianceEvents({ search: 'zqxjwvnonsense' })).toEqual([]);
    // Round trip holds through the filtered/joined path too.
    const eng = await getComplianceEvents({ department: 'Eng' });
    expect(eng.find((e) => e.id === 'ce-1')?.metadata).toBe(JSON.stringify({ pii_type: 'email' }));

    // ── getRecentComplianceEvents: round trip + ordering ─────────────────
    const recent = await getRecentComplianceEvents(2);
    expect(recent.length).toBe(2);
    expect(recent.map((e) => e.id)).toEqual(['ce-2', 'ce-1']); // DESC by occurred_at
    expect(recent.find((e) => e.id === 'ce-2')?.metadata).toBe(JSON.stringify({ note: 'ok' }));

    // ── otel_events fixtures — tool_input/token_usage/file_paths Policy A ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schema.otelEvents).values([
      {
        id: 'oe-1', user_id: 'user-1', session_id: 'sess-a', tool_name: 'Read',
        occurred_at: NOW - 10, event_type: 'tool_decision', source: 'otel', surface: 'code',
        tool_input: textToJsonValue(JSON.stringify({ file_path: '/a.ts' })),
        token_usage: textToJsonValue(JSON.stringify({ input: 10, output: 5 })),
        file_paths: textToJsonValue(JSON.stringify(['/a.ts'])),
      },
      {
        id: 'oe-2', user_id: 'user-2', session_id: 'sess-b', tool_name: 'Bash',
        occurred_at: NOW - 5, event_type: 'tool_decision', source: 'otel', surface: 'code',
        tool_input: textToJsonValue(null), token_usage: textToJsonValue(null), file_paths: textToJsonValue(null),
      },
      {
        id: 'oe-3', user_id: 'user-1', session_id: 'sess-a', tool_name: null,
        occurred_at: NOW - (2 * DAY), event_type: 'process_snapshot', source: 'otel', surface: 'code',
      },
      {
        id: 'oe-4', user_id: null, session_id: 'sess-c', tool_name: null,
        occurred_at: NOW - 3, event_type: 'agent_heartbeat', source: 'otel', surface: 'code',
      },
    ]);

    // ── getOtelEvents: filters + Policy A round trip ────────────────────
    const oeAll = await getOtelEvents();
    expect(oeAll.length).toBe(4);
    const oe1 = oeAll.find((e) => e.id === 'oe-1')!;
    expect(oe1.tool_input).toBe(JSON.stringify({ file_path: '/a.ts' }));
    expect(oe1.token_usage).toBe(JSON.stringify({ input: 10, output: 5 }));
    expect(oe1.file_paths).toBe(JSON.stringify(['/a.ts']));
    expect(JSON.parse(oe1.tool_input!)).toEqual({ file_path: '/a.ts' });
    const oe2 = oeAll.find((e) => e.id === 'oe-2')!;
    expect(oe2.tool_input).toBeNull();
    expect(oe2.token_usage).toBeNull();
    expect(oe2.file_paths).toBeNull();

    expect((await getOtelEvents({ userId: 'user-1' })).map((e) => e.id).sort()).toEqual(['oe-1', 'oe-3']);
    expect((await getOtelEvents({ dateFrom: NOW - DAY })).map((e) => e.id).sort()).toEqual(['oe-1', 'oe-2', 'oe-4']);
    expect((await getOtelEvents({ limit: 2, offset: 0 })).length).toBe(2);

    // ── getRecentOtelEvents: round trip + ordering ──────────────────────
    const recentOtel = await getRecentOtelEvents(2);
    expect(recentOtel.map((e) => e.id)).toEqual(['oe-4', 'oe-2']); // DESC by occurred_at
    const recentOe1 = (await getRecentOtelEvents(10)).find((e) => e.id === 'oe-1');
    expect(recentOe1?.tool_input).toBe(JSON.stringify({ file_path: '/a.ts' }));

    // ── getCoworkSessionCount: DISTINCT session_id over otel_events ─────
    // sess-a, sess-b, sess-c = 3 distinct sessions.
    const sessionCount = await getCoworkSessionCount();
    expect(sessionCount).toBe(3);
    expect(typeof sessionCount).toBe('number');

    // ── getEventsLast24h: compliance + cowork + chat, ingested_at >= dayAgo ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schema.coworkMessages).values([
      { id: 'cm-1', session_id: 'sess-x', user_id: 'user-1', message_type: 'cowork_user_message', occurred_at: NOW - 10, ingested_at: NOW - 10 },
      { id: 'cm-2', session_id: 'sess-y', user_id: 'user-2', message_type: 'cowork_user_message', occurred_at: NOW - (2 * DAY), ingested_at: NOW - (2 * DAY) },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schema.chatMessages).values([
      { id: 'chm-1', user_id: 'user-1', prompt_text: 'hi', prompt_length: 2, occurred_at: NOW - 10, ingested_at: NOW - 10 },
    ]);
    // The compliance_events fixture insert above did NOT set ingested_at
    // explicitly — it falls back to the column default (extract(epoch from
    // now())), so all 3 count as "last 24h".
    const last24h = await getEventsLast24h();
    // 3 compliance (ce-1/2/3, all default-ingested "now") + 1 cowork (cm-1;
    // cm-2 is 2 days old) + 1 chat (chm-1) = 5.
    expect(last24h).toBe(5);
    expect(typeof last24h).toBe('number');

    // ── getEventsLast24hCombined: compliance + otel, excluding
    //    process_snapshot/agent_heartbeat event types ────────────────────
    const combined = await getEventsLast24hCombined();
    // 3 compliance (same default-ingested rows as above) + otel rows with
    // occurred_at >= dayAgo AND event_type NOT IN (process_snapshot,
    // agent_heartbeat): oe-1 (tool_decision, -10s) and oe-2 (tool_decision,
    // -5s) qualify; oe-3 is 2 days old (excluded by date); oe-4 is
    // agent_heartbeat (excluded by type) = 3 + 2 = 5.
    expect(combined).toBe(5);
    expect(typeof combined).toBe('number');

    // ── getCoworkSessionCountThisWeek: primary cowork_messages, fallback
    //    to otel_events when cowork has no recent sessions ───────────────
    // cm-1 (sess-x, -10s) is within the week; cm-2 (sess-y) is 2 days old but
    // still within 7 days — both sess-x and sess-y count = 2.
    const thisWeek = await getCoworkSessionCountThisWeek();
    expect(thisWeek).toBe(2);
    expect(typeof thisWeek).toBe('number');
  } finally {
    await cleanup();
  }
}

describe('reports + compliance + otel reads (postgres)', () => {
  it(
    'getReports/getComplianceEvents/getOtelEvents/session counts behave correctly on postgres — proves the metadata/tool_input/token_usage/file_paths jsonb round trip',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
