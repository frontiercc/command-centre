// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// lib/compliance/activity-sync.ts
// (runActivitySync). REWRITTEN: the Activity Feed sorts newest-first, so the
// original after_id walk (no order param -> API default desc) paged
// BACKWARD in time and new events never arrived — a real shipped bug. The
// fix pages toward NEWER events (order=asc), abandons the old desc cursor
// key in favour of a new one (automatic reset, no manual DB step), bounds
// the first-ever run to a backfill window (not full history), and adds a
// one-page overlap re-poll per cursor-walk run to catch late-arriving rows
// that land behind an already-advanced cursor.
//
// Covers, against a mocked listActivities (global.fetch dispatched by URL)
// plus the REAL getConfigValue/setConfigValue:
//   1. No key configured -> zeros, no fetch calls at all.
//   2. First-ever run (no complianceActivityCursorAsc): first listActivities
//      call has order=asc + created_at.gte ~= now-7d (default backfill), NO
//      after_id. Regression for the bug: a two-page asc walk (reachable only
//      via after_id=<page-1 last_id>) ingests BOTH pages and advances the
//      cursor to the 2nd page's last_id -> proves forward-in-time paging,
//      and that no overlap poll fires on this first-ever run.
//   3. Subsequent run (asc cursor already set): the walk call uses
//      order=asc + after_id=<cursor> (no created_at.gte); after that page,
//      ONE extra overlap page is fetched via created_at.gte ~= now-60min
//      (no after_id) whose already-seen id is deduped (no duplicate row) and
//      whose new id IS inserted; the overlap page does NOT advance the
//      cursor.
//   4. Row mapping: a user_actor activity -> compliance_events row with
//      event_type/surface/user_id (resolved by email)/content_preview NULL/
//      occurred_at from created_at/metadata JSON carrying ip_address +
//      user_agent + actor_type + any extra top-level activity fields.
//   5. api_actor activity (no email) -> row with user_id NULL, still ingested.
//   6. Idempotency: the same activity id delivered again in a later run must
//      not create a second row.
//   7. Page cap: at most MAX_PAGES_PER_RUN (20) pages fetched per run even
//      when more pages are available (cursor persists at the cap); the
//      overlap poll does NOT fire when the run's page budget is exhausted.
//
// HARNESS RULE (copied from test/compliance-chat-sync.test.ts): the module
// under test reaches the database through getClient(), which binds to
// DATABASE_URL on first use, so the module under test (and schema/json
// helpers) are DYNAMIC-imported AFTER createTestDbClient('postgres') has set
// DATABASE_URL + reset modules.
import { describe, it, expect, vi } from 'vitest';

const NOW = Math.floor(Date.now() / 1000);

/** Minimal fetch Response stand-in — only what complianceGet uses. */
function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** compliance_events.metadata is jsonb, which the pg codec parses on read —
 *  accept either a parsed object or a raw JSON string. */
function parseMetadata(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') return JSON.parse(v);
  return v as Record<string, unknown>;
}

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  const originalFetch = global.fetch;

  try {
    // Dynamic imports AFTER the DATABASE_URL env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const { eq } = await import('drizzle-orm');
    const { getConfigValue, setConfigValue } = await import('@/lib/config');
    const { runActivitySync } = await import('@/lib/compliance/activity-sync');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;

    // ════════════════════════════════════════════════════════════════════
    // Behaviour 1 — no key configured: zeros, no fetch calls.
    // ════════════════════════════════════════════════════════════════════
    let fetchCallCount = 0;
    global.fetch = vi.fn(async () => {
      fetchCallCount++;
      throw new Error('fetch must not be called when no compliance access key is configured');
    }) as unknown as typeof fetch;

    const resultNoKey = await runActivitySync();
    expect(resultNoKey).toEqual({ activities: 0, errors: [] });
    expect(fetchCallCount).toBe(0);

    await setConfigValue('complianceAccessKey', 'test-compliance-key');

    // ════════════════════════════════════════════════════════════════════
    // Behaviours 2/4/5 — first-ever run (no complianceActivityCursorAsc):
    // page 1 is reachable only via created_at.gte + order=asc (no after_id)
    // and has a user_actor activity (act-1, full actor fields + an extra
    // top-level field for the metadata spread) and an api_actor activity
    // with no email (act-2); page 2 (only reachable via
    // after_id=act-2&order=asc) has one more activity (act-3). This proves
    // the walk pages FORWARD (toward newer events), not backward.
    // ════════════════════════════════════════════════════════════════════
    const act1CreatedAt = new Date((NOW - 100) * 1000).toISOString();
    const act2CreatedAt = new Date((NOW - 90) * 1000).toISOString();
    const act3CreatedAt = new Date((NOW - 80) * 1000).toISOString();

    const activity1 = {
      id: 'act-1', type: 'claude_chat_created', created_at: act1CreatedAt,
      actor: {
        type: 'user_actor', email_address: 'ACT@Test.Local', user_id: 'claude-actor-1',
        ip_address: '10.0.0.1', user_agent: 'Mozilla/5.0',
      },
      workspace_id: 'ws-123',
    };
    const activity2 = {
      id: 'act-2', type: 'claude_api_key_created', created_at: act2CreatedAt,
      actor: { type: 'api_actor', ip_address: '10.0.0.2', user_agent: 'curl/8.0' },
    };
    const activity3 = {
      id: 'act-3', type: 'claude_export_created', created_at: act3CreatedAt,
      actor: { type: 'api_actor', ip_address: '10.0.0.3', user_agent: 'curl/8.0' },
    };

    let listCalls: string[] = [];
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      listCalls.push(u);
      if (u.includes('/compliance/activities')) {
        if (u.includes('after_id=act-2')) {
          return jsonResponse({ data: [activity3], has_more: false, first_id: 'act-3', last_id: 'act-3' });
        }
        return jsonResponse({ data: [activity1, activity2], has_more: true, first_id: 'act-1', last_id: 'act-2' });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const resultPages = await runActivitySync();
    expect(resultPages.errors).toEqual([]);
    expect(resultPages.activities).toBe(3);

    // Behaviour 2 — first call has order=asc + created_at.gte ~= now-7d
    // (default backfill), NOT after_id.
    expect(listCalls[0]).toContain('order=asc');
    expect(listCalls[0]).toContain('created_at.gte=');
    expect(listCalls[0]).not.toContain('after_id');
    const gteParam = new URL(listCalls[0]).searchParams.get('created_at.gte')!;
    const gteMs = new Date(gteParam).getTime();
    const expectedBackfillMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(gteMs - expectedBackfillMs)).toBeLessThan(60_000); // within a minute of "now-7d"

    // Regression for the bug — page 2 was reached via after_id (forward
    // paging), and the cursor advanced to the SECOND page's last_id, not the
    // first's. The new asc-cursor key is used; the old desc key stays untouched.
    expect(listCalls.some(u => u.includes('after_id=act-2') && u.includes('order=asc'))).toBe(true);
    expect(await getConfigValue('complianceActivityCursorAsc')).toBe('act-3');
    expect(await getConfigValue('complianceActivityCursor')).toBe(''); // old key never written

    // No overlap poll on the first-ever run — only 2 calls total (page 1 + page 2).
    expect(listCalls.length).toBe(2);

    // Behaviour 4 — row mapping for the user_actor activity.
    const act1Row = (await db.select().from(schema.complianceEvents).where(eq(schema.complianceEvents.id, 'act-1')))[0];
    expect(act1Row).toBeTruthy();
    expect(act1Row.event_type).toBe('claude_chat_created');
    expect(act1Row.surface).toBe('chat');
    expect(act1Row.content_preview).toBeNull();
    expect(Number(act1Row.occurred_at)).toBe(NOW - 100);

    const resolvedActorUser = await db.select().from(schema.users).where(eq(schema.users.id, 'claude-actor-1'));
    expect(resolvedActorUser.length).toBe(1);
    expect(resolvedActorUser[0].email).toBe('ACT@Test.Local');
    expect(act1Row.user_id).toBe('claude-actor-1');

    const meta1 = parseMetadata(act1Row.metadata);
    expect(meta1.ip_address).toBe('10.0.0.1');
    expect(meta1.user_agent).toBe('Mozilla/5.0');
    expect(meta1.actor_type).toBe('user_actor');
    expect(meta1.workspace_id).toBe('ws-123'); // extra field carried through the ...rest spread

    // Behaviour 5 — api_actor activity (no email): user_id NULL, still ingested.
    const act2Row = (await db.select().from(schema.complianceEvents).where(eq(schema.complianceEvents.id, 'act-2')))[0];
    expect(act2Row).toBeTruthy();
    expect(act2Row.user_id).toBeNull();
    expect(act2Row.event_type).toBe('claude_api_key_created');
    const meta2 = parseMetadata(act2Row.metadata);
    expect(meta2.actor_type).toBe('api_actor');
    expect(meta2.ip_address).toBe('10.0.0.2');

    const act3Row = (await db.select().from(schema.complianceEvents).where(eq(schema.complianceEvents.id, 'act-3')))[0];
    expect(act3Row).toBeTruthy();

    // ════════════════════════════════════════════════════════════════════
    // Behaviour 3 — subsequent run (asc cursor already 'act-3'): the walk
    // call uses after_id=act-3 + order=asc; after that page, ONE extra
    // overlap page is fetched via created_at.gte (no after_id) whose
    // already-seen id (act-3) is deduped and whose new id (act-4) IS
    // inserted; the overlap page does NOT advance the cursor.
    // ════════════════════════════════════════════════════════════════════
    const act4CreatedAt = new Date((NOW - 70) * 1000).toISOString();
    const activity4 = {
      id: 'act-4', type: 'claude_chat_created', created_at: act4CreatedAt,
      actor: { type: 'api_actor', ip_address: '10.0.0.4', user_agent: 'curl/8.0' },
    };

    listCalls = [];
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      listCalls.push(u);
      if (u.includes('/compliance/activities')) {
        if (u.includes('after_id=act-3')) {
          // Main cursor walk: one new activity, no more pages.
          return jsonResponse({ data: [activity4], has_more: false, first_id: 'act-4', last_id: 'act-4' });
        }
        if (u.includes('created_at.gte=')) {
          // Overlap re-poll: re-delivers act-3 (already seen, must dedupe)
          // plus a genuinely new late-arriver, act-4b.
          return jsonResponse({
            data: [
              activity3,
              { id: 'act-4b', type: 'claude_export_created', created_at: act4CreatedAt, actor: { type: 'api_actor' } },
            ],
            has_more: false, first_id: 'act-3', last_id: 'act-4b',
          });
        }
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const resultOverlap = await runActivitySync();
    expect(resultOverlap.errors).toEqual([]);

    // Main walk call.
    expect(listCalls[0]).toContain('after_id=act-3');
    expect(listCalls[0]).toContain('order=asc');
    // Overlap call: created_at.gte, no after_id, roughly now-60min.
    const overlapCall = listCalls.find(u => !u.includes('after_id'));
    expect(overlapCall).toBeTruthy();
    const overlapGte = new URL(overlapCall!).searchParams.get('created_at.gte')!;
    const overlapGteMs = new Date(overlapGte).getTime();
    expect(Math.abs(overlapGteMs - (Date.now() - 60 * 60 * 1000))).toBeLessThan(60_000);
    expect(listCalls.length).toBe(2); // main walk (1 page, has_more:false) + exactly one overlap page

    // Cursor advances to the main walk's last_id (act-4), NOT the overlap
    // page's last_id (act-4b) — the overlap poll never advances the cursor.
    expect(await getConfigValue('complianceActivityCursorAsc')).toBe('act-4');

    // act-3 was re-delivered by the overlap page but must still be exactly one row.
    const act3RowsAfterOverlap = await db.select().from(schema.complianceEvents).where(eq(schema.complianceEvents.id, 'act-3'));
    expect(act3RowsAfterOverlap.length).toBe(1);

    // The genuinely new late-arriver from the overlap page WAS inserted.
    const act4bRow = (await db.select().from(schema.complianceEvents).where(eq(schema.complianceEvents.id, 'act-4b')))[0];
    expect(act4bRow).toBeTruthy();
    expect(act4bRow.event_type).toBe('claude_export_created');

    // ════════════════════════════════════════════════════════════════════
    // Behaviour 6 — idempotency: the same activity id (act-4) delivered
    // again in a later run must not create a second row. (Overlap page
    // returns nothing new here, isolating the assertion to the main walk.)
    // ════════════════════════════════════════════════════════════════════
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/compliance/activities')) {
        if (u.includes('after_id=act-4')) {
          return jsonResponse({ data: [activity4], has_more: false, first_id: 'act-4', last_id: 'act-4' });
        }
        if (u.includes('created_at.gte=')) {
          return jsonResponse({ data: [], has_more: false, first_id: null, last_id: null });
        }
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const resultDup = await runActivitySync();
    expect(resultDup.errors).toEqual([]);
    const act4RowsAfterDup = await db.select().from(schema.complianceEvents).where(eq(schema.complianceEvents.id, 'act-4'));
    expect(act4RowsAfterDup.length).toBe(1); // still exactly one row, no duplicate

    // ════════════════════════════════════════════════════════════════════
    // Behaviour 7 — page cap: MAX_PAGES_PER_RUN (20) pages fetched per run
    // even though the (simulated) feed always claims has_more=true (i.e. a
    // 21st+ page would be available); the cursor persists at the 20th page's
    // last_id so the next run resumes from there. The overlap poll does NOT
    // fire because the run's page budget is exhausted by the main walk.
    // ════════════════════════════════════════════════════════════════════
    let capCallCount = 0;
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/compliance/activities')) {
        capCallCount++;
        const lastId = `cap-page-${capCallCount}`;
        return jsonResponse({
          data: [{
            id: `cap-act-${capCallCount}`, type: 'claude_chat_created',
            created_at: new Date(NOW * 1000).toISOString(),
            actor: { type: 'api_actor' },
          }],
          has_more: true, first_id: lastId, last_id: lastId,
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const resultCap = await runActivitySync();
    expect(resultCap.errors).toEqual([]);
    expect(capCallCount).toBe(20); // the cap, not the 21+ pages the feed claims are available, and no extra overlap call
    expect(resultCap.activities).toBe(20);
    expect(await getConfigValue('complianceActivityCursorAsc')).toBe('cap-page-20');

    // ════════════════════════════════════════════════════════════════════
    // Behaviour 8 — self-noise exclusion:
    // a page containing an excluded type (relying on the DEFAULT exclusion
    // list, complianceActivityExcludedTypes is unset here — just
    // 'compliance_api_accessed', CCC's own polling) alongside a normal
    // claude_chat_created event must skip the excluded row (not inserted,
    // not counted) but STILL advance the cursor to the page's last_id.
    // ════════════════════════════════════════════════════════════════════
    const noiseActivity = {
      id: 'act-noise-1', type: 'compliance_api_accessed',
      created_at: new Date(NOW * 1000).toISOString(),
      actor: { type: 'api_actor' },
    };
    const chatActivity = {
      id: 'act-chat-1', type: 'claude_chat_created',
      created_at: new Date(NOW * 1000).toISOString(),
      actor: { type: 'api_actor' },
    };

    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/compliance/activities')) {
        if (u.includes('after_id=cap-page-20')) {
          return jsonResponse({ data: [noiseActivity, chatActivity], has_more: false, first_id: 'act-noise-1', last_id: 'act-chat-1' });
        }
        if (u.includes('created_at.gte=')) {
          // Overlap re-poll — nothing new, isolates this assertion to the main walk.
          return jsonResponse({ data: [], has_more: false, first_id: null, last_id: null });
        }
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const resultExclusion = await runActivitySync();
    expect(resultExclusion.errors).toEqual([]);
    // Only the non-excluded activity is counted.
    expect(resultExclusion.activities).toBe(1);

    const noiseRows = await db.select().from(schema.complianceEvents).where(eq(schema.complianceEvents.id, 'act-noise-1'));
    expect(noiseRows.length).toBe(0); // excluded type is never inserted

    const chatRow = (await db.select().from(schema.complianceEvents).where(eq(schema.complianceEvents.id, 'act-chat-1')))[0];
    expect(chatRow).toBeTruthy();
    expect(chatRow.event_type).toBe('claude_chat_created');

    // Cursor still advances to the page's last_id even though one row in
    // that page was skipped — exclusion must never create a resume gap.
    expect(await getConfigValue('complianceActivityCursorAsc')).toBe('act-chat-1');
  } finally {
    global.fetch = originalFetch;
    await cleanup();
  }
}

describe('compliance activity-sync (postgres)', () => {
  it(
    'runActivitySync: no-key zeros, forward-in-time asc paging + backfill window + cursor reset, overlap re-poll dedup, row mapping (user_actor + api_actor), idempotency, page cap',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
