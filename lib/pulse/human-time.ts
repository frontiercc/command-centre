// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Human time vs Claude time.
// Pure and client-safe: the prompt wording both jobs share and the check every
// estimate must pass. The estimate is a JUDGEMENT (violet, labelled as such);
// Claude time is the session's measured active time and never comes from here.
import { UNTRUSTED_TEXT_RULE } from '@/lib/anthropic/untrusted';

export interface HumanMinutes {
  low: number;
  likely: number;
  high: number;
}

/** 40 hours. A single session's by-hand figure above this is rejected, never clamped. */
export const MAX_HUMAN_MINUTES = 2400;

/** Only Tier 2 and 3 sessions carry an estimate (Tier 1 is excluded by rule). */
export function tierGetsEstimate(tier: number): boolean {
  return tier === 2 || tier === 3;
}

/**
 * Accept the model's figure only if it is three whole minutes with
 * 1 <= low <= likely <= high <= MAX_HUMAN_MINUTES. Anything else is null
 * ("not estimated"), never repaired or clamped. A figure below the session's
 * Claude time is deliberately allowed: some work is no faster with Claude.
 */
export function parseHumanMinutes(value: unknown): HumanMinutes | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const nums = [v.low, v.likely, v.high];
  if (!nums.every(n => typeof n === 'number' && Number.isInteger(n))) return null;
  const [low, likely, high] = nums as number[];
  if (low < 1 || low > likely || likely > high || high > MAX_HUMAN_MINUTES) return null;
  return { low, likely, high };
}

/** Code: the extra instruction appended to the session classifier's system message. */
export const CODE_HUMAN_TIME_INSTRUCTION = `4. human_minutes: ONLY for sessions you put at tier 2 or 3 (omit it for tier 1). Your estimate of how long an experienced engineer on this codebase would take to produce the same result by hand, without AI: reading the code, making the changes, testing and review, excluding meetings and waiting. Use the lines changed, commits, pull requests, tool actions and prompts as evidence of how much work was done. Give three whole numbers of minutes: {"low": ..., "likely": ..., "high": ...}, with low <= likely <= high and high at most ${MAX_HUMAN_MINUTES}.`;

/** Cowork: the instruction for the session job. Knowledge work, never framed as engineering. */
export function coworkHumanTimeInstruction(department: string | null, kindOfWork: string): string {
  const role = department ? `someone in ${department}` : 'someone in the relevant role';
  return `Also estimate how long a competent professional (${role}, doing ${kindOfWork.replace(/_/g, ' ')} work) would take to produce the same result by hand, without AI: the reading, research, drafting, analysis and checking, excluding meetings and waiting. Give three whole numbers of minutes, low <= likely <= high, high at most ${MAX_HUMAN_MINUTES}.`;
}

/** Hours for display: one decimal under 10, whole hours above. */
export function formatHours(minutes: number): string {
  const x = minutes / 60;
  return x < 10 ? x.toFixed(1) : Math.round(x).toLocaleString('en-GB');
}

/**
 * One plain sentence for text outputs (digest, Highlights). Every number is
 * computed in code and passed in; a model never writes one.
 */
export function humanTimeSentence(
  h: { total: { sessions: number; humanMinutes: number; claudeMinutes: number } },
  period: string,
): string {
  return `${period}: about ${formatHours(h.total.humanMinutes)} hours of Tier 2 and 3 work by hand (AI estimate), done in ${formatHours(h.total.claudeMinutes)} hours with Claude (measured), across ${h.total.sessions.toLocaleString('en-GB')} sessions.`;
}

/** Code backfill: size already-classified sessions without reclassifying them. */
export const CODE_ESTIMATE_ONLY_SYSTEM = `You size finished Claude Code engineering sessions from their telemetry digests. Every session below was already judged to be meaningful delegated work.

For each session, estimate how long an experienced engineer on this codebase would take to produce the same result by hand, without AI: reading the code, making the changes, testing and review, excluding meetings and waiting. Use the lines changed, commits, pull requests, tool actions and prompts as evidence of how much work was done. Give three whole numbers of minutes, with low <= likely <= high and high at most ${MAX_HUMAN_MINUTES}.

${UNTRUSTED_TEXT_RULE}

Respond with ONLY a JSON array, no markdown fences, no prose:
[{"session_id": "...", "human_minutes": {"low": 60, "likely": 120, "high": 240}}]`;

/**
 * Pure: is Code human time on? An unset Code switch ('') follows the Cowork
 * one; otherwise it stands on its own. Shared by the server and the admin page.
 */
export function effectiveCodeHumanTime(codeRaw: string | null | undefined, coworkRaw: string | null | undefined): boolean {
  const code = codeRaw == null ? '' : String(codeRaw);
  return code === '' ? String(coworkRaw) === 'true' : code === 'true';
}
