// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Spread Panel + Coaching Prompts.
 *
 * Use cases are defined by the work: for a CONFIRMED
 * use case that has its own codified skill, the people in its departments
 * whose sessions were judged to be this work in the last
 * SPREAD_ACTIVITY_WINDOW_WEEKS completed weeks but who have never run the
 * skill. They already do the work by hand; the skill is the better way, so
 * they are who to show it to. A use case with no skill yet has nothing to
 * spread ({ unsupported: 'no_skill' }).
 *
 * Before, Spread matched task labels, skills and connectors and listed
 * people doing "matching kinds" of work who had not been matched to the use
 * case; under judged matching that set is, by definition, the use case's
 * own users. Deterministic: no model call here (the judging happened
 * upstream). Acknowledged pairs ("we've had the chat") stay excluded
 * permanently, as before.
 */
import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { weekStart } from '@/lib/pulse/period';
import { signalMatches } from '@/lib/usecases/signal-match';
import { activityPhrase, type MatchedSignalEvidence } from '@/lib/usecases/spread-format';

import type { UseCase } from '@/lib/usecases/queries';

export const SPREAD_ACTIVITY_WINDOW_WEEKS = 4;
/** Starting value, not yet measured: "does this work regularly" = at least two judged sessions in the window. */
export const SPREAD_MIN_SESSIONS = 2;
export const SPREAD_PANEL_CAP = 10;
/** How many candidates SpreadPanel renders per department before "and N more". */
export const SPREAD_PANEL_VISIBLE = SPREAD_PANEL_CAP;
export const PROMPTS_PER_DEPT = 3;
const NO_DEPT = 'No department';
const WEEK_S = 7 * 86400;

export type { MatchedSignalEvidence };
// Text helpers live in the client-safe leaf module (SpreadPanel uses them too).
export { humaniseSignal, activityPhrase } from '@/lib/usecases/spread-format';

/** matchedSignal = the use case's skill name; activityCount = the person's judged sessions of this work in the window. */
export interface SpreadCandidate { userId: string; displayName: string; matchedSignal: string; matchedKind: 'work'; activityCount: number; signals: MatchedSignalEvidence[] }
export interface SpreadDept { dept: string; adopterCount: number; users: SpreadCandidate[]; more: number }
export type SpreadResult = { departments: SpreadDept[] } | { unsupported: 'no_skill' } | null;
export interface CoachingPrompt { userId: string; displayName: string; promptText: string; useCaseId: string; useCaseTitle: string }
/** One person's judged sessions of the use case's work in the window. */
export interface ActivityRow { userId: string; displayName: string; dept: string | null; sessions: number }

/**
 * Pure assembly: people doing the work (activity), minus those who have run
 * the skill or been acknowledged (excluded), bucketed by department and capped.
 * adopterCountByDept = people per department who have run the skill.
 */
export function assembleSpread(
  uc: Pick<UseCase, 'status' | 'departments'>,
  skillName: string | null,
  activity: ActivityRow[],
  excluded: Set<string>,
  adopterCountByDept: Map<string, number>,
): SpreadResult {
  if (uc.status !== 'confirmed') return null;
  if (!skillName) return { unsupported: 'no_skill' };
  const deptFilter = uc.departments.length > 0 ? new Set(uc.departments) : null;
  const byDept = new Map<string, SpreadCandidate[]>();
  for (const r of activity) {
    if (r.sessions < SPREAD_MIN_SESSIONS || excluded.has(r.userId)) continue;
    const dept = r.dept ?? NO_DEPT;
    if (deptFilter && !deptFilter.has(dept)) continue;
    const list = byDept.get(dept) ?? [];
    list.push({
      userId: r.userId, displayName: r.displayName,
      matchedSignal: skillName, matchedKind: 'work', activityCount: r.sessions,
      signals: [{ signal: skillName, kind: 'work', count: r.sessions }],
    });
    byDept.set(dept, list);
  }
  const departments: SpreadDept[] = [...byDept.entries()]
    .map(([dept, users]) => {
      users.sort((a, b) => b.activityCount - a.activityCount || a.displayName.localeCompare(b.displayName));
      return { dept, adopterCount: adopterCountByDept.get(dept) ?? 0, users: users.slice(0, SPREAD_PANEL_CAP), more: Math.max(0, users.length - SPREAD_PANEL_CAP) };
    })
    .sort((a, b) => b.users.length - a.users.length || a.dept.localeCompare(b.dept));
  return { departments };
}

/** Deterministic manager prompts: one per person (their most-done use case), <= PROMPTS_PER_DEPT. */
export function buildCoachingPrompts(
  spreadByUseCase: Array<{ useCase: Pick<UseCase, 'id' | 'title'>; candidates: SpreadCandidate[] }>,
): CoachingPrompt[] {
  const bestPerUser = new Map<string, CoachingPrompt & { activityCount: number }>();
  for (const { useCase, candidates } of spreadByUseCase) {
    for (const c of candidates) {
      const prev = bestPerUser.get(c.userId);
      if (prev && prev.activityCount >= c.activityCount) continue;
      bestPerUser.set(c.userId, {
        userId: c.userId,
        displayName: c.displayName,
        useCaseId: useCase.id,
        useCaseTitle: useCase.title,
        activityCount: c.activityCount,
        promptText: `${c.displayName} did "${useCase.title}" in ${activityPhrase(c.activityCount, 'work')} `
          + `in the last ${SPREAD_ACTIVITY_WINDOW_WEEKS} weeks but hasn't used its skill, ${c.matchedSignal}. Worth showing them.`,
      });
    }
  }
  return [...bestPerUser.values()]
    .sort((a, b) => b.activityCount - a.activityCount || a.displayName.localeCompare(b.displayName))
    .slice(0, PROMPTS_PER_DEPT)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- activityCount is dropped on purpose
    .map(({ activityCount: _ac, ...prompt }) => prompt);
}

interface UserMeta { displayName: string; dept: string | null }

/** Display-name + dept resolution for a set of user ids (admin_users wins for
 * display name ONLY; dept is users-table only, matching /pulse/dept membership). */
async function getUserMeta(userIds: string[]): Promise<Map<string, UserMeta>> {
  if (userIds.length === 0) return new Map();
  const client = await getTypedClient();
  const u = schema.users;
  const au = schema.adminUsers;
  const rows = await client
    .select({
      id: u.id, display_name: u.display_name, email: u.email, department: u.department,
      admin_name: au.display_name,
    })
    .from(u)
    .leftJoin(au, eq(au.linked_cowork_user_id, u.id))
    .where(and(inArray(u.id, userIds), isNull(u.deactivated_at)));
  return new Map(rows.map(r => [r.id, {
    displayName: r.admin_name ?? r.display_name ?? r.email ?? r.id,
    dept: r.department ?? null,
  }]));
}

/** The use case's codified skill name (its downloaded skill draft), or null. */
async function readCodifiedSkill(ucId: string): Promise<string | null> {
  const client = await getTypedClient();
  const d = schema.useCaseSkillDrafts;
  const rows = await client.select({ name: d.skill_name, at: d.downloaded_at }).from(d).where(eq(d.use_case_id, ucId)).limit(1);
  return rows[0] && rows[0].at != null ? rows[0].name : null;
}

/** Judged sessions of this use case per person, last SPREAD_ACTIVITY_WINDOW_WEEKS completed weeks. */
async function readWorkActivity(ucId: string, nowS: number): Promise<ActivityRow[]> {
  const client = await getTypedClient();
  const wm = schema.useCaseWeekMatches;
  const end = weekStart(nowS);
  const start = end - SPREAD_ACTIVITY_WINDOW_WEEKS * WEEK_S;
  const rows = await client
    .select({ user_id: wm.user_id, n: sql<number | string>`COUNT(DISTINCT CASE WHEN ${wm.session_id} <> '' THEN ${wm.session_id} END)` })
    .from(wm)
    .where(and(eq(wm.use_case_id, ucId), gte(wm.week_start, start), lt(wm.week_start, end)))
    .groupBy(wm.user_id);
  const meta = await getUserMeta(rows.map(r => r.user_id));
  return rows.flatMap(r => {
    const m = meta.get(r.user_id);
    if (!m) return []; // deactivated or unknown
    return [{ userId: r.user_id, displayName: m.displayName, dept: m.dept, sessions: Number(r.n) }];
  });
}

/** Everyone who has ever run the skill (exact or marketplace-prefixed name), with a per-department count. */
async function readSkillUsers(skillName: string): Promise<{ users: Set<string>; adoptersByDept: Map<string, number> }> {
  const client = await getTypedClient();
  const si = schema.coworkSkillInvocations;
  const lc = skillName.toLowerCase();
  const rows = await client
    .selectDistinct({ user_id: si.user_id, name: si.skill_name })
    .from(si)
    .where(sql`lower(${si.skill_name}) = ${lc} OR lower(${si.skill_name}) LIKE ${'%:' + lc}`);
  const users = new Set(
    rows.filter(r => r.user_id && signalMatches(new Set([skillName]), r.name)).map(r => r.user_id as string),
  );
  const meta = await getUserMeta([...users]);
  const adoptersByDept = new Map<string, number>();
  for (const id of users) {
    const m = meta.get(id);
    if (!m) continue;
    const dept = m.dept ?? NO_DEPT;
    adoptersByDept.set(dept, (adoptersByDept.get(dept) ?? 0) + 1);
  }
  return { users, adoptersByDept };
}

/** Coaching acknowledgements ("we've had the chat") for one use case. Acked
 * pairs are excluded from spread candidates / coaching prompts / coaching
 * counts everywhere, permanently (no expiry). */
async function readAcked(ucId: string): Promise<Set<string>> {
  const client = await getTypedClient();
  const ca = schema.coachingAcks;
  const rows = await client.select({ user_id: ca.user_id }).from(ca).where(eq(ca.use_case_id, ucId));
  return new Set(rows.map(r => r.user_id));
}

/** Records that a manager has acknowledged this person+use-case pairing —
 * permanent exclusion from findSpreadCandidates / getDeptCoachingPrompts /
 * getCoachingCountsByDept (all three flow through findSpreadCandidates, so
 * excluding here covers all of them in one place). Idempotent. */
export async function acknowledgeCoachingPrompt(userId: string, useCaseId: string, ackedBy: string): Promise<void> {
  const client = await getTypedClient();
  const nowS = Math.floor(Date.now() / 1000);
  await client
    .insert(schema.coachingAcks)
    .values({ user_id: userId, use_case_id: useCaseId, acked_by: ackedBy, acked_at: nowS })
    .onConflictDoNothing();
}

/** Undoes acknowledgeCoachingPrompt (the undoable "Mark done"). Idempotent. */
export async function unacknowledgeCoachingPrompt(userId: string, useCaseId: string): Promise<void> {
  const client = await getTypedClient();
  const ca = schema.coachingAcks;
  await client.delete(ca).where(and(eq(ca.user_id, userId), eq(ca.use_case_id, useCaseId)));
}

/** The Spread panel for one use case ("already uses it" = has run its skill, so there is no quiet window). */
export async function findSpreadCandidates(uc: UseCase, nowS: number): Promise<SpreadResult> {
  if (uc.status !== 'confirmed') return null;
  const skillName = await readCodifiedSkill(uc.id);
  if (!skillName) return { unsupported: 'no_skill' };
  const [activity, { users: skillUsers, adoptersByDept }, acked] = await Promise.all([
    readWorkActivity(uc.id, nowS),
    readSkillUsers(skillName),
    readAcked(uc.id),
  ]);
  return assembleSpread(uc, skillName, activity, new Set([...skillUsers, ...acked]), adoptersByDept);
}

/** All confirmed use cases' candidates for ONE department -> prompts. */
export async function getDeptCoachingPrompts(dept: string, nowS: number): Promise<CoachingPrompt[]> {
  if ((await getConfigValue('useCasesEnabled')) !== 'true') return [];
  const { listUseCases } = await import('@/lib/usecases/queries');
  const confirmed = (await listUseCases({ status: 'confirmed' }))
    .filter(uc => uc.departments.length === 0 || uc.departments.includes(dept));
  const perUseCase = [];
  for (const uc of confirmed) {
    const res = await findSpreadCandidates(uc, nowS);
    if (res === null || 'unsupported' in res) continue;
    const deptBlock = res.departments.find(d => d.dept === dept);
    if (deptBlock && deptBlock.users.length > 0) {
      perUseCase.push({ useCase: { id: uc.id, title: uc.title }, candidates: deptBlock.users });
    }
  }
  return buildCoachingPrompts(perUseCase);
}

/** Digest feed: {dept, count} pairs ONLY — names must never leave this module here. */
export async function getCoachingCountsByDept(nowS: number): Promise<Array<{ dept: string; count: number }>> {
  if ((await getConfigValue('useCasesEnabled')) !== 'true') return [];
  const { listUseCases } = await import('@/lib/usecases/queries');
  const confirmed = await listUseCases({ status: 'confirmed' });
  const promptCountByDept = new Map<string, Set<string>>();
  for (const uc of confirmed) {
    const res = await findSpreadCandidates(uc, nowS);
    if (res === null || 'unsupported' in res) continue;
    for (const d of res.departments) {
      if (d.dept === NO_DEPT) continue; // prompts are dept-scoped; no-dept users have no manager page
      const set = promptCountByDept.get(d.dept) ?? new Set<string>();
      for (const u of d.users) set.add(u.userId);
      promptCountByDept.set(d.dept, set);
    }
  }
  return [...promptCountByDept.entries()]
    .map(([dept, users]) => ({ dept, count: Math.min(users.size, PROMPTS_PER_DEPT) }))
    .filter(c => c.count > 0)
    .sort((a, b) => a.dept.localeCompare(b.dept));
}
