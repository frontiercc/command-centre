// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Deterministic Developer Pulse section for the governance report.
//
// Reads the latest ROLLING org-scope `code_metrics` row — the same row the
// /pulse/code overview reads — rather than recomputing anything. Once Codex
// data exists it reads Claude Code's and Codex's own rows instead
// (code_metrics_vendor, lib/pulse/code/vendor-view.ts), as the page does, and
// shows them as two tables: the combined row mixes signals Codex never sends.
// Any new query against code_metrics must filter `granularity` explicitly
// ('rolling' for snapshots, 'week' for history); an unfiltered read silently
// mixes the two.
//
// MEASURED vs JUDGED: everything under "Measured" comes from telemetry. The
// work mix and session tiers come from the Haiku session classifier and are
// labelled as judged in the output — the dashboards carry that distinction in
// colour, and prose has to carry it in words.
import { getCodeWorkTypeLabeller } from '@/lib/pulse/code/tier-config';
import { visibleOpenAi } from '@/lib/sources/openai-visibility';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { ORG_SCOPE_ID } from '@/lib/pulse/code/aggregator';
import { computeEngagedHours } from '@/lib/pulse/code/framework';
import { hasCodexData, readCodeMetrics, codeSessionVendor } from '@/lib/pulse/code/vendor-view';
import type { Vendor } from '@/lib/dashboard/vendor';

export interface CodePulseFacts {
  hasData: boolean;
  spendUsd: number | null;
  engagedHours: number | null;
  linesAdded: number;
  linesRemoved: number;
  commitCount: number;
  prCount: number;
  editAccept: number;
  editReject: number;
  autonomyRatio: number | null;
  cacheHitRatio: number | null;
  sessionCount: number;
  repoCount: number;
  skillLeverage: number | null;
  frictionIndex: number | null;
  workMix: Array<{ workType: string; count: number }>;
  tierMix: Array<{ tier: number; count: number }>;
}

function num(n: number | null, digits = 2): string {
  return n === null ? 'not measured' : n.toFixed(digits);
}

function pct(ratio: number | null): string {
  return ratio === null ? 'not measured' : `${Math.round(ratio * 100)}%`;
}

function int(n: number): string {
  return n.toLocaleString('en-GB');
}

function usd(n: number | null): string {
  return n === null ? 'not measured' : `$${n.toFixed(2)}`;
}

/**
 * Coerce a nullable numeric column. Postgres returns `real`/`numeric` as a
 * string, so every real() column read here goes
 * through this rather than being trusted to already be a number.
 */
export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Ratio guarded against a zero denominator — null, never a fabricated 0%. */
export function safeRatio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** Per-unit cost guarded the same way. */
export function perUnit(total: number | null, units: number): number | null {
  if (total === null || units <= 0) return null;
  return total / units;
}

/** One product's measured table. Codex sends no engaged time, lines, pull requests or edit decisions. */
function measuredTable(f: CodePulseFacts, codex: boolean): string {
  const acceptance = safeRatio(f.editAccept, f.editAccept + f.editReject);
  const claudeOnly = 'not captured (Claude Code telemetry only)';
  return `| Signal | Value |
|---|---|
| Engaged time | ${codex ? claudeOnly : f.engagedHours === null ? 'not measured' : `${f.engagedHours.toFixed(1)} hours`} |
| Lines added / removed | ${codex ? claudeOnly : `${int(f.linesAdded)} / ${int(f.linesRemoved)}`} |
| Commits | ${int(f.commitCount)} |
| Pull requests | ${codex ? claudeOnly : int(f.prCount)} |
| Edit acceptance | ${codex ? claudeOnly : `${pct(acceptance)} (${int(f.editAccept)} accepted, ${int(f.editReject)} rejected)`} |
| Sessions | ${int(f.sessionCount)} |
| Repositories touched | ${int(f.repoCount)} |
| Spend | ${usd(f.spendUsd)}${codex && f.spendUsd !== null ? " (at OpenAI's USD token rates)" : ''} |
| Cost per pull request | ${codex ? claudeOnly : usd(perUnit(f.spendUsd, f.prCount))} |
| Cost per commit | ${usd(perUnit(f.spendUsd, f.commitCount))} |
| Autonomy ratio | ${num(f.autonomyRatio)} |
| Cache hit ratio | ${pct(f.cacheHitRatio)} |
| Skill leverage | ${num(f.skillLeverage)} |
| Friction index | ${num(f.frictionIndex)} |`;
}

function judgedText(f: CodePulseFacts): string {
  return f.workMix.length === 0 && f.tierMix.length === 0
    ? 'No sessions have been classified yet, so no work mix is available.'
    : `${f.workMix.length > 0
        ? `Work mix: ${f.workMix.map(w => `${w.workType} (${int(w.count)})`).join('; ')}.`
        : ''}${f.workMix.length > 0 && f.tierMix.length > 0 ? '\n\n' : ''}${f.tierMix.length > 0
        ? `Delegation depth by session: ${f.tierMix.map(t => `tier ${t.tier} (${int(t.count)})`).join(', ')}.`
        : ''}`;
}

/**
 * With Codex connected: Claude Code and Codex as separate tables and work
 * mixes. `codex` null (no Codex data) renders the single Claude Code section.
 */
export function renderCodePulseSection(f: CodePulseFacts, codex: CodePulseFacts | null = null): string {
  if (codex) {
    const part = (name: string, facts: CodePulseFacts, isCodex: boolean) => facts.hasData
      ? `### ${name} (measured)\n\n${measuredTable(facts, isCodex)}\n\n### ${name} work mix (AI-judged)\n\n${judgedText(facts)}`
      : `### ${name}\n\nNo ${name} metrics have been computed yet.`;
    return `## Developer Pulse

Claude Code and Codex are shown separately: Codex's figures come from OpenAI's compliance export and carry no engaged time, lines of code, pull requests or edit decisions.

${part('Claude Code', f, false)}

${part('Codex', codex, true)}

Values shown as "not measured" have no underlying data for this window; they are not zero. The work mix is produced by a language model classifying completed sessions, not measured from telemetry. Treat it as an indication of the shape of the work, not as counts of record.`;
  }
  if (!f.hasData) {
    return `## Developer Pulse

No Developer Pulse metrics have been computed yet. This means either no Claude Code telemetry has arrived, or the hourly aggregator has not yet run against it.`;
  }

  const acceptance = safeRatio(f.editAccept, f.editAccept + f.editReject);

  const judged = f.workMix.length === 0 && f.tierMix.length === 0
    ? 'No sessions have been classified yet, so no work mix is available.'
    : `${f.workMix.length > 0
        ? `Work mix: ${f.workMix.map(w => `${w.workType} (${int(w.count)})`).join('; ')}.`
        : ''}${f.workMix.length > 0 && f.tierMix.length > 0 ? '\n\n' : ''}${f.tierMix.length > 0
        ? `Delegation depth by session: ${f.tierMix.map(t => `tier ${t.tier} (${int(t.count)})`).join(', ')}.`
        : ''}`;

  return `## Developer Pulse

### Measured

| Signal | Value |
|---|---|
| Engaged time | ${f.engagedHours === null ? 'not measured' : `${f.engagedHours.toFixed(1)} hours`} |
| Lines added / removed | ${int(f.linesAdded)} / ${int(f.linesRemoved)} |
| Commits | ${int(f.commitCount)} |
| Pull requests | ${int(f.prCount)} |
| Edit acceptance | ${pct(acceptance)} (${int(f.editAccept)} accepted, ${int(f.editReject)} rejected) |
| Sessions | ${int(f.sessionCount)} |
| Repositories touched | ${int(f.repoCount)} |
| Spend | ${usd(f.spendUsd)} |
| Cost per pull request | ${usd(perUnit(f.spendUsd, f.prCount))} |
| Cost per commit | ${usd(perUnit(f.spendUsd, f.commitCount))} |
| Autonomy ratio | ${num(f.autonomyRatio)} |
| Cache hit ratio | ${pct(f.cacheHitRatio)} |
| Skill leverage | ${num(f.skillLeverage)} |
| Friction index | ${num(f.frictionIndex)} |

Values shown as "not measured" have no underlying data for this window; they are not zero.

### Work mix (AI-judged)

The figures below are produced by a language model classifying completed sessions, not measured from telemetry. Treat them as an indication of the shape of the work, not as counts of record.

${judged}`;
}

export async function buildCodePulseSection(): Promise<string> {
  const codexPresent = await visibleOpenAi(hasCodexData());
  if (!codexPresent) return renderCodePulseSection(await factsFor('all', false));
  return renderCodePulseSection(await factsFor('claude', true), await factsFor('openai', true));
}

/** One view's facts: the latest rolling org row and its classified sessions (Codex sessions are 'codex:' ids). */
async function factsFor(vendor: Vendor, codexPresent: boolean): Promise<CodePulseFacts> {
  const db = await getTypedClient();
  const rows = await readCodeMetrics(vendor, codexPresent, (t, only) => db
    .select()
    .from(t)
    .where(and(eq(t.scope_type, 'organisation'), eq(t.scope_id, ORG_SCOPE_ID), eq(t.granularity, 'rolling'), only))
    .orderBy(desc(t.computed_at))
    .limit(1));

  const row = rows[0];
  if (!row) return { ...emptyFacts, hasData: false };

  const csc = schema.codeSessionClassifications;
  const codeLabel = await getCodeWorkTypeLabeller();
  const sessionsOf = codeSessionVendor(csc.session_id, vendor);
  const [workMixRows, tierRows] = await Promise.all([
    db
      .select({ workType: csc.work_type, count: sql<number | string>`count(*)` })
      .from(csc)
      .where(and(eq(csc.status, 'classified'), sessionsOf))
      .groupBy(csc.work_type)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({ tier: csc.tier, count: sql<number | string>`count(*)` })
      .from(csc)
      .where(and(eq(csc.status, 'classified'), sessionsOf))
      .groupBy(csc.tier)
      .orderBy(csc.tier),
  ]);

  return {
    hasData: true,
    spendUsd: toNum(row.spend_usd),
    engagedHours: computeEngagedHours(row.active_time_user_s, row.active_time_cli_s),
    linesAdded: row.lines_added,
    linesRemoved: row.lines_removed,
    commitCount: row.commit_count,
    prCount: row.pr_count,
    editAccept: row.edit_accept_count,
    editReject: row.edit_reject_count,
    autonomyRatio: toNum(row.autonomy_ratio),
    cacheHitRatio: toNum(row.cache_hit_ratio),
    sessionCount: row.session_count,
    repoCount: row.repo_count,
    skillLeverage: toNum(row.skill_leverage),
    frictionIndex: toNum(row.friction_index),
    workMix: workMixRows.map(r => ({ workType: codeLabel(r.workType), count: Number(r.count) })),
    tierMix: tierRows.map(r => ({ tier: Number(r.tier), count: Number(r.count) })),
  };
}

const emptyFacts: CodePulseFacts = {
  hasData: false,
  spendUsd: null,
  engagedHours: null,
  linesAdded: 0,
  linesRemoved: 0,
  commitCount: 0,
  prCount: 0,
  editAccept: 0,
  editReject: 0,
  autonomyRatio: null,
  cacheHitRatio: null,
  sessionCount: 0,
  repoCount: 0,
  skillLeverage: null,
  frictionIndex: null,
  workMix: [],
  tierMix: [],
};
