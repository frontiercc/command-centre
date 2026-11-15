// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// app/api/pulse/code/value/route.ts
// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table>.
// SUM aggregates are Number()-coerced (Postgres returns bigint and numeric as strings); the single-row code_metrics
// read coerces spend_usd (numeric on pg).
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, gte, isNotNull, ne, sql } from 'drizzle-orm';
import { getAdminSession, canAccessOrgOverview } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getAllConfig, getConfigValue } from '@/lib/config';
import { getCodeModelRates, priceTokens } from '@/lib/pulse/code/rates';
import { ORG_SCOPE_ID } from '@/lib/pulse/code/aggregator';
import { resolveCalibrations, calibrationValues, computeValueEstimate } from '@/lib/pulse/code/value';
import { computeObservedLift } from '@/lib/pulse/code/lift';
import { hasCodexData, readCodeMetrics } from '@/lib/pulse/code/vendor-view';
import { vendorClause } from '@/lib/dashboard/product-sql';
import { resolveTimeSavedAssumptions, computeTimeSaved } from '@/lib/pulse/code/time-saved';
import { codexSpend } from '@/lib/openai/spend';
import { visibleOpenAi, visibleVendor } from '@/lib/sources/openai-visibility';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canAccessOrgOverview(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const cfg = await getAllConfig();
  if (!cfg.codeValueEnabled) return NextResponse.json({ enabled: false }, { status: 200 });

  const client = await getTypedClient();
  const cam = schema.codeAssistantMeta;
  const cwMsg = schema.coworkMessages;

  const now = Math.floor(Date.now() / 1000);
  const d30 = now - 30 * 24 * 3600;
  const rates = await getCodeModelRates();

  // The All / Claude / Codex switch: Claude's view leaves Codex out, Codex's leaves Claude Code
  // (and the Claude Cowork and Claude Chat counts in Time saved) out. Codex sends no pull
  // requests or engaged time, so those, and the unit economics built on them, are not measured
  // on its view rather than 0.
  const vendor = await visibleVendor(request.nextUrl.searchParams.get('vendor'));
  const withClaude = vendor !== 'openai';

  // 30-day priced spend + active users, from code_assistant_meta (certain source).
  const spendRows = !withClaude ? [] : await client
    .select({
      user_id: cam.user_id,
      model: cam.model,
      inp: sql<number | string>`SUM(${cam.input_tokens})`,
      outp: sql<number | string>`SUM(${cam.output_tokens})`,
      cw: sql<number | string>`SUM(${cam.cache_creation_tokens})`,
      cr: sql<number | string>`SUM(${cam.cache_read_tokens})`,
    })
    .from(cam)
    .where(and(gte(cam.occurred_at, d30), ne(cam.model, ''), isNotNull(cam.user_id), ne(cam.user_id, '')))
    .groupBy(cam.user_id, cam.model);
  let spend30d = 0;
  const users = new Set<string>();
  for (const r of spendRows) {
    users.add(r.user_id as string);
    const usd = priceTokens(r.model as string, {
      inputTokens: Number(r.inp), outputTokens: Number(r.outp), cacheCreationTokens: Number(r.cw), cacheReadTokens: Number(r.cr),
    }, rates);
    if (usd !== null) spend30d += usd;
  }

  // Codex beside Claude Code once Codex data exists and ChatGPT and Codex are
  // shown: its turns priced from the same rates table (lib/openai/spend.ts),
  // and its commits from Developer Pulse's Codex view (code_metrics_vendor).
  const codexPresent = await hasCodexData();
  const codexShown = await visibleOpenAi(codexPresent);
  const withCodex = codexShown && vendor !== 'claude';
  const codex = withCodex ? await codexSpend({ since: d30 }, rates) : null;
  const codexSpend30d = codex ? (codex.turns === 0 ? 0 : codex.usd) : null;
  const totalSpend30d = spend30d + (codexSpend30d ?? 0);
  const annualSpendFromData = totalSpend30d * (365 / 30);
  // The from-data team covers the same tools as the spend: people with a
  // Claude Code model call or a Codex turn in the same 30 days, each counted once.
  const claudeCodeUsers = users.size;
  let codexUsers: number | null = null;
  if (withCodex) {
    const ct = schema.codexTurns;
    const codexUserRows = await client
      .selectDistinct({ user_id: ct.user_id })
      .from(ct)
      .where(and(gte(ct.started_at, d30), ne(ct.user_id, '')));
    for (const r of codexUserRows) users.add(r.user_id);
    codexUsers = codexUserRows.length;
  }

  // Measured productivity numbers from the latest org code_metrics row (same source as Overview).
  // Pull requests and engaged time are Claude Code's telemetry, so they read Claude Code's own row.
  const mRows = !withClaude ? [] : await readCodeMetrics('claude', codexPresent, (t, only) => client
    .select({
      spend_usd: t.spend_usd, commit_count: t.commit_count, pr_count: t.pr_count, session_count: t.session_count,
      active_time_user_s: t.active_time_user_s, active_time_cli_s: t.active_time_cli_s,
      period_start: t.period_start, period_end: t.period_end,
    })
    .from(t)
    .where(and(eq(t.scope_type, 'organisation'), eq(t.scope_id, ORG_SCOPE_ID), eq(t.granularity, 'rolling'), only))
    .orderBy(desc(t.computed_at))
    .limit(1));
  const m = mRows[0];
  const codexRows = withCodex
    ? await readCodeMetrics('openai', true, (t, only) => client
        .select({ commit_count: t.commit_count, session_count: t.session_count, spend_usd: t.spend_usd, period_start: t.period_start, period_end: t.period_end })
        .from(t)
        .where(and(eq(t.scope_type, 'organisation'), eq(t.scope_id, ORG_SCOPE_ID), eq(t.granularity, 'rolling'), only))
        .orderBy(desc(t.computed_at))
        .limit(1))
    : [];
  const codexCommitCount = withCodex ? (codexRows[0]?.commit_count ?? 0) : null;

  const commitCount = m?.commit_count ?? 0;
  // Claude Code's telemetry alone: not measured on the Codex view, never 0.
  const prCount = withClaude ? (m?.pr_count ?? 0) : null;
  const sessionCount = withClaude ? (m?.session_count ?? 0) : (codexRows[0]?.session_count ?? 0);
  const engagedHours = withClaude ? ((m?.active_time_user_s ?? 0) + (m?.active_time_cli_s ?? 0)) / 3600 : null;
  // Unit economics read one row's spend against the same row's output. Cost per commit and per
  // session read the view's own org row, as the Overview does: Claude Code plus Codex on All,
  // Claude Code's on Claude, Codex's on Codex. Cost per PR and per engaged hour read Claude
  // Code's row, as Codex sends no pull requests or engaged time.
  const viewRows = await readCodeMetrics(vendor, codexShown, (t, only) => client
    .select({ spend_usd: t.spend_usd, commit_count: t.commit_count, session_count: t.session_count })
    .from(t)
    .where(and(eq(t.scope_type, 'organisation'), eq(t.scope_id, ORG_SCOPE_ID), eq(t.granularity, 'rolling'), only))
    .orderBy(desc(t.computed_at))
    .limit(1));
  const viewRow = viewRows[0];
  const viewSpend = viewRow?.spend_usd !== null && viewRow?.spend_usd !== undefined ? Number(viewRow.spend_usd) : null;
  const viewCommits = viewRow?.commit_count ?? 0;
  const viewSessions = viewRow?.session_count ?? 0;
  const claudeSpend = withClaude && m?.spend_usd !== null && m?.spend_usd !== undefined ? Number(m.spend_usd) : null;
  const windowRow = m ?? codexRows[0];
  const metricsWindowDays = windowRow ? Math.max(1, Math.round((windowRow.period_end - windowRow.period_start) / (24 * 3600))) : null;

  const rawCfg = {
    codeValueLiftPct: await getConfigValue('codeValueLiftPct'),
    codeValueLoadedComp: await getConfigValue('codeValueLoadedComp'),
    codeValueCodingHrs: await getConfigValue('codeValueCodingHrs'),
    codeValueTeamSize: await getConfigValue('codeValueTeamSize'),
    codeValueAnnualSpend: await getConfigValue('codeValueAnnualSpend'),
  };
  const calibrations = resolveCalibrations(rawCfg, { activeUsers: users.size, annualSpend: annualSpendFromData });
  const estimate = computeValueEstimate(calibrationValues(calibrations));
  // Observed signal and Time saved count commits on the same basis as the Commits figure (Codex's when shown).
  // Claude Code only: the signal compares Claude Code's engaged time with its
  // commits, and Codex reports no engaged time to compare against.
  const observedLift = withClaude ? await computeObservedLift(codexPresent, false) : null;

  // Bottom-up Time Saved: measured 30d output counts × admin-editable minutes-per-task assumptions.
  // Claude Cowork sessions and Claude Chat conversations are Claude's, so the Codex view leaves them out.
  const coworkSessionRows = !withClaude ? [] : await client
    .select({ c: sql<number | string>`COUNT(DISTINCT ${cwMsg.session_id})` })
    .from(cwMsg)
    .where(and(
      sql`(${cwMsg.surface} = 'cowork' OR ${cwMsg.surface} IS NULL)`,
      // Claude Cowork only: ChatGPT prompts are stored as surface 'cowork' too.
      sql.raw(vendorClause('claude', 'cowork_messages.')),
      ne(cwMsg.session_id, ''), gte(cwMsg.occurred_at, d30),
    ));
  const coworkSessions = Number(coworkSessionRows[0]?.c ?? 0);

  const chatConversationRows = !withClaude ? [] : await client
    .select({ c: sql<number | string>`COUNT(DISTINCT ${cwMsg.session_id})` })
    .from(cwMsg)
    .where(and(eq(cwMsg.surface, 'chat'), sql.raw(vendorClause('claude', 'cowork_messages.')), ne(cwMsg.session_id, ''), gte(cwMsg.occurred_at, d30)));
  const chatConversations = Number(chatConversationRows[0]?.c ?? 0);

  const timeSavedAssumptions = resolveTimeSavedAssumptions({
    timeSavedMinPerPr: await getConfigValue('timeSavedMinPerPr'),
    timeSavedMinPerCommit: await getConfigValue('timeSavedMinPerCommit'),
    timeSavedMinPerCoworkSession: await getConfigValue('timeSavedMinPerCoworkSession'),
    timeSavedMinPerChatConversation: await getConfigValue('timeSavedMinPerChatConversation'),
  });
  const allCommitCount = commitCount + (codexCommitCount ?? 0);
  const timeSavedResult = computeTimeSaved({ prCount: prCount ?? 0, commitCount: allCommitCount, coworkSessions, chatConversations }, timeSavedAssumptions);
  // Each row carries its own measurement window: PR/commit counts come from the rolling
  // code_metrics row (metricsWindowDays, 30 days), while cowork/chat counts are queried over a fixed
  // 30d window (see d30 above). The window is attached per row, read from the row itself, so a
  // label can never claim a window its count was not drawn from.
  const ROW_WINDOW_DAYS: Record<string, number | null> = {
    'pull requests opened': metricsWindowDays,
    'AI-assisted commits': metricsWindowDays,
    'Cowork sessions': 30,
    'Chat conversations': 30,
  };
  const timeSaved = timeSavedResult.rows.length > 0
    ? {
        totalHours: timeSavedResult.totalHours,
        rows: timeSavedResult.rows.map(r => ({ ...r, windowDays: ROW_WINDOW_DAYS[r.label] ?? null })),
      }
    : null;

  return NextResponse.json({
    enabled: true,
    vendor,
    codexPresent: codexShown,
    // Claude Code and Codex apart, for the measured strip, on the All view; null while Codex is absent or hidden.
    split: codexShown && vendor === 'all' ? {
      claudeCode: { spend30d, commitCount, activeUsers: claudeCodeUsers },
      // People active in each tool; someone using both counts in each, once in measured.activeUsers.
      codex: { spend30d: codexSpend30d, commitCount: codexCommitCount, activeUsers: codexUsers, unpricedModels: codex?.unpricedModels ?? [] },
    } : null,
    calibrations,
    estimate,
    observedLift,
    timeSaved,
    measured: {
      // Claude Code plus Codex (when shown); cost per PR and per engaged hour below stay Claude Code's.
      spend30d: totalSpend30d,
      annualSpend: calibrations.annualSpend.value,
      // Claude Code's people plus Codex's on the All view, like the split under it; the from-data
      // Team size above still counts each person once, so the estimate does not grow with the tools.
      activeUsers: codexShown && vendor === 'all' && codexUsers !== null ? claudeCodeUsers + codexUsers : users.size,
      commitCount: allCommitCount,
      prCount, sessionCount, engagedHours,
      costPerCommit: viewSpend != null && viewCommits > 0 ? viewSpend / viewCommits : null,
      costPerPr: claudeSpend != null && prCount != null && prCount > 0 ? claudeSpend / prCount : null,
      costPerSession: viewSpend != null && viewSessions > 0 ? viewSpend / viewSessions : null,
      // §5c: spend per engaged hour — Claude Code's spend and engagedHours share the metrics window.
      costPerEngagedHour: claudeSpend != null && engagedHours != null && engagedHours > 0 ? claudeSpend / engagedHours : null,
      metricsWindowDays,
    },
  });
}
