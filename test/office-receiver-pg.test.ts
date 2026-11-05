// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Claude in Office (Office agents) ingest on Postgres, from a real capture.
//
// test/fixtures/office-agent-capture.jsonl is what the Office add-in sent to a
// collector on a Team plan (Word, Excel and PowerPoint, 2026-11-05), one OTLP
// export per line, with every prompt, email, document address, id and tool
// input/output replaced by made-up values. Lines are fed in the order they
// arrived, as the collector would forward them.
//
// Harness rule (see otel-receivers-pg.test.ts): modules that reach the
// database are imported AFTER createTestDbClient has set DATABASE_URL.
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const CAPTURE = fs
  .readFileSync(path.join(__dirname, 'fixtures', 'office-agent-capture.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map(l => JSON.parse(l));

const NANO = String(Math.floor(Date.now() / 1000) * 1_000_000_000);

function querySpan(prompt: string, traceId: string, sessionId: string) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'office-agent' } }] },
      scopeSpans: [{
        spans: [{
          traceId, spanId: `${traceId.slice(0, 15)}1`, name: 'agent.query',
          startTimeUnixNano: NANO, endTimeUnixNano: NANO,
          attributes: [
            { key: 'agent.surface', value: { stringValue: 'mail' } },
            { key: 'session.id', value: { stringValue: sessionId } },
            { key: 'user.email', value: { stringValue: 'test.user@example.com' } },
            { key: 'user.message', value: { stringValue: prompt } },
            { key: 'document.url', value: { stringValue: 'https://outlook.example.com/mail/inbox/id/Example%20thread' } },
          ],
        }],
      }],
    }],
  };
}

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  try {
    const { schema } = await import('@/lib/db/schema');
    const { processOfficeSpans } = await import('@/lib/otel/office-receiver');
    const { aggregateCoworkSessionStats } = await import('@/lib/pulse/cowork/session-aggregator');
    const { eq, isNotNull } = await import('drizzle-orm');
    const db = client as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const cm = schema.coworkMessages;

    // 1. The whole capture ingests with no errors.
    for (const line of CAPTURE) {
      const r = await processOfficeSpans(line);
      expect(r.errors).toEqual([]);
    }

    const rows = await db.select().from(cm).where(isNotNull(cm.product));
    const count = (type: string, product?: string) =>
      rows.filter((r: { message_type: string; product: string }) => r.message_type === type && (!product || r.product === product)).length;

    // 2. Every span became one row, under the right app.
    expect(count('cowork_user_message')).toBe(4);
    expect(count('cowork_user_message', 'word')).toBe(2);
    expect(count('cowork_user_message', 'excel')).toBe(1);
    expect(count('cowork_user_message', 'powerpoint')).toBe(1);
    expect(count('cowork_api_request')).toBe(14);
    expect(count('cowork_tool_metadata')).toBe(13);
    for (const r of rows) {
      expect(r.surface).toBe('cowork');
      expect(r.source).toBe('otel');
    }

    // 3. Prompt text is stored; tool input and output (document content) never are.
    const prompts = rows.filter((r: { message_type: string }) => r.message_type === 'cowork_user_message');
    expect(prompts.map((r: { content_full: string }) => r.content_full).sort()).toEqual(
      ['Example doc prompt', 'Example doc prompt', 'Example sheet prompt', 'Example slide prompt'],
    );
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain('example output');
    expect(everything).not.toContain('"example":"input"');
    expect(everything).not.toContain('sharepoint.com');
    for (const r of rows.filter((x: { message_type: string }) => x.message_type === 'cowork_tool_metadata')) {
      expect(r.content_full).toBeNull();
      expect(r.tool_input_preview).toBeNull();
      expect(r.tool_output_preview).toBeNull();
    }

    // 4. No cost is stored: estimated Office spend must never join Cowork's reported spend.
    for (const r of rows) expect(r.cost_usd).toBeNull();
    const call = rows.find((r: { message_type: string }) => r.message_type === 'cowork_api_request');
    expect(call.model).toBe('claude-opus-5-5');
    expect(call.token_usage).not.toBeNull();

    // 5. The document's file name is kept only on the calls that changed it.
    const named = rows
      .filter((r: { output_name: string | null }) => r.output_name)
      .map((r: { content_preview: string; output_name: string }) => `${r.content_preview}:${r.output_name}`)
      .sort();
    expect(named).toEqual(['execute_office_js:Example.pptx', 'propose_doc_edits:Example.docx']);

    // 6. Sessions carry the app.
    const sessions = await db.select().from(schema.coworkSessions).where(isNotNull(schema.coworkSessions.product));
    expect(sessions.map((s: { product: string }) => s.product).sort()).toEqual(['excel', 'powerpoint', 'word']);

    // 7. A re-delivered export is skipped whole.
    const again = await processOfficeSpans(CAPTURE[CAPTURE.length - 1]);
    expect(again.logsInserted).toBe(0);
    expect((await db.select().from(cm).where(isNotNull(cm.product))).length).toBe(rows.length);

    // 8. Produced output: PowerPoint wrote and Word proposed edits; Excel only read.
    const agg = await aggregateCoworkSessionStats();
    expect(agg.errors).toEqual([]);
    const produced = new Map<string, number | null>();
    for (const s of sessions) {
      const stat = (await db.select().from(schema.coworkSessionStats).where(eq(schema.coworkSessionStats.session_id, s.id)))[0];
      produced.set(s.product, stat ? Number(stat.produced_output) : null);
    }
    expect(produced.get('powerpoint')).toBe(1);
    expect(produced.get('word')).toBe(1);
    expect(produced.get('excel')).toBe(0);

    // 9. Personal data in an Office prompt is flagged like a Cowork prompt.
    const pii = await processOfficeSpans(querySpan('Send this to jane.doe@example.org please', '0123456789abcdef0123456789abcdef', 'office-mail-session'));
    expect(pii.errors).toEqual([]);
    const flagged = (await db.select().from(cm).where(eq(cm.session_id, 'office-mail-session')))[0];
    expect(flagged.product).toBe('outlook');
    expect(flagged.flagged).toBe(1);
    expect(flagged.flag_reason).toContain('email');
    // The alert is fire-and-forget (no model call inside ingest): wait for it.
    await vi.waitFor(async () => {
      const alerts = await db.select().from(schema.alerts);
      expect(alerts.some((a: { raw_evidence: unknown }) => JSON.stringify(a.raw_evidence).includes(flagged.id))).toBe(true);
    }, { timeout: 10_000, interval: 100 });
  } finally {
    await cleanup();
  }
}

describe('office receiver (postgres)', () => {
  it('stores a real Word, Excel and PowerPoint capture beside Cowork without document content or cost', async () => {
    await runSpec();
  }, 180_000);
});
