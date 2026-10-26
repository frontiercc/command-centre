// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from './helpers/db';

const NOW = 1754130000; // 2026-08-02 (Sunday) — window = last completed Mon-UTC week
const STRIPPED = '[Content removed — retention policy]';

describe('gatherHighlights', () => {
  let cleanup: () => Promise<void>;
  beforeEach(async () => { const t = await createTestDatabase(); cleanup = t.cleanup; });
  afterEach(async () => cleanup());

  async function seed() {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const { weekStart } = await import('@/lib/pulse/period');
    const client = await getTypedClient();
    const wkEnd = weekStart(NOW);          // exclusive end of last completed week
    const wkStart = wkEnd - 7 * 86400;
    const inWin = wkStart + 3600;          // safely inside the window

    await client.insert(schema.users).values([
      { id: 'u-hl-1', email: 'hl1@test.local', display_name: 'Person One' },
      { id: 'u-hl-2', email: 'hl2@test.local', display_name: 'Person Two' },
    ] as never);

    // Three tier-3 messages: one long+clean, one carrying identity to strip,
    // one stripped-by-retention (must be excluded). One tier-1 (excluded).
    await client.insert(schema.coworkMessages).values([
      { id: 'm-hl-1', session_id: 's-hl-1', user_id: 'u-hl-1', message_type: 'cowork_user_message', surface: 'cowork',
        content_preview: 'Build a client proposal', content_full: 'Build a client-ready proposal deck. '.repeat(20), occurred_at: inWin },
      { id: 'm-hl-2', session_id: 's-hl-2', user_id: 'u-hl-2', message_type: 'cowork_user_message', surface: 'cowork',
        content_preview: 'Analyse the file', content_full: 'Analyse C:\\Users\\jane\\report.xlsx and see https://internal.corp/wiki/page then summarise', occurred_at: inWin },
      { id: 'm-hl-3', session_id: 's-hl-3', user_id: 'u-hl-1', message_type: 'cowork_user_message', surface: 'cowork',
        content_preview: STRIPPED, content_full: null, occurred_at: inWin },
      { id: 'm-hl-4', session_id: 's-hl-4', user_id: 'u-hl-1', message_type: 'cowork_user_message', surface: 'cowork',
        content_preview: 'tiny', content_full: 'tiny tier-1 task', occurred_at: inWin },
      { id: 'm-hl-5', session_id: 's-hl-5', user_id: 'u-hl-1', message_type: 'cowork_user_message', surface: 'cowork',
        content_preview: '<scheduled-task id=1>', content_full: '<scheduled-task> nightly sync for bob@corp', occurred_at: inWin },
      { id: 'm-hl-6', session_id: 's-hl-6', user_id: 'u-hl-1', message_type: 'cowork_user_message', surface: 'cowork',
        content_preview: 'out of window', content_full: 'outside the completed week', occurred_at: wkEnd + 3600 },
      // NULL content_preview but real content_full — must NOT be dropped by
      // the ne()/notLike() NULL-preview exclusion filters.
      { id: 'm-hl-7', session_id: 's-hl-7', user_id: 'u-hl-2', message_type: 'cowork_user_message', surface: 'cowork',
        content_preview: null, content_full: 'Reconcile the vendor invoice totals against the ledger export', occurred_at: inWin },
    ] as never);

    await client.insert(schema.pulseClassifications).values([
      { cowork_message_id: 'm-hl-1', user_id: 'u-hl-1', tier: 3, task_type: 'workflow', classifier_confidence: 0.9, classifier_model: 'test', classified_at: inWin },
      { cowork_message_id: 'm-hl-2', user_id: 'u-hl-2', tier: 3, task_type: 'analysis', classifier_confidence: 0.9, classifier_model: 'test', classified_at: inWin },
      { cowork_message_id: 'm-hl-3', user_id: 'u-hl-1', tier: 3, task_type: 'workflow', classifier_confidence: 0.9, classifier_model: 'test', classified_at: inWin },
      { cowork_message_id: 'm-hl-4', user_id: 'u-hl-1', tier: 1, task_type: 'drafting', classifier_confidence: 0.9, classifier_model: 'test', classified_at: inWin },
      { cowork_message_id: 'm-hl-5', user_id: 'u-hl-1', tier: 3, task_type: 'workflow', classifier_confidence: 0.9, classifier_model: 'test', classified_at: inWin },
      { cowork_message_id: 'm-hl-6', user_id: 'u-hl-1', tier: 3, task_type: 'workflow', classifier_confidence: 0.9, classifier_model: 'test', classified_at: wkEnd + 3600 },
      { cowork_message_id: 'm-hl-7', user_id: 'u-hl-2', tier: 3, task_type: 'finance', classifier_confidence: 0.9, classifier_model: 'test', classified_at: inWin },
    ] as never);

    // Engineering mix — 2 work types inside the window, one session outside.
    await client.insert(schema.codeSessionStats).values([
      { session_id: 'cs-hl-1', user_id: 'u-hl-1', first_at: inWin, last_at: inWin, computed_at: inWin },
      { session_id: 'cs-hl-2', user_id: 'u-hl-2', first_at: inWin, last_at: inWin, computed_at: inWin },
      { session_id: 'cs-hl-3', user_id: 'u-hl-1', first_at: inWin, last_at: inWin, computed_at: inWin },
      { session_id: 'cs-hl-4', user_id: 'u-hl-1', first_at: wkEnd + 3600, last_at: wkEnd + 3600, computed_at: wkEnd + 3600 },
    ] as never);
    await client.insert(schema.codeSessionClassifications).values([
      { session_id: 'cs-hl-1', user_id: 'u-hl-1', work_type: 'feature', tier: 2, confidence: 0.9, classifier_model: 'test', classified_at: inWin },
      { session_id: 'cs-hl-2', user_id: 'u-hl-2', work_type: 'feature', tier: 2, confidence: 0.9, classifier_model: 'test', classified_at: inWin },
      { session_id: 'cs-hl-3', user_id: 'u-hl-1', work_type: 'bugfix', tier: 2, confidence: 0.9, classifier_model: 'test', classified_at: inWin },
      { session_id: 'cs-hl-4', user_id: 'u-hl-1', work_type: 'feature', tier: 2, confidence: 0.9, classifier_model: 'test', classified_at: wkEnd + 3600 },
    ] as never);

    // Code output — the COMPLETED week's own weekly row: lines
    // 500+200=700, hands-on (7200+3600)/3600=3h, kept=40, proposed=40+10=50.
    await client.insert(schema.codeMetrics).values({
      scope_type: 'organisation', scope_id: 'org', period_start: wkStart, period_end: wkEnd,
      granularity: 'week', computed_at: inWin,
      lines_added: 500, lines_removed: 200,
      active_time_user_s: 7200, active_time_cli_s: 3600,
      edit_accept_count: 40, edit_reject_count: 10,
    } as never);

    await client.insert(schema.coworkMcpInvocations).values([
      { id: 'mi-1', user_id: 'u-hl-1', session_id: 's-hl-1', mcp_server: 'salesforce', mcp_tool: 'query', occurred_at: inWin },
      { id: 'mi-2', user_id: 'u-hl-1', session_id: 's-hl-1', mcp_server: 'salesforce', mcp_tool: 'update', occurred_at: inWin },
      { id: 'mi-3', user_id: 'u-hl-2', session_id: 's-hl-2', mcp_server: 'slack', mcp_tool: 'post', occurred_at: inWin },
    ] as never);

    await client.insert(schema.coworkSkillInvocations).values([
      { id: 'si-1', user_id: 'u-hl-1', session_id: 's-hl-1', skill_name: 'docx', occurred_at: inWin },
      { id: 'si-2', user_id: 'u-hl-1', session_id: 's-hl-1', skill_name: 'pptx', occurred_at: inWin },
    ] as never);

    return { wkStart, wkEnd };
  }

  it('windows to the last completed week and excludes stripped/scheduled/tier<3/out-of-window rows', async () => {
    const { wkStart, wkEnd } = await seed();
    const { gatherHighlights } = await import('@/lib/highlights/gather');
    const input = await gatherHighlights({ nowS: NOW });
    expect(input.weekStart).toBe(wkStart);
    expect(input.weekEnd).toBe(wkEnd);
    expect(input.workItems.map(w => w.taskType).sort()).toEqual(['analysis', 'finance', 'workflow']); // m-hl-1 + m-hl-2 + m-hl-7 (NULL-preview, real content)
    expect(input.workItems[0].text.length).toBeGreaterThanOrEqual(input.workItems[1].text.length); // longest-first
    expect(input.headcount).toBe(2);
    expect(input.tier3Count).toBe(5); // ALL in-window tier-3 classifications (m-hl-1/2/3/5/7 — stripped and scheduled rows still COUNT in the tier mix, they just yield no work item)
    expect(input.systems.totalCalls).toBe(3);
    expect(input.systems.distinctSystems).toBe(2);
    expect(input.systems.top[0]).toEqual({ server: 'salesforce', calls: 2, people: 1 });
  });

  it('includes a row with NULL content_preview but real content_full in workItems (NULL-safe filters)', async () => {
    await seed();
    const { gatherHighlights } = await import('@/lib/highlights/gather');
    const input = await gatherHighlights({ nowS: NOW });
    const finance = input.workItems.find(w => w.taskType === 'finance');
    expect(finance).toBeDefined();
    expect(finance!.text).toContain('vendor invoice');
  });

  it('engineeringMix groups/counts by work_type and excludes sessions outside the window', async () => {
    await seed();
    const { gatherHighlights } = await import('@/lib/highlights/gather');
    const input = await gatherHighlights({ nowS: NOW });
    const byType = Object.fromEntries(input.engineeringMix.map(m => [m.workType, m.sessions]));
    expect(byType['New functionality']).toBe(2); // cs-hl-1 + cs-hl-2 (cs-hl-4 is out-of-window, excluded)
    expect(byType['Fixing defects']).toBe(1); // cs-hl-3
    expect(input.engineeringMix.reduce((s, m) => s + m.sessions, 0)).toBe(3);
  });

  it('codeOutput arithmetic from the completed week\'s weekly row, basis="week"', async () => {
    await seed();
    const { gatherHighlights } = await import('@/lib/highlights/gather');
    const input = await gatherHighlights({ nowS: NOW });
    expect(input.codeOutput).toEqual({
      linesChanged: 700,      // 500 + 200
      handsOnHours: 3,        // (7200 + 3600) / 3600
      changesKept: 40,
      changesProposed: 50,    // 40 + 10
      basis: 'week',
    });
  });

  it('falls back to the latest rolling row (basis="rolling") when no weekly row exists for the completed week', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();
    // No seed() call — insert only a rolling code_metrics row, no weekly row.
    await client.insert(schema.codeMetrics).values({
      scope_type: 'organisation', scope_id: 'org', period_start: 0, period_end: NOW,
      granularity: 'rolling', computed_at: NOW,
      lines_added: 100, lines_removed: 50,
      active_time_user_s: 1800, active_time_cli_s: 1800,
      edit_accept_count: 5, edit_reject_count: 5,
    } as never);
    const { gatherHighlights } = await import('@/lib/highlights/gather');
    const input = await gatherHighlights({ nowS: NOW });
    expect(input.codeOutput).toEqual({
      linesChanged: 150,
      handsOnHours: 1,
      changesKept: 5,
      changesProposed: 10,
      basis: 'rolling',
    });
  });

  it('strips identity from work-item text', async () => {
    await seed();
    const { gatherHighlights } = await import('@/lib/highlights/gather');
    const input = await gatherHighlights({ nowS: NOW });
    const all = input.workItems.map(w => w.text).join(' ');
    expect(all).not.toContain('C:\\Users');
    expect(all).not.toContain('https://internal.corp');
    expect(all).not.toContain('jane');
  });

  it('shoutouts are null by default and populated with includeNames', async () => {
    await seed();
    const { gatherHighlights } = await import('@/lib/highlights/gather');
    expect((await gatherHighlights({ nowS: NOW })).shoutouts).toBeNull();
    const named = await gatherHighlights({ nowS: NOW, includeNames: true });
    expect(named.shoutouts?.systems?.person).toBe('Person One');
    expect(named.shoutouts?.systems?.count).toBe(2);
    expect(named.shoutouts?.skills?.person).toBe('Person One');
    expect(named.shoutouts?.skills?.distinct).toBe(2);
  });

  it('returns empty workItems on an empty week (the D1 refusal signal)', async () => {
    const { gatherHighlights } = await import('@/lib/highlights/gather');
    const input = await gatherHighlights({ nowS: NOW });
    expect(input.workItems).toEqual([]);
    expect(input.headcount).toBe(0);
    expect(input.codeOutput).toBeNull();
  });
});

describe('stripIdentity', () => {
  it('replaces URLs and file paths, keeps the surrounding prose', async () => {
    const { stripIdentity } = await import('@/lib/highlights/gather');
    const out = stripIdentity('Read C:\\Users\\alex\\q.docx and /home/alex/notes/plan.md then check https://x.corp/a?b=1 please');
    expect(out).not.toMatch(/C:\\|\/home\/alex|https:\/\//);
    expect(out).toContain('Read');
    expect(out).toContain('please');
  });
});
