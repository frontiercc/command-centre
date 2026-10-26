// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The Work Pulse frontier boxes. Three questions, one
// shape of answer: a piece of work (one session) described by measured facts.
//
//   best work    — the deepest recent session (top box)
//   mainstay     — a person's main kind of Tier 3 work, as a share of their
//                  Tier 3 sessions (person page Frontier card)
//   capability   — existing capability_creation events (candidate|confirmed)
//
// A "step-up" card (first Tier 3 after lower-tier runs) was built and dropped
// before release: measured, 21 of 22 person/kind pairs were Tier 3
// on the first try, so it was near-empty, and the task-type relabel would have
// produced false step-ups.
//
// Everything is computed at read time from pulse_classifications, session
// stats and invocations — no new table, no backfill, no dependence on the
// classifier's rarely-set frontier flag. Never prompt text, never cost, never
// model-written prose. A value that was not measured is null and the UI leaves
// it out; it is never rendered as zero.
import { and, desc, eq, gte, inArray, notInArray, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { MECHANISM_TASK_TYPES } from '@/lib/finance/model-efficiency';
import { readDescriptions } from '@/lib/pulse/session-descriptions';

type Client = Awaited<ReturnType<typeof getTypedClient>>;

const DAY = 24 * 3600;
export const BEST_WORK_WINDOW_DAYS = 7;
export const MONTH_WINDOW_DAYS = 30;
export const FEED_LIMIT = 30;
export const DEPT_TOP_N = 3;
export const CARD_N = 3;

// A session's `capability_creation` label says the work was new, not what it
// was; like the mechanism labels it only names the session when nothing else does.
const LAST_RESORT_TYPES = new Set([...MECHANISM_TASK_TYPES, 'capability_creation']);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ClassRow {
  userId: string;
  sessionId: string;
  taskType: string;
  tier: number;
  capability: boolean;
  occurredAt: number;
}

export interface SessionFacts {
  activeSecs: number | null;
  steps: number | null;
  uploads: number | null;
  producedOutput: boolean | null;
  connectors: string[];
  skills: string[];
  /** How the work was done: counts of named tool calls. Zero when retention stripped the tool names. */
  how: { searches: number; fetches: number; reads: number; planned: number; questions: number };
  /** Successful output tool calls. */
  outputs: { written: number; sent: number; artifacts: number };
  /** Output file names. Withheld unless the viewer may see them. */
  outputNames: string[];
  /** Uploaded documents by type, e.g. ["2 spreadsheets", "a PDF"]. */
  inputs: string[];
}

export function emptyFacts(): SessionFacts {
  return {
    activeSecs: null, steps: null, uploads: null, producedOutput: null, connectors: [], skills: [],
    how: { searches: 0, fetches: 0, reads: 0, planned: 0, questions: 0 },
    outputs: { written: 0, sent: 0, artifacts: 0 },
    outputNames: [], inputs: [],
  };
}

const DOC_TYPES: Array<[RegExp, string, string]> = [
  [/\.(xlsx|xls|xlsm|csv|tsv|numbers)$/i, 'spreadsheet', 'spreadsheets'],
  [/\.pdf$/i, 'PDF', 'PDFs'],
  [/\.(docx|doc|odt|rtf|pages)$/i, 'Word document', 'Word documents'],
  [/\.(pptx|ppt|key|odp)$/i, 'presentation', 'presentations'],
  [/\.(png|jpe?g|gif|webp|svg|heic)$/i, 'image', 'images'],
  [/\.(md|txt)$/i, 'text file', 'text files'],
  [/\.(html?|json|xml)$/i, 'web or data file', 'web or data files'],
];

/** Uploaded file names → ["2 spreadsheets", "a PDF"]; unknown extensions count as "other file". Pure. */
export function summariseInputs(names: string[]): string[] {
  const counts = new Map<string, { one: string; many: string; n: number }>();
  for (const name of names) {
    const hit = DOC_TYPES.find(([re]) => re.test(name));
    const [one, many] = hit ? [hit[1], hit[2]] : ['other file', 'other files'];
    const c = counts.get(one) ?? { one, many, n: 0 };
    c.n += 1;
    counts.set(one, c);
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .map(c => (c.n > 1 ? `${c.n} ${c.many}` : c.one === 'other file' ? 'one other file' : `${/^[aeio]/i.test(c.one) ? 'an' : 'a'} ${c.one}`));
}

export interface WorkItem {
  kind: 'best' | 'mainstay' | 'capability';
  sessionId: string;
  userId: string;
  displayName: string;
  taskType: string;
  tier: number;
  occurredAt: number;
  facts: SessionFacts;
  /** Later sessions by the same person doing this kind of work at this tier or deeper. */
  repeatsSince: number;
  /** Other people in the person's department doing this kind of work at this depth (30 days); null when the department is unknown. */
  othersAtDepth: number | null;
  department: string | null;
  useCase: { id: string; title: string } | null;
  /** One model-written sentence (AI-judged). Withheld unless the viewer may see it. */
  description: string | null;
  /** True when description and output names were withheld for this viewer. */
  detailWithheld: boolean;
  capability?: { eventId: number; status: 'candidate' | 'confirmed' };
}

export interface FrontierView {
  scope: 'person' | 'dept';
  bestWork: WorkItem[];
  /**
   * Person only. Null when they had no Tier 3 work in the window; `item` is null
   * when their Tier 3 sessions carry only the older tool labels, so
   * there is no named kind of work to show yet.
   */
  mainstay: { item: WorkItem | null; count: number; tier3Sessions: number } | null;
  capabilities: WorkItem[];
  /** Capability candidates awaiting review for these people (all time). */
  capabilityPending: number;
  feed: WorkItem[];
  /** Distinct people with Tier 3 work in the best-work window. */
  tier3People: number;
}

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

/** Most frequent label, newest occurrence breaking ties; `allow` filters candidates. */
function pickLabel(rows: ClassRow[], allow: (t: string) => boolean): string | null {
  const stats = new Map<string, { count: number; latest: number }>();
  for (const r of rows) {
    if (!allow(r.taskType)) continue;
    const s = stats.get(r.taskType) ?? { count: 0, latest: -Infinity };
    s.count += 1;
    if (r.occurredAt > s.latest) s.latest = r.occurredAt;
    stats.set(r.taskType, s);
  }
  let best: string | null = null;
  let bs = { count: -1, latest: -Infinity };
  for (const [t, s] of stats) {
    if (s.count > bs.count || (s.count === bs.count && s.latest > bs.latest)) { best = t; bs = s; }
  }
  return best;
}

export interface SessionSummary {
  sessionId: string;
  userId: string;
  tier: number;
  taskType: string;
  capability: boolean;
  occurredAt: number;
}

/**
 * Collapse one session's classifications: its tier is the highest seen, and its
 * kind of work is the label used at that tier (work-shaped labels first, the
 * same rule as buildSessionTaskTypeMap, so "Tier 3 · analysis" names the work
 * that was Tier 3).
 */
export function summariseSession(rows: ClassRow[]): SessionSummary {
  const tier = Math.max(...rows.map(r => r.tier));
  const atTier = rows.filter(r => r.tier === tier);
  const taskType = pickLabel(atTier, t => !LAST_RESORT_TYPES.has(t))
    ?? pickLabel(rows, t => !LAST_RESORT_TYPES.has(t))
    ?? pickLabel(atTier, () => true)!;
  return {
    sessionId: rows[0].sessionId,
    userId: rows[0].userId,
    tier,
    taskType,
    capability: rows.some(r => r.capability),
    occurredAt: Math.max(...rows.map(r => r.occurredAt)),
  };
}

export function groupSessions(rows: ClassRow[]): SessionSummary[] {
  const by = new Map<string, ClassRow[]>();
  for (const r of rows) {
    const list = by.get(r.sessionId);
    if (list) list.push(r); else by.set(r.sessionId, [r]);
  }
  return [...by.values()].map(summariseSession);
}

/** Tier, then capability flag, then steps, then active time, then newest. */
export function rankBestWork(sessions: SessionSummary[], facts: Map<string, SessionFacts>): SessionSummary[] {
  const f = (s: SessionSummary) => facts.get(s.sessionId);
  return [...sessions].sort((a, b) =>
    (b.tier - a.tier)
    || (Number(b.capability) - Number(a.capability))
    || ((f(b)?.steps ?? -1) - (f(a)?.steps ?? -1))
    || ((f(b)?.activeSecs ?? -1) - (f(a)?.activeSecs ?? -1))
    || (b.occurredAt - a.occurredAt));
}

export interface Mainstay {
  session: SessionSummary | null;
  count: number;
  tier3Sessions: number;
}

/**
 * A person's main kind of Tier 3 work since `sinceS`: the named kind (never a
 * tool label) with the most Tier 3 sessions, newest breaking ties, reported as
 * a share of ALL their Tier 3 sessions in the window. `session` is that kind's
 * latest run. Null when there is no Tier 3 work at all.
 */
export function findMainstay(sessions: SessionSummary[], sinceS: number): Mainstay | null {
  const t3 = sessions.filter(s => s.tier === 3 && s.occurredAt >= sinceS);
  if (!t3.length) return null;
  const byType = new Map<string, SessionSummary[]>();
  for (const s of t3) {
    if (LAST_RESORT_TYPES.has(s.taskType)) continue;
    const list = byType.get(s.taskType);
    if (list) list.push(s); else byType.set(s.taskType, [s]);
  }
  let best: SessionSummary[] | null = null;
  const latest = (l: SessionSummary[]) => Math.max(...l.map(x => x.occurredAt));
  for (const list of byType.values()) {
    if (!best || list.length > best.length || (list.length === best.length && latest(list) > latest(best))) best = list;
  }
  if (!best) return { session: null, count: 0, tier3Sessions: t3.length };
  const newest = best.reduce((x, y) => (y.occurredAt > x.occurredAt ? y : x));
  return { session: newest, count: best.length, tier3Sessions: t3.length };
}

/** Later sessions by the same person, same kind of work, at this tier or deeper. */
export function countRepeatsSince(item: SessionSummary, personSessions: SessionSummary[]): number {
  return personSessions.filter(s =>
    s.sessionId !== item.sessionId
    && s.occurredAt > item.occurredAt
    && s.taskType === item.taskType
    && s.tier >= item.tier).length;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

async function readClassRows(client: Client, userIds: string[], sinceS?: number): Promise<ClassRow[]> {
  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;
  const conds = [inArray(pc.user_id, userIds), eq(pc.classifier_status, 'classified')];
  if (sinceS !== undefined) conds.push(gte(cm.occurred_at, sinceS));
  const rows = await client
    .select({
      userId: pc.user_id, sessionId: cm.session_id, taskType: pc.task_type, tier: pc.tier,
      capability: pc.capability_creation_candidate, occurredAt: cm.occurred_at,
    })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(...conds));
  return rows
    .filter(r => r.sessionId)
    .map(r => ({
      userId: r.userId, sessionId: r.sessionId as string, taskType: r.taskType,
      tier: Number(r.tier), capability: Number(r.capability) === 1, occurredAt: Number(r.occurredAt),
    }));
}

async function readSessionFacts(client: Client, sessionIds: string[]): Promise<Map<string, SessionFacts>> {
  const out = new Map<string, SessionFacts>();
  if (!sessionIds.length) return out;
  const css = schema.coworkSessionStats;
  const cmi = schema.coworkMcpInvocations;
  const csi = schema.coworkSkillInvocations;
  for (const id of sessionIds) out.set(id, emptyFacts());

  const stats = await client
    .select({ session_id: css.session_id, active_secs: css.active_secs, steps: css.tool_call_count, uploads: css.upload_count, produced: css.produced_output })
    .from(css).where(inArray(css.session_id, sessionIds));
  for (const s of stats) {
    const f = out.get(s.session_id)!;
    f.activeSecs = s.active_secs == null ? null : Number(s.active_secs);
    f.steps = s.steps == null ? null : Number(s.steps);
    f.uploads = s.uploads == null ? null : Number(s.uploads);
    f.producedOutput = s.produced == null ? null : Number(s.produced) === 1;
  }
  const conns = await client
    .selectDistinct({ session_id: cmi.session_id, name: cmi.mcp_server })
    .from(cmi)
    .where(and(inArray(cmi.session_id, sessionIds), notInArray(cmi.mcp_server, ['workspace', 'cowork'])));
  for (const c of conns) if (c.session_id && c.name) out.get(c.session_id)?.connectors.push(c.name);
  const skills = await client
    .selectDistinct({ session_id: csi.session_id, name: csi.skill_name })
    .from(csi).where(inArray(csi.session_id, sessionIds));
  for (const s of skills) if (s.session_id && s.name) out.get(s.session_id)?.skills.push(s.name);

  // How the work was done, and what came out: named tool calls on the
  // session's cowork_tool_metadata rows (content_preview IS the tool name).
  const cm = schema.coworkMessages;
  const tools = await client
    .select({
      session_id: cm.session_id, tool: cm.content_preview,
      n: sql<number | string>`count(*)`, ok: sql<number | string>`coalesce(sum(${cm.tool_success}), 0)`,
    })
    .from(cm)
    .where(and(inArray(cm.session_id, sessionIds), eq(cm.message_type, 'cowork_tool_metadata')))
    .groupBy(cm.session_id, cm.content_preview);
  for (const t of tools) {
    const f = out.get(t.session_id);
    if (!f) continue;
    const n = Number(t.n);
    const ok = Number(t.ok);
    switch (t.tool) {
      case 'WebSearch': f.how.searches += n; break;
      case 'WebFetch': f.how.fetches += n; break;
      case 'Read': f.how.reads += n; break;
      case 'TaskCreate': f.how.planned += n; break;
      case 'AskUserQuestion': f.how.questions += n; break;
      case 'Write': f.outputs.written += ok; break;
      case 'SendUserFile': f.outputs.sent += ok; break;
      case 'Artifact': f.outputs.artifacts += ok; break;
      default: break;
    }
  }
  const names = await client
    .select({ session_id: cm.session_id, name: cm.output_name })
    .from(cm)
    .where(and(inArray(cm.session_id, sessionIds), sql`${cm.output_name} IS NOT NULL`))
    .orderBy(cm.occurred_at);
  for (const r of names) {
    const f = out.get(r.session_id);
    if (!f || !r.name) continue;
    for (const one of r.name.split(', ')) if (!f.outputNames.includes(one)) f.outputNames.push(one);
  }
  const cs = schema.coworkSessions;
  const uploads = await client
    .select({ id: cs.id, files: cs.files_uploaded })
    .from(cs)
    .where(and(inArray(cs.id, sessionIds), sql`${cs.files_uploaded} IS NOT NULL`));
  for (const u of uploads) {
    const f = out.get(u.id);
    if (!f || !u.files) continue;
    try {
      const list = JSON.parse(u.files);
      if (Array.isArray(list)) f.inputs = summariseInputs(list.filter((x): x is string => typeof x === 'string'));
    } catch { /* malformed list: no input types */ }
  }

  for (const f of out.values()) { f.connectors.sort(); f.skills.sort(); }
  return out;
}

async function readUseCases(client: Client, sessionIds: string[]): Promise<Map<string, { id: string; title: string }>> {
  const out = new Map<string, { id: string; title: string }>();
  if (!sessionIds.length) return out;
  const m = schema.useCaseWeekMatches;
  const uc = schema.useCases;
  const rows = await client
    .select({ session_id: m.session_id, id: uc.id, title: uc.title, week: m.week_start })
    .from(m)
    .innerJoin(uc, eq(uc.id, m.use_case_id))
    .where(and(inArray(m.session_id, sessionIds), eq(uc.status, 'confirmed')))
    .orderBy(desc(m.week_start));
  for (const r of rows) if (!out.has(r.session_id)) out.set(r.session_id, { id: r.id, title: r.title });
  return out;
}

/** Department and display name for each person (admin_users wins, as elsewhere). */
async function readPeople(client: Client, userIds: string[]): Promise<Map<string, { name: string; dept: string | null }>> {
  const u = schema.users;
  const au = schema.adminUsers;
  const rows = await client
    .select({ id: u.id, udn: u.display_name, email: u.email, udept: u.department, adn: au.display_name, adept: au.department })
    .from(u)
    .leftJoin(au, eq(au.linked_cowork_user_id, u.id))
    .where(inArray(u.id, userIds));
  const out = new Map<string, { name: string; dept: string | null }>();
  for (const r of rows) {
    if (out.has(r.id)) continue;
    out.set(r.id, { name: r.adn || r.udn || r.email || r.id, dept: r.udept || r.adept || null });
  }
  return out;
}

async function readDeptMembers(client: Client, dept: string): Promise<string[]> {
  const u = schema.users;
  const au = schema.adminUsers;
  const direct = await client.select({ id: u.id }).from(u).where(eq(u.department, dept));
  const linked = await client
    .select({ id: au.linked_cowork_user_id })
    .from(au)
    .innerJoin(u, eq(u.id, au.linked_cowork_user_id))
    .where(eq(au.department, dept));
  return [...new Set([...direct.map(r => r.id), ...linked.map(r => r.id).filter((x): x is string => !!x)])];
}

// ─── The view ────────────────────────────────────────────────────────────────

/**
 * Who may see descriptions and output file names: admins and managers see
 * everyone's; everyone sees their own. Decided here, on the server, so
 * withheld detail never reaches the browser.
 */
export interface FrontierViewer {
  seeAllDetail: boolean;
  ownUserId: string | null;
}

export async function buildFrontierView(
  target: { userId: string } | { dept: string },
  nowS = Math.floor(Date.now() / 1000),
  viewer: FrontierViewer = { seeAllDetail: false, ownUserId: null },
): Promise<FrontierView> {
  const client = await getTypedClient();
  const scope: FrontierView['scope'] = 'userId' in target ? 'person' : 'dept';
  const empty: FrontierView = { scope, bestWork: [], mainstay: null, capabilities: [], capabilityPending: 0, feed: [], tier3People: 0 };

  const userIds = 'userId' in target ? [target.userId] : await readDeptMembers(client, target.dept);
  if (!userIds.length) return empty;

  // Whole history for these people (step-ups need it); everything else is windowed below.
  const rows = await readClassRows(client, userIds);
  const byPerson = new Map<string, SessionSummary[]>();
  for (const s of groupSessions(rows)) {
    const list = byPerson.get(s.userId);
    if (list) list.push(s); else byPerson.set(s.userId, [s]);
  }
  const allSessions = [...byPerson.values()].flat();
  const sessionById = new Map(allSessions.map(s => [s.sessionId, s]));

  const bestSince = nowS - BEST_WORK_WINDOW_DAYS * DAY;
  const monthSince = nowS - MONTH_WINDOW_DAYS * DAY;

  // Mainstay deep work (person page only).
  const mainstay = scope === 'person' ? findMainstay(allSessions, monthSince) : null;

  // Capability events inside the window, plus the all-time pending count.
  const pe = schema.pulseEvents;
  const cm = schema.coworkMessages;
  const capRows = await client
    .select({ id: pe.id, status: pe.status, userId: pe.user_id, sessionId: cm.session_id, detectedAt: pe.detected_at })
    .from(pe)
    .leftJoin(cm, eq(cm.id, pe.cowork_message_id))
    .where(and(
      inArray(pe.user_id, userIds),
      eq(pe.event_type, 'capability_creation'),
      inArray(pe.status, ['candidate', 'confirmed']),
    ))
    .orderBy(desc(pe.detected_at));
  const capabilityPending = capRows.filter(r => r.status === 'candidate').length;
  const capInWindow = capRows.filter(r => Number(r.detectedAt) >= monthSince && r.sessionId && sessionById.has(r.sessionId));

  // Best work: rank the window's sessions; person = top 1, dept = top N (one per person).
  const recent = allSessions.filter(s => s.occurredAt >= bestSince);
  const tier3People = new Set(recent.filter(s => s.tier === 3).map(s => s.userId)).size;

  // Facts for every session any box might show.
  const candidateIds = new Set<string>([
    ...recent.map(s => s.sessionId),
    ...(mainstay?.session ? [mainstay.session.sessionId] : []),
    ...capInWindow.map(r => r.sessionId as string),
  ]);
  const facts = await readSessionFacts(client, [...candidateIds]);
  const ranked = rankBestWork(recent, facts);
  const bestPicks: SessionSummary[] = [];
  const pickedPeople = new Set<string>();
  for (const s of ranked) {
    if (pickedPeople.has(s.userId)) continue;
    pickedPeople.add(s.userId);
    bestPicks.push(s);
    if (bestPicks.length >= (scope === 'person' ? 1 : DEPT_TOP_N)) break;
  }

  const useCases = await readUseCases(client, [...candidateIds]);
  const descriptions = await readDescriptions([...candidateIds]);
  const people = await readPeople(client, userIds);

  // "Others at this depth" counts people in the same department (30 days). For a
  // person view the department's members are read once, lazily.
  const peerSessionsByDept = new Map<string, SessionSummary[]>();
  async function peerSessions(dept: string): Promise<SessionSummary[]> {
    const cached = peerSessionsByDept.get(dept);
    if (cached) return cached;
    let list: SessionSummary[];
    if (scope === 'dept') {
      list = allSessions.filter(s => s.occurredAt >= monthSince);
    } else {
      const members = await readDeptMembers(client, dept);
      list = members.length ? groupSessions(await readClassRows(client, members, monthSince)) : [];
    }
    peerSessionsByDept.set(dept, list);
    return list;
  }

  async function toItem(s: SessionSummary, kind: WorkItem['kind'], extra: Partial<WorkItem> = {}): Promise<WorkItem> {
    const person = people.get(s.userId);
    const dept = person?.dept ?? null;
    const withheld = !(viewer.seeAllDetail || (viewer.ownUserId !== null && viewer.ownUserId === s.userId));
    const itemFacts = facts.get(s.sessionId) ?? emptyFacts();
    let othersAtDepth: number | null = null;
    if (dept) {
      const peers = await peerSessions(dept);
      othersAtDepth = new Set(peers
        .filter(p => p.userId !== s.userId && p.taskType === s.taskType && p.tier >= s.tier)
        .map(p => p.userId)).size;
    }
    return {
      kind,
      sessionId: s.sessionId,
      userId: s.userId,
      displayName: person?.name ?? s.userId,
      taskType: s.taskType,
      tier: s.tier,
      occurredAt: s.occurredAt,
      facts: withheld ? { ...itemFacts, outputNames: [] } : itemFacts,
      repeatsSince: countRepeatsSince(s, byPerson.get(s.userId) ?? []),
      othersAtDepth,
      department: dept,
      useCase: useCases.get(s.sessionId) ?? null,
      description: withheld ? null : (descriptions.get(s.sessionId) ?? null),
      detailWithheld: withheld,
      ...extra,
    };
  }

  const bestWork = await Promise.all(bestPicks.map(s => toItem(s, 'best')));
  const mainstayView = mainstay
    ? { item: mainstay.session ? await toItem(mainstay.session, 'mainstay') : null, count: mainstay.count, tier3Sessions: mainstay.tier3Sessions }
    : null;
  const capItems = await Promise.all(capInWindow.map(r =>
    toItem(sessionById.get(r.sessionId as string)!, 'capability', {
      capability: { eventId: Number(r.id), status: r.status === 'confirmed' ? 'confirmed' : 'candidate' },
    })));

  return {
    scope,
    bestWork,
    mainstay: mainstayView,
    capabilities: [...capItems].sort((a, b) => b.occurredAt - a.occurredAt).slice(0, CARD_N),
    capabilityPending,
    feed: scope === 'dept' ? [...capItems].sort((a, b) => b.occurredAt - a.occurredAt).slice(0, FEED_LIMIT) : [],
    tier3People,
  };
}

/**
 * The signed-in person's own Cowork user id, resolved the same way /api/pulse/me
 * resolves "my" data: the admin account's linked_cowork_user_id, else a users row
 * with the same email. Null when they have no Cowork activity of their own.
 */
export async function resolveViewerUserId(email: string | undefined): Promise<string | null> {
  if (!email) return null;
  const client = await getTypedClient();
  const linked = await client
    .select({ id: schema.adminUsers.linked_cowork_user_id })
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.email, email))
    .limit(1);
  if (linked[0]?.id) return linked[0].id;
  const byEmail = await client.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
  return byEmail[0]?.id ?? null;
}
