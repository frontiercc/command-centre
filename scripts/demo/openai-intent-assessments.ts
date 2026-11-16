// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Sample data: written assessments for the intent alerts the OpenAI sync
// raises on the sample's ChatGPT and Codex prompts (scripts/openai-mock/data.mjs).
// The sample is usually loaded before a Claude API key is added, so the Hub
// stores its no-key fallback ("AI assessment unavailable...") on those alerts,
// which looks broken in a demo. The Claude sample's intent alerts carry written
// assessments (04-alerts.cjs); this gives the ChatGPT and Codex ones the same,
// in the shape lib/alerts/intent-alerts.ts writes.
//
// Only alerts holding a fallback are changed: an assessment the model wrote,
// when a key was configured during the load, is kept. Real alerts are never
// touched: only intent alerts on the sample people's ChatGPT and Codex prompts.
// Run by 11-chatgpt-codex.ts.
import { sql } from 'drizzle-orm';
import { getTypedClient } from '../../lib/db/client';

type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface SampleIntentAssessment {
  severity: Severity;
  reasoning: string;
  recommended_action: string;
}

/**
 * One per intent category the sample's ChatGPT and Codex prompts match: a
 * customer export to a personal Gmail or Dropbox (Shadow IT), admin passwords
 * without IT knowing (Reconnaissance) and logging switched off (Policy Evasion).
 * Like the Hub's own, the reasoning describes the request without quoting it.
 */
export const SAMPLE_INTENT_ASSESSMENTS: Readonly<Record<string, SampleIntentAssessment>> = {
  shadow_it: {
    severity: 'high',
    reasoning: 'The person asks to move customer data to a personal email or cloud storage account, outside the tools the organisation approves.',
    recommended_action: 'Review with their manager and security today, and confirm no customer data has left approved systems.',
  },
  reconnaissance: {
    severity: 'high',
    reasoning: 'The person asks how to get administrator passwords for the finance system without IT knowing, which suggests gathering access they do not hold.',
    recommended_action: 'Review with their manager and security today, and check recent access to the finance system.',
  },
  policy_evasion: {
    severity: 'critical',
    reasoning: 'The person asks to switch off logging on the payments service so the work is not seen, which would remove the audit trail for payments.',
    recommended_action: 'Contact security now and confirm logging is still on for the payments service.',
  },
};

/**
 * The reasoning lib/intent/assess.ts stores when no model assessed the prompt:
 * no API key, or the call failed. test/demo-openai-intent-assessments-pg.test.ts
 * checks these still match what assessIntent returns.
 */
export const FALLBACK_REASONINGS: readonly string[] = [
  'AI assessment unavailable: no API key configured. Severity based on category default.',
  'Manual review recommended: AI assessment could not be completed.',
];

const RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

type Raw = { execute: (q: unknown) => Promise<{ rows: Array<Record<string, unknown>> }> };

/** The sample people's ChatGPT and Codex prompts, as 11-chatgpt-codex.ts clears them. */
const samplePrompts = sql`(SELECT id FROM cowork_messages
  WHERE source IN ('chatgpt_chat', 'chatgpt_work', 'codex')
    AND user_id IN (SELECT id FROM users WHERE email LIKE '%@acmecorp.example'))`;

/**
 * Replaces the fallback assessment on the sample's ChatGPT and Codex intent
 * alerts with a written one. The sync raises its alerts without waiting, so
 * this first waits (up to `waitMs`) until every flagged sample prompt has been
 * given its severity, which the Hub does once that prompt's alerts are stored.
 */
export async function writeSampleIntentAssessments(opts: { waitMs?: number } = {}): Promise<{ written: number; kept: number; unfinished: number }> {
  const raw = (await getTypedClient()) as unknown as Raw;
  const deadline = Date.now() + (opts.waitMs ?? 60_000);
  let unfinished = 0;
  for (;;) {
    unfinished = Number((await raw.execute(sql`
      SELECT COUNT(*) AS n FROM cowork_messages
       WHERE id IN ${samplePrompts} AND flag_reason LIKE '%Intent detected:%'
         AND flag_reason !~ '\\((low|medium|high|critical)\\)$'`)).rows[0]?.n ?? 0);
    if (unfinished === 0 || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const alerts = (await raw.execute(sql`
    SELECT id, raw_evidence->>'message_id' AS message_id, raw_evidence->>'intent_category' AS category,
           raw_evidence->'ai_assessment'->>'reasoning' AS reasoning
      FROM alerts
     WHERE alert_type = 'intent' AND raw_evidence->>'message_id' IN ${samplePrompts}`)).rows;

  let written = 0;
  let kept = 0;
  // The highest severity written for each prompt, for its flag reason.
  const promptSeverity = new Map<string, Severity>();
  for (const a of alerts) {
    const assessment = SAMPLE_INTENT_ASSESSMENTS[String(a.category)];
    if (!assessment || !FALLBACK_REASONINGS.includes(String(a.reasoning))) { kept++; continue; }
    await raw.execute(sql`
      UPDATE alerts
         SET severity = ${assessment.severity},
             explanation = ${assessment.reasoning},
             raw_evidence = jsonb_set(raw_evidence, '{ai_assessment}', ${JSON.stringify(assessment)}::jsonb)
       WHERE id = ${String(a.id)}`);
    written++;
    const id = String(a.message_id);
    const before = promptSeverity.get(id);
    if (!before || RANK[assessment.severity] > RANK[before]) promptSeverity.set(id, assessment.severity);
  }
  // The Hub ends a flagged prompt's reason with the assessed severity, "(high)"; keep it in step.
  for (const [id, severity] of promptSeverity) {
    await raw.execute(sql`
      UPDATE cowork_messages
         SET flag_reason = regexp_replace(flag_reason, '\\((low|medium|high|critical)\\)$', ${`(${severity})`})
       WHERE id = ${id}`);
  }
  return { written, kept, unfinished };
}
