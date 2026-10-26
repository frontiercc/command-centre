// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Which model each briefing uses, and that /admin/pulse's config read shows
// the same thing. Organisation briefings: pulse_briefing_model,
// else BRIEFING_DEFAULT_MODEL. Personal weekly briefings:
// pulse_user_briefing_model, else whatever the Core AI model is set to — read
// live, never a fixed model. The page used to show claude-opus-4-5-20251001
// (not a valid model ID) while every job silently used Haiku.
import { BRIEFING_DEFAULT_MODEL, CLAUDE_MODEL } from '@/lib/anthropic/constants';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ sql, cleanup } = await createTestDatabase());
});
afterAll(async () => cleanup());
beforeEach(async () => {
  await sql.run(
    "DELETE FROM config WHERE key IN ('pulse_briefing_model', 'pulse_user_briefing_model', 'core_ai_model')",
  );
});

async function setRow(key: string, value: string) {
  await sql.run(
    'INSERT INTO config (key, value, updated_at) VALUES (?, ?, 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

describe('organisation briefing model', () => {
  it('defaults to BRIEFING_DEFAULT_MODEL, and the admin page shows the same', async () => {
    const { getOrgBriefingModel } = await import('@/lib/anthropic/model');
    const { getAllConfig } = await import('@/lib/config');
    expect(await getOrgBriefingModel()).toBe(BRIEFING_DEFAULT_MODEL);
    expect((await getAllConfig()).pulseBriefingModel).toBe(BRIEFING_DEFAULT_MODEL);
  });

  it('a saved choice wins for both', async () => {
    await setRow('pulse_briefing_model', 'claude-opus-5');
    const { getOrgBriefingModel } = await import('@/lib/anthropic/model');
    const { getAllConfig } = await import('@/lib/config');
    expect(await getOrgBriefingModel()).toBe('claude-opus-5');
    expect((await getAllConfig()).pulseBriefingModel).toBe('claude-opus-5');
  });
});

describe('personal briefing model', () => {
  it('follows the Core AI default when neither is saved; the page reads blank (= follow) plus the Core AI model', async () => {
    const { getUserBriefingModel } = await import('@/lib/anthropic/model');
    const { getAllConfig } = await import('@/lib/config');
    expect(await getUserBriefingModel()).toBe(CLAUDE_MODEL);
    const cfg = await getAllConfig();
    expect(cfg.pulseUserBriefingModel).toBe('');
    expect(cfg.coreAiModel).toBe(CLAUDE_MODEL);
  });

  it('follows whatever the Core AI model is changed to — not a fixed model', async () => {
    await setRow('core_ai_model', 'claude-sonnet-5');
    const { getUserBriefingModel } = await import('@/lib/anthropic/model');
    expect(await getUserBriefingModel()).toBe('claude-sonnet-5');
  });

  it('a saved personal model wins over Core AI', async () => {
    await setRow('core_ai_model', 'claude-sonnet-5');
    await setRow('pulse_user_briefing_model', 'claude-haiku-4-5');
    const { getUserBriefingModel } = await import('@/lib/anthropic/model');
    expect(await getUserBriefingModel()).toBe('claude-haiku-4-5');
  });

  it('never borrows the organisation model', async () => {
    await setRow('pulse_briefing_model', 'claude-opus-5');
    const { getUserBriefingModel } = await import('@/lib/anthropic/model');
    expect(await getUserBriefingModel()).toBe(CLAUDE_MODEL);
  });
});
