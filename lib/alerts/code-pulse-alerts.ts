// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic Developer Pulse alerts — evaluated on the hourly aggregation cycle.
 * No AI judgement involved; every trigger is a SQL condition over telemetry.
 *
 * Types:
 *   code_cost_spike    — user's Claude Code spend in the last 24h is over a fixed daily limit
 *   code_model_policy  — model seen that is not on the admin allowlist (empty list = disabled)
 *   code_repo_exposure — session in a repo matching a sensitive pattern (off by default)
 *   code_friction      — session with high tool-error density (off by default)
 *
 * Each alert dedupes against open/recent alerts of the same type + subject so
 * an ongoing condition doesn't re-fire every hour.
 */
import { v4 as uuidv4 } from 'uuid';
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { insertAlert } from '@/lib/db/queries';
import { getCodeModelRates, priceTokens } from '@/lib/pulse/code/rates';
import { personLabel } from '@/lib/alerts/person-label';

const DAY = 24 * 3600;

async function num(key: Parameters<typeof getConfigValue>[0], fallback: number): Promise<number> {
  const v = parseFloat(await getConfigValue(key));
  return isFinite(v) ? v : fallback;
}

async function jsonArray(key: Parameters<typeof getConfigValue>[0]): Promise<string[]> {
  try {
    const parsed = JSON.parse((await getConfigValue(key)) || '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Severities of the alerts of this type mentioning this subject that fired in
 * the last 24h (empty when none did).
 *
 * Substring dedup (the subject is embedded inside raw_evidence JSON, not a
 * discrete filterable field — same shape as use-case-alerts.ts / finance-alerts.ts).
 * A LIKE-style match rather than an exact ->> match — jsonb has no LIKE
 * operator so raw_evidence is cast to text, and ILIKE keeps the match
 * case-insensitive.
 */
async function recentAlertSeverities(alertType: string, subject: string): Promise<string[]> {
  const client = await getTypedClient();
  const a = schema.alerts;
  const pattern = `%${subject}%`;
  const likeExpr = sql`${a.raw_evidence}::text ILIKE ${pattern}`;
  const cutoff = Math.floor(Date.now() / 1000) - DAY; // app clock
  const rows = await client
    .select({ severity: a.severity })
    .from(a)
    .where(and(eq(a.alert_type, alertType), likeExpr, gte(a.generated_at, cutoff)));
  return rows.map(r => r.severity);
}

/** True if an alert of this type mentioning this subject fired in the last 24h. */
async function recentlyAlerted(alertType: string, subject: string): Promise<boolean> {
  return (await recentAlertSeverities(alertType, subject)).length > 0;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The spend alert explanation. Names the 24-hour window and the month so far,
 * because Spend Review shows the calendar month and the two figures were read
 * as disagreeing (an alert's $127.53 beside a page's $180 for the same person).
 */
export function costSpikeExplanation(f: {
  who: string; spend24: number; windowEnd: number; monthToDate: number; dailyLimit: number;
}): string {
  const d = new Date(f.windowEnd * 1000);
  const hhmm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const when = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}, ${hhmm} UTC`;
  return `${f.who} spent $${f.spend24.toFixed(2)} on Claude Code in the 24 hours to ${when} (${MONTHS[d.getUTCMonth()]} so far: $${f.monthToDate.toFixed(2)}), `
    + `over the daily limit of $${f.dailyLimit.toFixed(2)}. Could be a heavy work burst or a runaway loop worth a look.`;
}

// ── code_cost_spike ──────────────────────────────────────────────────────────

/** Daily limit when the hub has not set one (config code_cost_spike_floor_usd). */
export const DEFAULT_DAILY_LIMIT_USD = 100;

/**
 * Fixed daily limit: an alert when someone's Claude
 * Code spend in the last 24 hours is over the limit, whatever they usually
 * spend. It used to compare with the person's own trailing daily average
 * (3x, with the limit as a floor), which nobody could read off an alert: the
 * same $116 day was a spike for one person and an ordinary day for another.
 * Over twice the limit is high, which the Slack sweep sends.
 */
async function checkCostSpikes(): Promise<void> {
  if ((await getConfigValue('codeAlertCostSpikeEnabled')) === 'false') return;
  const dailyLimit = await num('codeCostSpikeFloorUsd', DEFAULT_DAILY_LIMIT_USD);

  const client = await getTypedClient();
  const cam = schema.codeAssistantMeta;
  const rates = await getCodeModelRates();
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - DAY;
  // Calendar month (UTC), as Spend Review shows it.
  const nowDate = new Date(now * 1000);
  const monthStart = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1) / 1000;

  // Per-user, per-model token sums for the last 24h and the month so far.
  // SUM() aggregates come back as strings on Postgres (bigint) — Number()
  // coerced below (Policy B) before being fed into priceTokens.
  const rows = await client
    .select({
      user_id: cam.user_id,
      model: cam.model,
      inp24: sql<number | string>`SUM(CASE WHEN ${cam.occurred_at} >= ${dayAgo} THEN ${cam.input_tokens} ELSE 0 END)`,
      out24: sql<number | string>`SUM(CASE WHEN ${cam.occurred_at} >= ${dayAgo} THEN ${cam.output_tokens} ELSE 0 END)`,
      cw24: sql<number | string>`SUM(CASE WHEN ${cam.occurred_at} >= ${dayAgo} THEN ${cam.cache_creation_tokens} ELSE 0 END)`,
      cr24: sql<number | string>`SUM(CASE WHEN ${cam.occurred_at} >= ${dayAgo} THEN ${cam.cache_read_tokens} ELSE 0 END)`,
      inpM: sql<number | string>`SUM(CASE WHEN ${cam.occurred_at} >= ${monthStart} THEN ${cam.input_tokens} ELSE 0 END)`,
      outM: sql<number | string>`SUM(CASE WHEN ${cam.occurred_at} >= ${monthStart} THEN ${cam.output_tokens} ELSE 0 END)`,
      cwM: sql<number | string>`SUM(CASE WHEN ${cam.occurred_at} >= ${monthStart} THEN ${cam.cache_creation_tokens} ELSE 0 END)`,
      crM: sql<number | string>`SUM(CASE WHEN ${cam.occurred_at} >= ${monthStart} THEN ${cam.cache_read_tokens} ELSE 0 END)`,
    })
    .from(cam)
    .where(and(isNotNull(cam.user_id), sql`${cam.model} != ''`, gte(cam.occurred_at, Math.min(dayAgo, monthStart))))
    .groupBy(cam.user_id, cam.model);

  const perUser = new Map<string, { spend24: number; spendMonth: number }>();
  for (const r of rows) {
    const userId = r.user_id as string;
    const u = perUser.get(userId) ?? { spend24: 0, spendMonth: 0 };
    const s24 = priceTokens(r.model as string, {
      inputTokens: Number(r.inp24 ?? 0), outputTokens: Number(r.out24 ?? 0),
      cacheCreationTokens: Number(r.cw24 ?? 0), cacheReadTokens: Number(r.cr24 ?? 0),
    }, rates);
    const sM = priceTokens(r.model as string, {
      inputTokens: Number(r.inpM ?? 0), outputTokens: Number(r.outM ?? 0),
      cacheCreationTokens: Number(r.cwM ?? 0), cacheReadTokens: Number(r.crM ?? 0),
    }, rates);
    if (s24 !== null) u.spend24 += s24;
    if (sM !== null) u.spendMonth += sM;
    perUser.set(userId, u);
  }

  for (const [userId, { spend24, spendMonth }] of perUser) {
    if (spend24 <= dailyLimit) continue;
    const severity = spend24 > dailyLimit * 2 ? 'high' : 'medium';
    // One alert per person per 24 hours, except that an alert first raised as
    // medium steps up: once spend passes twice the limit inside those 24 hours
    // a high alert is raised, which the Slack sweep sends. Before this, the
    // hourly check caught most people just over the line (medium, not sent to
    // Slack) and the 24-hour dedup then hid them however high they went.
    const recent = await recentAlertSeverities('code_cost_spike', userId);
    if (recent.length > 0 && (severity !== 'high' || recent.includes('high'))) continue;
    // The person's name, never the raw id: Slack sends this text as stored.
    const who = await personLabel(userId);

    await insertAlert({
      id: uuidv4(),
      user_id: userId,
      alert_type: 'code_cost_spike',
      severity,
      title: `Claude Code spend over the daily limit: $${spend24.toFixed(2)} in 24h`,
      explanation: costSpikeExplanation({ who, spend24, windowEnd: now, monthToDate: spendMonth, dailyLimit }),
      raw_evidence: JSON.stringify({ source: 'code_pulse', user_id: userId, spend_24h: spend24, month_to_date: spendMonth, daily_limit_usd: dailyLimit }),
    });
  }
}

// ── code_model_policy ────────────────────────────────────────────────────────

async function checkModelPolicy(): Promise<void> {
  if ((await getConfigValue('codeAlertModelPolicyEnabled')) !== 'true') return;
  const allowlist = new Set(await jsonArray('codeModelAllowlist'));
  if (allowlist.size === 0) return; // empty allowlist = policy not configured

  const client = await getTypedClient();
  const cam = schema.codeAssistantMeta;
  const now = Math.floor(Date.now() / 1000);
  const rows = await client
    .selectDistinct({ user_id: cam.user_id, model: cam.model })
    .from(cam)
    .where(and(sql`${cam.model} != ''`, isNotNull(cam.user_id), gte(cam.occurred_at, now - DAY)));

  for (const r of rows) {
    const model = r.model as string;
    const userId = r.user_id as string;
    if (allowlist.has(model)) continue;
    const subject = `${userId}:${model}`;
    if (await recentlyAlerted('code_model_policy', subject)) continue;
    const who = await personLabel(userId);

    await insertAlert({
      id: uuidv4(),
      user_id: userId,
      alert_type: 'code_model_policy',
      severity: 'medium',
      title: `Non-approved model in Claude Code: ${model}`,
      explanation: `${who} used model "${model}", which is not on the approved model list.`,
      raw_evidence: JSON.stringify({ source: 'code_pulse', subject, user_id: userId, model }),
    });
  }
}

// ── code_repo_exposure ───────────────────────────────────────────────────────

async function checkRepoExposure(): Promise<void> {
  if ((await getConfigValue('codeAlertRepoExposureEnabled')) !== 'true') return;
  const patterns = (await jsonArray('codeSensitiveRepoPatterns')).map(p => p.toLowerCase());
  if (patterns.length === 0) return;

  const client = await getTypedClient();
  const css = schema.codeSessionStats;
  const now = Math.floor(Date.now() / 1000);
  const rows = await client
    .selectDistinct({ user_id: css.user_id, repo: css.repo })
    .from(css)
    .where(and(isNotNull(css.repo), gte(css.last_at, now - DAY)));

  for (const r of rows) {
    const repo = r.repo as string;
    const repoLc = repo.toLowerCase();
    if (!patterns.some(p => repoLc.includes(p))) continue;
    const subject = `repo:${repo}`;
    if (await recentlyAlerted('code_repo_exposure', subject)) continue;

    await insertAlert({
      id: uuidv4(),
      user_id: r.user_id ?? 'unknown',
      alert_type: 'code_repo_exposure',
      severity: 'high',
      title: `Claude Code active in sensitive repo: ${repo}`,
      explanation: `Claude Code session activity detected in "${repo}", which matches a sensitive-repository pattern.`,
      raw_evidence: JSON.stringify({ source: 'code_pulse', subject, repo, user_id: r.user_id }),
    });
  }
}

// ── code_friction ────────────────────────────────────────────────────────────

async function checkFriction(): Promise<void> {
  if ((await getConfigValue('codeAlertFrictionEnabled')) !== 'true') return;
  const threshold = await num('codeFrictionThreshold', 0.25);
  const minTools = 5;

  const client = await getTypedClient();
  const css = schema.codeSessionStats;
  const now = Math.floor(Date.now() / 1000);
  const rows = await client
    .select({
      session_id: css.session_id,
      user_id: css.user_id,
      repo: css.repo,
      error_count: css.error_count,
      tool_use_count: css.tool_use_count,
    })
    .from(css)
    .where(and(
      gte(css.last_at, now - DAY),
      gte(css.tool_use_count, minTools),
      sql`CAST(${css.error_count} AS REAL) / ${css.tool_use_count} > ${threshold}`,
    ));

  for (const r of rows) {
    const subject = `session:${r.session_id}`;
    if (await recentlyAlerted('code_friction', subject)) continue;

    await insertAlert({
      id: uuidv4(),
      user_id: r.user_id ?? 'unknown',
      alert_type: 'code_friction',
      severity: 'low',
      title: `High-friction Claude Code session${r.repo ? ` in ${r.repo}` : ''}`,
      explanation: `${r.error_count} of ${r.tool_use_count} tool actions failed (${Math.round((r.error_count / r.tool_use_count) * 100)}%). A coaching signal: the session may have fought tooling, permissions, or a confusing codebase.`,
      raw_evidence: JSON.stringify({ source: 'code_pulse', subject, session_id: r.session_id, repo: r.repo, errors: r.error_count, tools: r.tool_use_count }),
    });
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runCodePulseAlerts(): Promise<void> {
  try { await checkCostSpikes(); } catch (err) { console.error('[CodePulseAlerts] cost spike check failed:', err instanceof Error ? err.message : err); }
  try { await checkModelPolicy(); } catch (err) { console.error('[CodePulseAlerts] model policy check failed:', err instanceof Error ? err.message : err); }
  try { await checkRepoExposure(); } catch (err) { console.error('[CodePulseAlerts] repo exposure check failed:', err instanceof Error ? err.message : err); }
  try { await checkFriction(); } catch (err) { console.error('[CodePulseAlerts] friction check failed:', err instanceof Error ? err.message : err); }
}
