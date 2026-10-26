// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Deterministic Work Pulse section for the governance report.
//
// Reads the latest ROLLING org-scope `pulse_metrics` row plus classification
// counts. As with code_metrics, `granularity` is filtered explicitly so the
// snapshot row is never mixed with the weekly history rows.
//
// EVERYTHING IN THIS SECTION IS JUDGED. Work Pulse metrics are derived from a
// language model classifying individual messages — unlike Developer Pulse, there is
// no measured half. The section says so once, at the top, rather than repeating
// a caveat per line.
//
// OTI VERSIONING: `metric_version` distinguishes v1 from the v2 aggregator
// (median-of-daily-weighted, active-day-rate-normalised). The two are NOT
// comparable, so the version is stated and no cross-version trend is drawn.
import { and, desc, eq, sql } from 'drizzle-orm';
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

No Work Pulse metrics have been computed yet. This means either no Cowork telemetry has arrived, or the classifier has not yet run against it.`;
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

### Scores

| Metric | Value |
|---|---|
| Delegation Depth Score (DDS) | ${num(f.dds)} |
| Outcome Task Index (OTI) | ${num(f.oti)} |
| Process Sophistication Ratio (PSR) | ${num(f.psr)} |
| Organisational Reach Score (ORS) | ${num(f.ors)} |

ORS components: breadth ${num(f.orsBreadth)}, overlap ${num(f.orsOverlap)}, propagation ${num(f.orsPropagation)}.

OTI is reported at metric version ${f.metricVersion}${f.otiEarlyRead ? ', flagged as an early read because the window contains too few active days to be stable' : ''}. Version 1 and version 2 are calculated differently and must not be compared across a version change.

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

export async function buildCoworkPulseSection(): Promise<string> {
  const db = await getTypedClient();
  const pm = schema.pulseMetrics;

  const rows = await db
    .select()
    .from(pm)
    .where(and(eq(pm.scope_type, 'organisation'), eq(pm.granularity, 'rolling')))
    .orderBy(desc(pm.computed_at))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return renderCoworkPulseSection({
      hasData: false,
      dds: null, oti: null, psr: null, ors: null,
      orsBreadth: null, orsOverlap: null, orsPropagation: null,
      metricVersion: 1, otiEarlyRead: false,
      tier1: 0, tier2: 0, tier3: 0, eventCount: 0,
      taskTypes: [], frontierPush: 0, capabilityCreation: 0,
    });
  }

  const pc = schema.pulseClassifications;
  const [taskRows, candidateRows] = await Promise.all([
    db
      .select({ taskType: pc.task_type, count: sql<number | string>`count(*)` })
      .from(pc)
      .where(eq(pc.classifier_status, 'classified'))
      .groupBy(pc.task_type)
      .orderBy(desc(sql`count(*)`))
      .limit(12),
    db
      .select({
        frontier: sql<number | string>`sum(${pc.frontier_push_candidate})`,
        capability: sql<number | string>`sum(${pc.capability_creation_candidate})`,
      })
      .from(pc)
      .where(eq(pc.classifier_status, 'classified')),
  ]);

  return renderCoworkPulseSection({
    hasData: true,
    dds: row.dds ?? null,
    oti: row.oti ?? null,
    psr: row.psr ?? null,
    ors: row.ors ?? null,
    orsBreadth: row.ors_breadth ?? null,
    orsOverlap: row.ors_overlap ?? null,
    orsPropagation: row.ors_propagation ?? null,
    metricVersion: row.metric_version,
    otiEarlyRead: row.oti_early_read === 1,
    tier1: row.tier_1_count,
    tier2: row.tier_2_count,
    tier3: row.tier_3_count,
    eventCount: row.event_count,
    taskTypes: taskRows.map(r => ({ taskType: r.taskType, count: Number(r.count) })),
    frontierPush: Number(candidateRows[0]?.frontier ?? 0),
    capabilityCreation: Number(candidateRows[0]?.capability ?? 0),
  });
}
