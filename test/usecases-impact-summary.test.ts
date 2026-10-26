// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from './helpers/db';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { redactPii } from '@/lib/pii/detect';
import { generateImpactSummary, saveImpactSummary } from '@/lib/usecases/impact-summary';
import type { UseCaseImpact } from '@/lib/usecases/impact';

let cleanup: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  cleanup = testDb.cleanup;
});

afterAll(async () => cleanup());

/**
 * A minimal but representative UseCaseImpact fixture: one measured week
 * (session=2, 1hr duration, 0.5hr engaged, 3 accepted/0 rejected edits, 1
 * flagged), the remaining 12 window weeks absent (all-null), matching
 * buildUseCaseImpact's own absent-week convention.
 */
function makeImpact(overrides?: Partial<UseCaseImpact>): UseCaseImpact {
  const absentWeeks = Array.from({ length: 12 }, (_, i) => ({
    weekStart: 2000 + i, sessions: null, durationSecs: null, engagedSecs: null,
    toolErrors: null, coworkToolErrors: null, editRejects: null, editAccepts: null, flagged: null,
  }));

  return {
    windowWeeks: 13,
    weeks: [
      {
        weekStart: 1000, sessions: 2, durationSecs: 3600, engagedSecs: 1800,
        toolErrors: 1, coworkToolErrors: null, editRejects: 0, editAccepts: 3, flagged: 1,
      },
      ...absentWeeks,
    ],
    totals: { durationSecs: 3600, engagedSecs: 1800, sessions: 2, estimateHours: 1, coworkDurationSecs: 2400, codeDurationSecs: 1200 },
    participation: {
      skills: [{ name: 'docx', sessions: 2 }],
      connectors: [{ name: 'salesforce', sessions: 1 }],
      models: [{ name: 'claude-opus-4-6', sessions: 2 }],
      surfaces: { cowork: 1, code: 1 },
      cappedAt: null,
    },
    depth: { weeks: [], rubricChangesAt: [] },
    ...overrides,
  };
}

describe('generateImpactSummary', () => {
  it('grounded happy path: only allowed numbers -> returns text, redactPii-idempotent', async () => {
    const impact = makeImpact();
    // Friction figures are no longer facts (the "Where it hurts"
    // block was removed, and the summary must not narrate friction either).
    const reply =
      'This use case logged 2 sessions across 1 measured week, totalling 1.0 hours of ' +
      'session time.';

    const result = await generateImpactSummary('uc-1', 'Board-Pack Prep', impact, {
      callModel: async () => reply,
    });

    expect(result.text).toBe(reply);
    // the text round-trips redactPii unchanged (no PII present)
    expect(redactPii(result.text!)).toBe(result.text);
  });

  it('engaged time is no longer a fact (2026-09-05, ImpactPanel dropped the tile): mentioning an engaged-hours figure not derivable from any remaining fact is rejected', async () => {
    // 7.4 is chosen to avoid colliding, even via numberVariants' round-to-nearest
    // form, with any of the fixture's other allowed numbers (weeksMeasured=1,
    // totalSessions=2, totalDurationHours=1, estimateHours=1) — Math.round(7.4) = 7.
    const impact = makeImpact(); // sole week's engagedSecs=1800 (0.5h) — no longer surfaced to the model
    const reply = 'This use case logged 2 sessions, with 7.4 hours of engaged time.';

    const result = await generateImpactSummary('uc-1', 'Board-Pack Prep', impact, {
      callModel: async () => reply,
    });

    expect(result.text).toBeNull();
  });

  it('invented number: a number not derivable from the facts -> null', async () => {
    const impact = makeImpact();
    const reply = 'This workflow appears to save around 999 hours annually.';

    const result = await generateImpactSummary('uc-1', 'Board-Pack Prep', impact, {
      callModel: async () => reply,
    });

    expect(result.text).toBeNull();
  });

  it('digit-bearing string fact (topModel): naming it is grounded, not rejected as an invented number', async () => {
    const impact = makeImpact({
      participation: {
        skills: [{ name: 'docx', sessions: 2 }],
        connectors: [{ name: 'salesforce', sessions: 1 }],
        models: [{ name: 'claude-haiku-4-5', sessions: 2 }],
        surfaces: { cowork: 1, code: 1 },
        cappedAt: null,
      },
    });
    const reply = 'The team leans on claude-haiku-4-5 for this workflow.';

    const result = await generateImpactSummary('uc-1', 'Board-Pack Prep', impact, {
      callModel: async () => reply,
    });

    expect(result.text).toBe(reply);
  });

  it('digit-bearing string fact must not leak its exploded digits into the allowed set: a bare re-used digit is still rejected', async () => {
    // topModel 'claude-haiku-4-5' embeds digits 4 and 5; none of the numeric
    // facts here (sessions=2, weeksMeasured=1, durationHours=1.0,
    // estimateHours=1) produces a bare "5" allowed-number variant. A reply
    // that invents "5 hours" out of context must be rejected, not waved
    // through because '5' happens to appear inside the model name string.
    const impact = makeImpact({
      participation: {
        skills: [{ name: 'docx', sessions: 2 }],
        connectors: [{ name: 'salesforce', sessions: 1 }],
        models: [{ name: 'claude-haiku-4-5', sessions: 2 }],
        surfaces: { cowork: 1, code: 1 },
        cappedAt: null,
      },
    });
    const reply = 'This workflow saved 5 hours.';

    const result = await generateImpactSummary('uc-1', 'Board-Pack Prep', impact, {
      callModel: async () => reply,
    });

    expect(result.text).toBeNull();
  });

  it('digit-bearing string fact does not widen grounding: a genuinely invented number alongside it still rejects', async () => {
    const impact = makeImpact({
      participation: {
        skills: [{ name: 'docx', sessions: 2 }],
        connectors: [{ name: 'salesforce', sessions: 1 }],
        models: [{ name: 'claude-haiku-4-5', sessions: 2 }],
        surfaces: { cowork: 1, code: 1 },
        cappedAt: null,
      },
    });
    const reply = 'The team leans on claude-haiku-4-5, saving 999 hours annually.';

    const result = await generateImpactSummary('uc-1', 'Board-Pack Prep', impact, {
      callModel: async () => reply,
    });

    expect(result.text).toBeNull();
  });

  it('humanised model-name variant (spaces, capitalised) is grounded, not rejected as an invented number', async () => {
    // topModel 'claude-sonnet-5' — the model naturally writes "Claude Sonnet 5"
    // (spaces instead of hyphens, title case). The separator-flexible strip
    // must recognise this as the same fact string, not leave a bare "5" behind.
    const impact = makeImpact({
      participation: {
        skills: [{ name: 'docx', sessions: 2 }],
        connectors: [{ name: 'salesforce', sessions: 1 }],
        models: [{ name: 'claude-sonnet-5', sessions: 2 }],
        surfaces: { cowork: 1, code: 1 },
        cappedAt: null,
      },
    });
    const reply = 'This use case logged 2 sessions, powered by Claude Sonnet 5.';

    const result = await generateImpactSummary('uc-1', 'Board-Pack Prep', impact, {
      callModel: async () => reply,
    });

    expect(result.text).toBe(reply);
  });

  it('humanised model-name variant does not widen grounding: an unrelated bare digit is still rejected', async () => {
    const impact = makeImpact({
      participation: {
        skills: [{ name: 'docx', sessions: 2 }],
        connectors: [{ name: 'salesforce', sessions: 1 }],
        models: [{ name: 'claude-sonnet-5', sessions: 2 }],
        surfaces: { cowork: 1, code: 1 },
        cappedAt: null,
      },
    });
    const reply = 'This workflow saved 5 hours.';

    const result = await generateImpactSummary('uc-1', 'Board-Pack Prep', impact, {
      callModel: async () => reply,
    });

    expect(result.text).toBeNull();
  });

  it('PII scrub: a grounded reply containing a valid CPF comes back masked', async () => {
    // 11144477735 is a valid CPF (mod-11 check digits 3, 5) — set as the
    // session total so it's a genuine allowed fact number (friction counts are
    // no longer facts), keeping the reply fully grounded while still
    // exercising the PII masking path.
    const impact = makeImpact({
      weeks: [
        {
          weekStart: 1000, sessions: 11144477735, durationSecs: null, engagedSecs: null,
          toolErrors: null, coworkToolErrors: null, editRejects: null, editAccepts: null, flagged: null,
        },
        ...Array.from({ length: 12 }, (_, i) => ({
          weekStart: 2000 + i, sessions: null, durationSecs: null, engagedSecs: null,
          toolErrors: null, coworkToolErrors: null, editRejects: null, editAccepts: null, flagged: null,
        })),
      ],
      totals: { durationSecs: null, engagedSecs: null, sessions: 11144477735, estimateHours: null, coworkDurationSecs: null, codeDurationSecs: null },
    });
    const reply = 'Contact 11144477735 for details.';

    const result = await generateImpactSummary('uc-1', 'Board-Pack Prep', impact, {
      callModel: async () => reply,
    });

    expect(result.text).not.toBeNull();
    expect(result.text).not.toContain('11144477735');
    expect(result.text).toContain('***.***.***-35');
  });

  it('never throws: a callModel rejection resolves to { text: null }', async () => {
    const impact = makeImpact();
    const result = await generateImpactSummary('uc-1', 'Board-Pack Prep', impact, {
      callModel: async () => { throw new Error('boom'); },
    });
    expect(result.text).toBeNull();
  });
});

describe('saveImpactSummary', () => {
  it('writes both impact_summary and impact_summary_at, verified via direct select', async () => {
    const client = await getTypedClient();
    await client.insert(schema.useCases).values({ id: 'uc-save-1', title: 'Save Test UC' } as never).onConflictDoNothing();

    await saveImpactSummary('uc-save-1', 'A grounded summary.', 1234567);

    const rows = await client.select().from(schema.useCases).where(eq(schema.useCases.id, 'uc-save-1'));
    expect(rows[0].impact_summary).toBe('A grounded summary.');
    expect(Number(rows[0].impact_summary_at)).toBe(1234567);
  });
});
