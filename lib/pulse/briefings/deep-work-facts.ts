// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Deep-work facts for the Work Pulse briefings. The briefings
// used to be fed the old template frontier events ("First Tier 3 task"), which
// fire rarely and say nothing, so a strong week read "no frontier events
// occurred". They now get the same measured facts as the frontier boxes:
// who did Tier 3 work, which kinds, and new capabilities. MEASURED ONLY — kinds
// of work, counts, systems. Never a name (the model must not attribute), never
// an AI summary, never a file name, never prompt text.
import { and, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { MECHANISM_TASK_TYPES } from '@/lib/finance/model-efficiency';
import type { WorkItem } from '@/lib/pulse/frontier-view';

const TOOL_LABELS = new Set([...MECHANISM_TASK_TYPES, 'capability_creation']);

export function kindText(taskType: string): string {
  return taskType.replace(/:/g, ' · ').replace(/_/g, ' ');
}

/** One piece of work as a measured sentence fragment, no names. Pure. */
export function describeWork(item: WorkItem): string {
  const f = item.facts;
  const parts: string[] = [];
  if (f.activeSecs && f.activeSecs > 0) parts.push(`${Math.max(1, Math.round(f.activeSecs / 60))} min active`);
  if (f.steps && f.steps > 0) parts.push(`${f.steps} steps`);
  const systems = [...f.connectors, ...f.skills.map(s => s.slice(s.lastIndexOf(':') + 1))];
  if (systems.length) parts.push(systems.length > 1 ? `used ${systems.length} systems (${systems.join(', ')})` : `used ${systems.join(', ')}`);
  if (f.inputs.length) parts.push(`${f.inputs.join(' and ')} in`);
  const out = [
    f.outputs.written ? `${f.outputs.written} ${f.outputs.written === 1 ? 'file' : 'files'} written` : null,
    f.outputs.artifacts ? `${f.outputs.artifacts} ${f.outputs.artifacts === 1 ? 'artifact' : 'artifacts'} created` : null,
  ].filter(Boolean);
  if (out.length) parts.push(out.join(', '));
  else if (f.producedOutput === true) parts.push('produced a file');
  return `${kindText(item.taskType)} (Tier ${item.tier})${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

export interface DeepWorkSummary {
  /** Distinct people with Tier 3 work in the window. */
  tier3People: number;
  /** Distinct sessions with Tier 3 work in the window. */
  tier3Sessions: number;
  /** Named kinds of Tier 3 work, most sessions first (tool labels excluded), at most 5. */
  topKinds: Array<{ kind: string; sessions: number; people: number }>;
  /** Capabilities detected in the window, by kind (candidate or confirmed). */
  newCapabilities: Array<{ kind: string; count: number; confirmed: number }>;
  /** Of those, how many a person has confirmed so far. */
  newCapabilitiesConfirmed: number;
  /** Capability candidates awaiting review for these people, all time. */
  pendingCapabilities: number;
}

/** Deep-work facts for a group of people (null = the whole organisation). */
export async function buildDeepWorkSummary(userIds: string[] | null, sinceS: number, untilS: number): Promise<DeepWorkSummary> {
  const empty: DeepWorkSummary = { tier3People: 0, tier3Sessions: 0, topKinds: [], newCapabilities: [], newCapabilitiesConfirmed: 0, pendingCapabilities: 0 };
  if (userIds !== null && userIds.length === 0) return empty;
  const client = await getTypedClient();
  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;
  const pe = schema.pulseEvents;
  const who = userIds === null ? [] : [inArray(pc.user_id, userIds)];

  const rows = await client
    .select({ user_id: pc.user_id, session_id: cm.session_id, task_type: pc.task_type })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(
      ...who, eq(pc.tier, 3), eq(pc.classifier_status, 'classified'),
      gte(cm.occurred_at, sinceS), lt(cm.occurred_at, untilS),
      or(eq(cm.surface, 'cowork'), isNull(cm.surface)),
    ));

  const people = new Set<string>();
  const sessions = new Set<string>();
  const byKind = new Map<string, { sessions: Set<string>; people: Set<string> }>();
  for (const r of rows) {
    if (!r.session_id) continue;
    people.add(r.user_id);
    sessions.add(r.session_id);
    if (TOOL_LABELS.has(r.task_type)) continue;
    const k = byKind.get(r.task_type) ?? { sessions: new Set(), people: new Set() };
    k.sessions.add(r.session_id);
    k.people.add(r.user_id);
    byKind.set(r.task_type, k);
  }
  const topKinds = [...byKind.entries()]
    .map(([kind, v]) => ({ kind, sessions: v.sessions.size, people: v.people.size }))
    .sort((a, b) => b.sessions - a.sessions || b.people - a.people || a.kind.localeCompare(b.kind))
    .slice(0, 5);

  const capWho = userIds === null ? [] : [inArray(pe.user_id, userIds)];
  const caps = await client
    .select({ kind: pc.task_type, n: sql<number | string>`count(*)`, confirmed: sql<number | string>`count(*) FILTER (WHERE ${pe.status} = 'confirmed')` })
    .from(pe)
    .leftJoin(pc, eq(pc.cowork_message_id, pe.cowork_message_id))
    .where(and(
      ...capWho, eq(pe.event_type, 'capability_creation'), inArray(pe.status, ['candidate', 'confirmed']),
      gte(pe.detected_at, sinceS), lt(pe.detected_at, untilS),
    ))
    .groupBy(pc.task_type);
  const pending = await client
    .select({ n: sql<number | string>`count(*)` })
    .from(pe)
    .where(and(...capWho, eq(pe.event_type, 'capability_creation'), eq(pe.status, 'candidate')));

  return {
    tier3People: people.size,
    tier3Sessions: sessions.size,
    topKinds,
    newCapabilities: caps
      .map(c => ({
        kind: c.kind && c.kind !== 'capability_creation' ? c.kind : 'unspecified work',
        count: Number(c.n),
        confirmed: Number(c.confirmed),
      }))
      .sort((a, b) => b.count - a.count),
    newCapabilitiesConfirmed: caps.reduce((a, c) => a + Number(c.confirmed), 0),
    pendingCapabilities: Number(pending[0]?.n ?? 0),
  };
}

/** Prompt lines for a group summary. Pure. */
export function deepWorkLines(s: DeepWorkSummary): string[] {
  const lines = [
    s.tier3People === 0
      ? 'No Tier 3 (autonomous, high-consequence) work in this period.'
      : `People doing Tier 3 work: ${s.tier3People} (${s.tier3Sessions} ${s.tier3Sessions === 1 ? 'session' : 'sessions'})`,
  ];
  if (s.topKinds.length) {
    lines.push(`Main kinds of Tier 3 work: ${s.topKinds.map(k => `${kindText(k.kind)} (${k.sessions} ${k.sessions === 1 ? 'session' : 'sessions'}, ${k.people} ${k.people === 1 ? 'person' : 'people'})`).join('; ')}`);
  }
  const capTotal = s.newCapabilities.reduce((a, c) => a + c.count, 0);
  lines.push(capTotal === 0
    ? 'New capabilities detected: none'
    : `New capabilities detected by the classifier: ${capTotal}, of which ${s.newCapabilitiesConfirmed} confirmed by a person so far. By kind of work: ${s.newCapabilities.map(c => {
      const open = c.count - c.confirmed;
      const status = [c.confirmed ? `${c.confirmed} confirmed` : null, open ? `${open} unreviewed` : null].filter(Boolean).join(', ');
      return `${kindText(c.kind)} (${status})`;
    }).join('; ')}`);
  if (s.pendingCapabilities > 0) lines.push(`Capabilities awaiting review: ${s.pendingCapabilities}`);
  return lines;
}
