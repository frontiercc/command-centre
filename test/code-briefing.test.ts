// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * generateCodeBriefing / getLatestCodeBriefing (lib/pulse/code/briefing.ts).
 * Uses a real, fully-migrated Postgres test DB via createTestDatabase so the analytic reads in buildDataSummary() are
 * exercised against actual SQL. Only the Anthropic SDK is mocked, following
 * the pattern in test/code-pulse-classifier-job.test.ts.
 */
import { BRIEFING_DEFAULT_MODEL } from '@/lib/anthropic/constants';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';

vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: mockCreate },
    })),
    __mockCreate: mockCreate,
  };
});

async function getMockCreate() {
  const mod = await import('@anthropic-ai/sdk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod as any).__mockCreate as ReturnType<typeof vi.fn>;
}

function mockBriefingResponse(paragraphs: string[], suggestion?: string) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ paragraphs, suggestion }) }],
  };
}

let sql: TestSql;
let cleanup: () => Promise<void>;
let generateCodeBriefing: typeof import('@/lib/pulse/code/briefing').generateCodeBriefing;
let getLatestCodeBriefing: typeof import('@/lib/pulse/code/briefing').getLatestCodeBriefing;
let CODE_BRIEFING_SCOPE_ID: typeof import('@/lib/pulse/code/briefing').CODE_BRIEFING_SCOPE_ID;
let setConfigValue: typeof import('@/lib/config').setConfigValue;

const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const briefing = await import('@/lib/pulse/code/briefing');
  generateCodeBriefing = briefing.generateCodeBriefing;
  getLatestCodeBriefing = briefing.getLatestCodeBriefing;
  CODE_BRIEFING_SCOPE_ID = briefing.CODE_BRIEFING_SCOPE_ID;

  const config = await import('@/lib/config');
  setConfigValue = config.setConfigValue;

  await seedUserSql(sql, 'user-1');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM pulse_briefings;
           DELETE FROM code_metrics;
           DELETE FROM github_repo_stats;
           DELETE FROM code_session_classifications;
           DELETE FROM code_session_stats;
           DELETE FROM config WHERE key IN ('anthropic_ai_api_key', 'pulse_briefing_model', 'code_classifier_enabled');`);
});

async function seedOrgRollingMetric(overrides: Partial<{
  spend_usd: number | null; session_count: number; repo_count: number; commit_count: number;
  autonomy_ratio: number | null; cache_hit_ratio: number | null;
}> = {}) {
  await sql.run(
    `INSERT INTO code_metrics (
       scope_type, scope_id, period_start, period_end, spend_usd,
       session_count, repo_count, commit_count, autonomy_ratio, cache_hit_ratio,
       input_tokens, output_tokens, granularity, computed_at
     ) VALUES ('organisation', 'org', ?, ?, ?, ?, ?, ?, ?, ?, 1000, 500, 'rolling', ?)`,
    [
    NOW - 7 * 24 * 3600, NOW,
    overrides.spend_usd ?? 12.5,
    overrides.session_count ?? 4,
    overrides.repo_count ?? 2,
    overrides.commit_count ?? 6,
    overrides.autonomy_ratio ?? 1.5,
    overrides.cache_hit_ratio ?? 0.4,
    NOW,
    ],
  );
}

describe('generateCodeBriefing / getLatestCodeBriefing round-trip', () => {
  it('generates a briefing from telemetry, stores it, and reads it back verbatim', async () => {
    await seedOrgRollingMetric();
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');

    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(mockBriefingResponse(
      ['Paragraph one about cost and scale.', 'Paragraph two about delegation.', 'Paragraph three about shipping.'],
      'Investigate the highest-friction repo.',
    ));

    const generated = await generateCodeBriefing();
    expect(generated.body).toContain('Paragraph one about cost and scale.');
    expect(generated.suggestion).toBe('Investigate the highest-friction repo.');
    expect(generated.model).toBe(BRIEFING_DEFAULT_MODEL);

    const latest = await getLatestCodeBriefing();
    expect(latest).not.toBeNull();
    expect(latest!.body).toBe(generated.body);
    expect(latest!.suggestion).toBe(generated.suggestion);
    expect(latest!.model).toBe(generated.model);
    expect(latest!.generated_at).toBe(generated.generated_at);

    // Stored under the dedicated Developer Pulse briefing scope — never collides
    // with Cowork briefing scopes in the shared pulse_briefings table.
    const row = (await sql.get(
      `SELECT scope_type, scope_id FROM pulse_briefings ORDER BY generated_at DESC LIMIT 1`
    )) as { scope_type: string; scope_id: string };
    expect(row.scope_type).toBe('organisation');
    expect(row.scope_id).toBe(CODE_BRIEFING_SCOPE_ID);
  });

  it('returns null when no briefing has been generated yet', async () => {
    expect(await getLatestCodeBriefing()).toBeNull();
  });

  it('throws when no AI API key is configured', async () => {
    await seedOrgRollingMetric();
    await expect(generateCodeBriefing()).rejects.toThrow('No AI API key configured');
  });

  it('throws when there is no Developer Pulse metrics data yet', async () => {
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');
    await expect(generateCodeBriefing()).rejects.toThrow('No Developer Pulse metrics yet');
  });

  it('includes the GitHub overlay and Number()-coerces the SUM(commit_count) aggregate correctly', async () => {
    await seedOrgRollingMetric();
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');
    const today = new Date().toISOString().slice(0, 10);
    await sql.run(
      `INSERT INTO github_repo_stats (repo, date, commit_count, prs_merged, synced_at) VALUES ('my-app', ?, 9, 1, ?)`,
      [today, NOW],
    );

    const mockCreate = await getMockCreate();
    mockCreate.mockImplementation(async (opts: { messages: Array<{ content: string }> }) => {
      const summary = opts.messages[0].content;
      expect(summary).toContain('github_overlay: total_commits_shipped_in_mapped_repos=9');
      return mockBriefingResponse(['p1', 'p2', 'p3'], 'do something');
    });

    await generateCodeBriefing();
    expect(mockCreate).toHaveBeenCalled();
  });
});

describe('number check', () => {
  async function seedWeekWithHistory() {
    await seedOrgRollingMetric(); // this week: spend 12.5, sessions 4, commits 6
    await sql.run(
      `INSERT INTO code_metrics (scope_type, scope_id, period_start, period_end, spend_usd, session_count, repo_count, commit_count,
         autonomy_ratio, cache_hit_ratio, input_tokens, output_tokens, granularity, computed_at)
       VALUES ('organisation', 'org', ?, ?, 10, 2, 2, 3, 1.5, 0.4, 1000, 500, 'rolling', ?)`,
      [NOW - 15 * 24 * 3600, NOW - 8 * 24 * 3600, NOW - 8 * 24 * 3600],
    );
    const today = new Date().toISOString().slice(0, 10);
    await sql.run(`INSERT INTO github_repo_stats (repo, date, commit_count, prs_merged, synced_at) VALUES ('my-app', ?, 9, 1, ?)`, [today, NOW]);
    // Work mix: 3 feature + 1 bugfix = 4 classified sessions this week.
    const mix = [['s1', 'feature'], ['s2', 'feature'], ['s3', 'feature'], ['s4', 'bugfix']];
    for (const [id, wt] of mix) {
      await sql.run(`INSERT INTO code_session_stats (session_id, first_at, last_at, computed_at) VALUES (?, ?, ?, ?)`, [id, NOW - 3600, NOW - 60, NOW]);
      await sql.run(`INSERT INTO code_session_classifications (session_id, work_type, tier, confidence, classifier_model, classified_at) VALUES (?, ?, 2, 0.9, 'haiku', ?)`, [id, wt, NOW]);
    }
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');
  }

  it('works out changes, the AI-assisted share and the work-mix total in code', async () => {
    await seedWeekWithHistory();
    const mockCreate = await getMockCreate();
    let prompt = '';
    mockCreate.mockImplementation(async (opts: { messages: Array<{ content: string }> }) => {
      prompt = opts.messages[0].content;
      return mockBriefingResponse(['Spend rose 25% on 4 sessions.', 'Of 4 classified sessions, 3 were features (75%).', '67% of shipped commits were AI-assisted.'], 'Keep it up.');
    });
    const r = await generateCodeBriefing();
    expect(prompt).toContain('change_vs_prior_week: spend +25%, sessions +100%, commits +100%');
    expect(prompt).toContain('ai_assisted_share_of_shipped_commits=67%');
    expect(prompt).toContain('(4 classified sessions in total, 2 kinds of work): "New functionality"=3 (75%), "Fixing defects"=1 (25%)');
    expect(r.body).toContain('67% of shipped commits');
  });

  it('a reply that is mostly invented figures is retried and given a fresh cycle, then refused; last week stays', async () => {
    await seedWeekWithHistory();
    await sql.run(
      `INSERT INTO pulse_briefings (scope_type, scope_id, period_start, period_end, body, suggestion, model, generated_at)
       VALUES ('organisation', ?, ?, ?, 'Last week body.', null, 'm', ?)`,
      [CODE_BRIEFING_SCOPE_ID, NOW - 14 * 86400, NOW - 7 * 86400, NOW - 7 * 86400],
    );
    const mockCreate = await getMockCreate();
    mockCreate.mockReset();
    // "28%" and "135" appear nowhere in the data (the 6 September failure).
    mockCreate.mockResolvedValue(mockBriefingResponse(['28% of commits were AI-assisted.', 'Across 135 sessions.', 'p3'], 's'));
    const { GroundingRejectedError } = await import('@/lib/anthropic/grounded-json');
    await expect(generateCodeBriefing()).rejects.toBeInstanceOf(GroundingRejectedError);
    // Two cycles (reply + retry each): a refusal gets one fresh cycle first.
    expect(mockCreate).toHaveBeenCalledTimes(4);
    expect((await getLatestCodeBriefing())?.body).toBe('Last week body.');
  });
});
