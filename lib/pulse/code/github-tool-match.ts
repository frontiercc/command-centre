// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Which AI tool made a GitHub commit, worked out without reading any commit
 * message.
 *
 * The GitHub sync already knows each commit's author (resolved to a person)
 * and its time. Claude Code and Codex each record, per person, the moment
 * they made a commit: Claude Code's `claude_code.commit.count` metric
 * (code_otel_metrics), or where a person has none of those, the commit count
 * on their Claude Code model calls (code_assistant_meta.commit_count); Codex's
 * git-commit tool calls (codex_actions.commit_count). A GitHub commit is
 * matched to a tool commit by the SAME person within MATCH_TOLERANCE_S of the
 * commit's author time. Each tool commit can match at most one GitHub commit,
 * and the closest pairs are matched first. Anything left over, and every
 * commit whose author is not a known person, is "no AI tool recorded".
 *
 * Only counts leave the sync. matchCommitsToTools is pure (fixtures-testable);
 * loadToolCommitTimes reads the three tables.
 */
import { and, eq, gt, gte, isNotNull, lte } from 'drizzle-orm';
import type { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

type Client = Awaited<ReturnType<typeof getTypedClient>>;

/** 15 minutes either side of the commit's author time. */
export const MATCH_TOLERANCE_S = 15 * 60;

export type CommitTool = 'claude' | 'codex' | null;

/** Epoch seconds, one entry per commit the tool recorded (a count of 2 is two entries). */
export interface ToolCommitTimes {
  claude: number[];
  codex: number[];
}

/**
 * Tags each GitHub commit (by index, author times in epoch seconds) with the
 * tool that made it, or null. Greedy closest-first, so a tool commit goes to
 * the GitHub commit nearest in time; ties break on Claude Code before Codex,
 * then earliest commit, so the result is deterministic.
 */
export function matchCommitsToTools(
  commitTimes: number[],
  tools: ToolCommitTimes,
  toleranceS: number = MATCH_TOLERANCE_S,
): CommitTool[] {
  const out: CommitTool[] = commitTimes.map(() => null);
  if (commitTimes.length === 0) return out;

  interface Candidate { gap: number; commit: number; tool: 'claude' | 'codex'; event: number }
  const candidates: Candidate[] = [];
  const order = commitTimes.map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t);
  for (const tool of ['claude', 'codex'] as const) {
    const events = tools[tool];
    for (let e = 0; e < events.length; e++) {
      const at = events[e];
      // Binary search for the first commit at or after at - tolerance.
      let lo = 0, hi = order.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (order[mid].t < at - toleranceS) lo = mid + 1; else hi = mid;
      }
      for (let k = lo; k < order.length && order[k].t <= at + toleranceS; k++) {
        candidates.push({ gap: Math.abs(order[k].t - at), commit: order[k].i, tool, event: e });
      }
    }
  }
  candidates.sort((a, b) =>
    a.gap - b.gap
    || (a.tool === b.tool ? 0 : a.tool === 'claude' ? -1 : 1)
    || commitTimes[a.commit] - commitTimes[b.commit]
    || a.commit - b.commit
    || a.event - b.event);

  const usedEvents = { claude: new Set<number>(), codex: new Set<number>() };
  for (const c of candidates) {
    if (out[c.commit] !== null || usedEvents[c.tool].has(c.event)) continue;
    out[c.commit] = c.tool;
    usedEvents[c.tool].add(c.event);
  }
  return out;
}

export interface ToolCounts { claude: number; codex: number; none: number }

export function emptyToolCounts(): ToolCounts {
  return { claude: 0, codex: 0, none: 0 };
}

export function addTool(counts: ToolCounts, tool: CommitTool): void {
  if (tool === 'claude') counts.claude++;
  else if (tool === 'codex') counts.codex++;
  else counts.none++;
}

function pushRepeated(list: number[], at: number, count: number): void {
  // A count is whole commits; guard against a fractional or runaway value.
  const n = Math.min(Math.max(Math.round(count), 0), 1000);
  for (let i = 0; i < n; i++) list.push(at);
}

/**
 * Every tool commit recorded per person between fromS and toS (inclusive),
 * widened by the tolerance so a commit at the edge of the window still finds
 * its partner. Claude Code: the commit metric where the person has any in the
 * window, otherwise the commit counts on their model calls (never both, which
 * would count one commit twice).
 */
export async function loadToolCommitTimes(client: Client, fromS: number, toS: number): Promise<Map<string, ToolCommitTimes>> {
  const from = fromS - MATCH_TOLERANCE_S;
  const to = toS + MATCH_TOLERANCE_S;
  const com = schema.codeOtelMetrics;
  const cam = schema.codeAssistantMeta;
  const ca = schema.codexActions;

  const byUser = new Map<string, ToolCommitTimes>();
  const forUser = (userId: string) => {
    let t = byUser.get(userId);
    if (!t) { t = { claude: [], codex: [] }; byUser.set(userId, t); }
    return t;
  };

  const metricRows = await client
    .select({ user_id: com.user_id, occurred_at: com.occurred_at, value: com.value })
    .from(com)
    .where(and(
      eq(com.metric_name, 'claude_code.commit.count'), isNotNull(com.user_id),
      gte(com.occurred_at, from), lte(com.occurred_at, to), gt(com.value, 0),
    ));
  const metricUsers = new Set<string>();
  for (const r of metricRows) {
    const uid = r.user_id as string;
    metricUsers.add(uid);
    pushRepeated(forUser(uid).claude, Number(r.occurred_at), Number(r.value));
  }

  const camRows = await client
    .select({ user_id: cam.user_id, occurred_at: cam.occurred_at, commit_count: cam.commit_count })
    .from(cam)
    .where(and(isNotNull(cam.user_id), gte(cam.occurred_at, from), lte(cam.occurred_at, to), gt(cam.commit_count, 0)));
  for (const r of camRows) {
    const uid = r.user_id as string;
    if (metricUsers.has(uid)) continue;
    pushRepeated(forUser(uid).claude, Number(r.occurred_at), Number(r.commit_count));
  }

  const codexRows = await client
    .select({ user_id: ca.user_id, occurred_at: ca.occurred_at, commit_count: ca.commit_count })
    .from(ca)
    .where(and(gte(ca.occurred_at, from), lte(ca.occurred_at, to), gt(ca.commit_count, 0)));
  for (const r of codexRows) {
    pushRepeated(forUser(r.user_id).codex, Number(r.occurred_at), Number(r.commit_count));
  }

  for (const t of byUser.values()) {
    t.claude.sort((a, b) => a - b);
    t.codex.sort((a, b) => a - b);
  }
  return byUser;
}

/** Which GitHub commits a per-person "Repos active (GitHub)" figure counts. */
export type GithubRepoBasis = 'all' | 'claude' | 'openai';

/**
 * Claude and Codex tabs count repos with commits matched to that tool; the
 * All tab, and a hub without Codex data (no tabs), count every repo.
 */
export function githubRepoBasis(vendor: 'all' | 'claude' | 'openai', codexPresent: boolean): GithubRepoBasis {
  return codexPresent ? vendor : 'all';
}

/** The github_user_repo_stats column for a basis (the tool columns are null on rows synced before migration 0047). */
export function githubBasisColumn(t: typeof schema.githubUserRepoStats, basis: GithubRepoBasis) {
  return basis === 'claude' ? t.claude_commit_count : basis === 'openai' ? t.codex_commit_count : t.commit_count;
}
