// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Deterministic Work Pulse section for the governance report.
//
// Reads what the Executive View (/api/pulse/cio) reads (no organisation-wide
// row is ever written: the aggregator writes person and department rows only).
// Delegation depth is the average of people's weekly figures in the report
// period. More valuable work and resilience are kept only as current rolling
// figures, never by week, so they are the last 7 days to the report date and
// the section says so. Capabilities are those confirmed to date; tiers, kinds
// of work and candidates are the period's classifications. Covers every Work Pulse product:
// Claude Cowork and Claude Chat, and ChatGPT where connected. As with
// code_metrics, `granularity` is filtered explicitly so the snapshot rows are
// never mixed with the weekly history rows. Signals are named as the product
// names them, never by acronym.
//
// EVERYTHING IN THIS SECTION IS JUDGED. Work Pulse metrics are derived from a
// language model classifying individual messages — unlike Developer Pulse, there is
// no measured half. The section says so once, at the top, rather than repeating
// a caveat per line.
//
// OTI VERSIONING: `metric_version` distinguishes v1 from the v2 aggregator
// (median-of-daily-weighted, active-day-rate-normalised). The two are NOT
// comparable, so the version is stated and no cross-version trend is drawn.
import { and, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export interface CoworkPulseFacts {
  hasData: boolean;
  dds: number | null;
  oti: number | null;
  psr: number | null;
  ors: number | null;
  orsBreadth: number | null;
  orsOverlap: number | null;
  orsPropagation: number | null;
  metricVersion: number;
  otiEarlyRead: boolean;
  tier1: number;
  tier2: number;
  tier3: number;
  eventCount: number;
  taskTypes: Array<{ taskType: string; count: number }>;
  frontierPush: number;
  capabilityCreation: number;
  /** The date the current-only figures (more valuable work, resilience) run to; absent in fixtures. */
  currentAsOf?: string;
}

function num(n: number | null, digits = 2): string {
  return n === null ? 'not measured' : n.toFixed(digits);
}

function int(n: number): string {
  return n.toLocaleString('en-GB');
}

function share(part: number, total: number): string {
  if (total <= 0) return '—';
  return `${Math.round((part / total) * 100)}%`;
}

export function renderCoworkPulseSection(f: CoworkPulseFacts): string {
  if (!f.hasData) {
    return `## Work Pulse

No Work Pulse figures were computed in this period. This means either no Work Pulse activity (Claude Cowork, Claude Chat, or ChatGPT where connected) arrived, or the classifier has not yet run against it.`;
  }

  const tierTotal = f.tier1 + f.tier2 + f.tier3;

  const taskLine = f.taskTypes.length > 0
    ? f.taskTypes.map(t => `${t.taskType} (${int(t.count)})`).join(', ')
    : 'No classified task types in this period.';

  const emerging = f.frontierPush === 0 && f.capabilityCreation === 0
    ? 'No frontier-push or capability-creation candidates were identified in this period.'
    : `${int(f.frontierPush)} frontier-push candidate${f.frontierPush === 1 ? '' : 's'} and ${int(f.capabilityCreation)} capability-creation candidate${f.capabilityCreation === 1 ? '' : 's'} were identified. These are prompts the classifier judged to be pushing beyond routine use, and are worth reading directly rather than counting.`;

  return `## Work Pulse

Every figure in this section is **AI-judged**, not measured. Work Pulse scores are derived from a language model classifying individual messages against an admin-editable rubric. They describe the shape of how the tool is being used, and should not be read as counts of record.

### Signals

| Signal | Value |
|---|---|
| More valuable work (output against each person's baseline; 1.2 is a meaningful uplift) | ${num(f.oti)} |
| Delegation depth (average tier handed to AI) | ${num(f.dds)} |
| Capabilities created (repeatable tasks now owned by AI, confirmed) | ${f.psr === null ? 'not measured' : int(f.psr)} |
| Resilience (how widely capability is shared; 0.7 means organisation-owned) | ${num(f.ors)} |

Resilience components: breadth ${num(f.orsBreadth)}, overlap ${num(f.orsOverlap)}, propagation ${num(f.orsPropagation)}.
${f.currentAsOf ? `
Delegation depth covers the report period. More valuable work and resilience are kept only as current figures, so they cover the 7 days to ${f.currentAsOf}, not the report period. Capabilities created are those confirmed to date.
` : ''}
More valuable work is reported at metric version ${f.metricVersion}${f.otiEarlyRead ? ', flagged as an early read because the window contains too few active days to be stable' : ''}. Version 1 and version 2 are calculated differently and must not be compared across a version change.

### Delegation tiers

| Tier | Messages | Share |
|---|---|---|
| Tier 1 | ${int(f.tier1)} | ${share(f.tier1, tierTotal)} |
| Tier 2 | ${int(f.tier2)} | ${share(f.tier2, tierTotal)} |
| Tier 3 | ${int(f.tier3)} | ${share(f.tier3, tierTotal)} |

Classified messages in window: ${int(f.eventCount)}.

### Task types

${taskLine}

### Emerging capability

${emerging}`;
}

export async function buildCoworkPulseSection(periodStart: string, periodEnd: string): Promise<string> {
  const db = await getTypedClient();
  const pm = schema.pulseMetrics;
  const pc = schema.pulseClassifications;
  const pe = schema.pulseEvents;
  const from = Math.floor(new Date(periodStart).getTime() / 1000);
  const to = Math.floor(new Date(periodEnd).getTime() / 1000) + 86400; // the end date is a whole day
  const toNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const round2 = (v: unknown): number | null => { const n = toNum(v); return n === null ? null : Math.round(n * 100) / 100; };

  // Current figures: the last 7 days, as the Executive View's cards read them.
  const nowS = Math.floor(Date.now() / 1000);
  const recent = nowS - 7 * 86400;
  const [weekRows, personRows, deptRows, tierRows, taskRows, candidateRows, capabilityRows] = await Promise.all([
    // Delegation depth: people's weekly figures for weeks starting in the period.
    db
      .select({ dds: sql<number | string | null>`AVG(${pm.dds})` })
      .from(pm)
      .where(and(eq(pm.scope_type, 'user'), eq(pm.granularity, 'week'), isNotNull(pm.dds), gte(pm.period_start, from), lt(pm.period_start, to))),
    db
      .select({
        oti: sql<number | string | null>`AVG(${pm.oti})`,
        version: sql<number | string | null>`MAX(${pm.metric_version})`,
        early: sql<number | string | null>`MAX(${pm.oti_early_read})`,
      })
      .from(pm)
      .where(and(eq(pm.scope_type, 'user'), eq(pm.granularity, 'rolling'), gte(pm.computed_at, recent))),
    db
      .select({
        ors: sql<number | string | null>`AVG(${pm.ors})`,
        breadth: sql<number | string | null>`AVG(${pm.ors_breadth})`,
        overlap: sql<number | string | null>`AVG(${pm.ors_overlap})`,
        propagation: sql<number | string | null>`AVG(${pm.ors_propagation})`,
      })
      .from(pm)
      .where(and(eq(pm.scope_type, 'function'), isNotNull(pm.ors), eq(pm.granularity, 'rolling'), gte(pm.computed_at, recent))),
    db
      .select({ tier: pc.tier, count: sql<number | string>`count(*)` })
      .from(pc)
      .where(and(eq(pc.classifier_status, 'classified'), gte(pc.classified_at, from), lt(pc.classified_at, to)))
      .groupBy(pc.tier),
    db
      .select({ taskType: pc.task_type, count: sql<number | string>`count(*)` })
      .from(pc)
      .where(and(eq(pc.classifier_status, 'classified'), gte(pc.classified_at, from), lt(pc.classified_at, to)))
      .groupBy(pc.task_type)
      .orderBy(desc(sql`count(*)`))
      .limit(12),
    db
      .select({
        frontier: sql<number | string>`sum(${pc.frontier_push_candidate})`,
        capability: sql<number | string>`sum(${pc.capability_creation_candidate})`,
      })
      .from(pc)
      .where(and(eq(pc.classifier_status, 'classified'), gte(pc.classified_at, from), lt(pc.classified_at, to))),
    db
      .select({ v: sql<number | string>`count(*)` })
      .from(pe)
      .where(and(eq(pe.event_type, 'capability_creation'), eq(pe.status, 'confirmed'))),
  ]);

  const tiers = { 1: 0, 2: 0, 3: 0 } as Record<number, number>;
  for (const r of tierRows) if (r.tier === 1 || r.tier === 2 || r.tier === 3) tiers[r.tier] = Number(r.count);
  const eventCount = tiers[1] + tiers[2] + tiers[3];
  const person = personRows[0];
  const dept = deptRows[0];

  return renderCoworkPulseSection({
    hasData: eventCount > 0 || toNum(weekRows[0]?.dds) !== null,
    dds: round2(weekRows[0]?.dds),
    oti: round2(person?.oti),
    psr: Number(capabilityRows[0]?.v ?? 0),
    ors: round2(dept?.ors),
    orsBreadth: round2(dept?.breadth),
    orsOverlap: round2(dept?.overlap),
    orsPropagation: round2(dept?.propagation),
    metricVersion: Number(person?.version ?? 2),
    otiEarlyRead: Number(person?.early ?? 0) === 1,
    tier1: tiers[1],
    tier2: tiers[2],
    tier3: tiers[3],
    eventCount,
    taskTypes: taskRows.map(r => ({ taskType: r.taskType, count: Number(r.count) })),
    frontierPush: Number(candidateRows[0]?.frontier ?? 0),
    capabilityCreation: Number(candidateRows[0]?.capability ?? 0),
    currentAsOf: new Date(nowS * 1000).toISOString().slice(0, 10),
  });
}
