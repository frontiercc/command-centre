// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Readiness bar for "Turn this into a skill". Pure and
 * client-safe: no DB, no config import. Deliberately HIGHER than mining's
 * materiality bar — mining only has to show a process exists; a draft has to
 * capture how it is done well, which needs several people, several days and
 * the follow-up prompts where people say what good looks like. The numbers
 * are proposed, not measured: they live in six admin-held config keys.
 */
export interface SkillCorpusStats {
  prompts: number;
  distinctPrompts: number;
  people: number;
  sessions: number;
  days: number;
  followUps: number;
  weeksSpanned: number;
  unreadableSessions: number;
  firstAt: number | null;
  lastAt: number | null;
  /**
   * How many excerpts were actually sent to the model (the capped sample).
   * Every other count above is over the FULL readable evidence. Optional
   * because drafts stored before this field existed do not carry it.
   */
  promptsShown?: number;
}

export interface ReadinessThresholds {
  minPeople: number;
  minPrompts: number;
  minDays: number;
  minFollowUps: number;
  soloMinDays: number;
  soloMinWeeks: number;
}

export interface ReadinessGap {
  key: 'people' | 'prompts' | 'days' | 'followUps' | 'weeks';
  label: string;
  have: number;
  need: number;
}

export interface Readiness {
  ready: boolean;
  mode: 'team' | 'solo' | null;
  missing: ReadinessGap[];
}

export const DEFAULT_THRESHOLDS: ReadinessThresholds = {
  minPeople: 3, minPrompts: 10, minDays: 3, minFollowUps: 3, soloMinDays: 6, soloMinWeeks: 4,
};

/** parseInt with ||-default and a >= 1 guard — the intOr idiom from process-mining.ts. */
function intOr(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw || String(fallback), 10);
  return isFinite(n) && n >= 1 ? n : fallback;
}

export function thresholdsFromConfig(cfg: Record<string, string | undefined>): ReadinessThresholds {
  const d = DEFAULT_THRESHOLDS;
  return {
    minPeople: intOr(cfg.skillDraftMinPeople, d.minPeople),
    minPrompts: intOr(cfg.skillDraftMinPrompts, d.minPrompts),
    minDays: intOr(cfg.skillDraftMinDays, d.minDays),
    minFollowUps: intOr(cfg.skillDraftMinFollowUps, d.minFollowUps),
    soloMinDays: intOr(cfg.skillDraftSoloMinDays, d.soloMinDays),
    soloMinWeeks: intOr(cfg.skillDraftSoloMinWeeks, d.soloMinWeeks),
  };
}

function gap(key: ReadinessGap['key'], label: string, have: number, need: number): ReadinessGap | null {
  return have >= need ? null : { key, label, have, need };
}

export function assessReadiness(stats: SkillCorpusStats, t: ReadinessThresholds): Readiness {
  const shared = [
    gap('prompts', 'distinct prompts', stats.distinctPrompts, t.minPrompts),
    gap('followUps', 'follow-ups', stats.followUps, t.minFollowUps),
  ];

  if (stats.people === 1) {
    const missing = [
      gap('days', 'separate days', stats.days, t.soloMinDays),
      gap('weeks', 'weeks spanned', stats.weeksSpanned, t.soloMinWeeks),
      ...shared,
    ].filter((g): g is ReadinessGap => g !== null);
    return { ready: missing.length === 0, mode: missing.length === 0 ? 'solo' : null, missing };
  }

  const missing = [
    gap('people', 'people', stats.people, t.minPeople),
    gap('days', 'separate days', stats.days, t.minDays),
    ...shared,
  ].filter((g): g is ReadinessGap => g !== null);
  return { ready: missing.length === 0, mode: missing.length === 0 ? 'team' : null, missing };
}
