// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { getCodeWorkTypeLabeller } from '@/lib/pulse/code/tier-config';
import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, logError } from '@/lib/api/errors';
import { aiFailureOptions, createGroundedJson, pctChange, pctOf, type GroundedShape } from '@/lib/anthropic/grounded-json';
import { tightenRecommendation } from '@/lib/anthropic/recommendation-text';
import { trimDashboardBriefing } from '@/lib/anthropic/dashboard-briefing-trim';
import { createAnthropicClient } from '@/lib/anthropic/client';
import { getCoreAiModel } from '@/lib/anthropic/model';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { getConfigValue, getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessCorePlatform } from '@/lib/auth/admin-auth';
import { listUseCases } from '@/lib/usecases/queries';
import { listOpenDeptBoxes } from '@/lib/usecases/suggestion-store';
import { logAccess } from '@/lib/audit/log';
import {
  getActiveUsersThisWeek,
  getActiveUsersLastWeek,
  getOpenAlertCount,
  getOpenAlertsBySeverity,
  getCoworkSessionCountThisWeek,
  getSurfaceBreakdown,
  getRecentAlerts,
  getSnapshotsForPeriod,
  getUserCount,
} from '@/lib/db/queries';
import { isOtelConfigured } from '@/lib/config';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { ORG_SCOPE_ID } from '@/lib/pulse/code/aggregator';

// Disable Next.js route caching — all API routes read live data from the database
export const dynamic = 'force-dynamic';

// In-memory briefing cache — avoids an API call on every page load
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let briefingCache: { data: unknown; generatedAt: number } | null = null;

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // The org-wide briefing sits on the Dashboard — same roles as the Dashboard.
  if (!canAccessCorePlatform(session.role)) {
    await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'ai/briefing', action: 'READ', outcome: 'denied' });
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'ai/briefing', action: 'READ', outcome: 'success' });
  const apiKey = await getConfigValue('anthropicAiApiKey');
  if (!apiKey) {
    return NextResponse.json({ error: 'No AI API key configured' }, { status: 400 });
  }

  // Return cached briefing if fresh and not a forced refresh
  const force = request.nextUrl.searchParams.get('force') === '1';
  if (!force && briefingCache && (Date.now() - briefingCache.generatedAt) < CACHE_TTL_MS) {
    return NextResponse.json({ ...briefingCache.data as Record<string, unknown>, cached: true, generatedAt: briefingCache.generatedAt });
  }

  // Gather all context
  const [activeThisWeek, activeLastWeek, totalUsers, openAlerts, alertsBySeverity, recentAlerts, coworkSessions] = await Promise.all([
    getActiveUsersThisWeek(),
    getActiveUsersLastWeek(),
    getUserCount(),
    getOpenAlertCount(),
    getOpenAlertsBySeverity(),
    getRecentAlerts(10),
    getCoworkSessionCountThisWeek(),
  ]);
  const otelConfigured = await isOtelConfigured();
  const [surface, snapshots] = await Promise.all([
    getSurfaceBreakdown(),
    getSnapshotsForPeriod(7),
  ]);

  // Read the organisation's Acceptable Use Policy if configured
  const aup = await getConfigValue('acceptableUsePolicy');

  // Use Cases: adoption-programme lifecycle rollup, only when the feature is
  // switched on. When the flag is off this stays null and neither the data
  // context nor the system prompt mention use cases at all (dormant-invisible,
  // mirroring the AUP block below).
  const allCfg = await getAllConfig();
  const useCasesEnabled = allCfg.useCasesEnabled === true;
  let useCases: {
    declared: number; adopted: number; piloting: number; atRisk: number; notSeen: number;
    strategicBets: number; strategicUnhealthy: number;
    adoptedTitles: string[]; atRiskTitles: string[];
    deptOpportunities?: Array<{ department: string; count: number }>;
  } | null = null;
  if (useCasesEnabled) {
    const active = (await listUseCases()).filter(u => u.status !== 'archived');
    const inLifecycle = (l: string) => active.filter(u => u.lifecycle === l);
    const adopted = inLifecycle('adopted');
    const atRisk = inLifecycle('at_risk');
    // A "bet" is a strategic + confirmed use case (matches the governance rollup).
    const bets = active.filter(u => u.strategic === 1 && u.status === 'confirmed');
    useCases = {
      declared: active.length,
      adopted: adopted.length,
      piloting: inLifecycle('piloting').length,
      atRisk: atRisk.length,
      notSeen: inLifecycle('not_seen').length,
      strategicBets: bets.length,
      strategicUnhealthy: bets.filter(u => u.lifecycle === 'at_risk' || u.lifecycle === 'not_seen').length,
      adoptedTitles: adopted.slice(0, 5).map(u => u.title),
      atRiskTitles: atRisk.slice(0, 5).map(u => u.title),
    };
    // Open department process opportunities — measured counts only (the mined
    // titles/stories are model-authored and never feed another model). Same
    // gate as the tray/act-next boxes: the content switch governs both lanes.
    if (allCfg.useCasesSuggestUseContent === 'true') {
      try {
        const boxes = await listOpenDeptBoxes();
        if (boxes.length > 0) {
          useCases.deptOpportunities = boxes.map(b => ({ department: b.department, count: b.suggestions.length }));
        }
      } catch { /* contributes nothing */ }
    }
  }

  // Developer Pulse: deterministic engineering telemetry (7-day org snapshot) plus
  // the AI-judged work mix when the session classifier is enabled.
  // Time comes from the app clock.
  const client = await getTypedClient();
  const nowS = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = nowS - 7 * 86400;

  const codeMetricsRows = await client
    .select({
      spend_usd: schema.codeMetrics.spend_usd,
      input_tokens: schema.codeMetrics.input_tokens,
      output_tokens: schema.codeMetrics.output_tokens,
      autonomy_ratio: schema.codeMetrics.autonomy_ratio,
      cache_hit_ratio: schema.codeMetrics.cache_hit_ratio,
      session_count: schema.codeMetrics.session_count,
      repo_count: schema.codeMetrics.repo_count,
      commit_count: schema.codeMetrics.commit_count,
    })
    .from(schema.codeMetrics)
    .where(and(
      eq(schema.codeMetrics.scope_type, 'organisation'),
      eq(schema.codeMetrics.scope_id, ORG_SCOPE_ID),
      eq(schema.codeMetrics.granularity, 'rolling'),
    ))
    .orderBy(desc(schema.codeMetrics.computed_at))
    .limit(1);
  const codeMetricsRaw = codeMetricsRows[0];
  // spend_usd is numeric() on pg -> comes back as a STRING (Postgres returns bigint and numeric as strings).
  // Rounded to cents, as the Code briefing does, so the model never quotes $2337.7414230499985.
  const codeMetrics = codeMetricsRaw
    ? { ...codeMetricsRaw, spend_usd: codeMetricsRaw.spend_usd !== null ? Math.round(Number(codeMetricsRaw.spend_usd) * 100) / 100 : null }
    : null;

  const codeLabel = await getCodeWorkTypeLabeller();
  const codeWorkMix = await getConfigValue('codeClassifierEnabled') !== 'false'
    ? (await client
        .select({ work_type: schema.codeSessionClassifications.work_type, sessions: sql<number | string>`COUNT(*)` })
        .from(schema.codeSessionClassifications)
        .innerJoin(schema.codeSessionStats, eq(schema.codeSessionStats.session_id, schema.codeSessionClassifications.session_id))
        .where(and(eq(schema.codeSessionClassifications.status, 'classified'), gte(schema.codeSessionStats.last_at, sevenDaysAgo)))
        .groupBy(schema.codeSessionClassifications.work_type)
        .orderBy(desc(sql`COUNT(*)`))
      ).map(r => ({ work_type: codeLabel(r.work_type), sessions: Number(r.sessions) }))
    : null;

  const sevenDaysAgoDateStr = new Date(sevenDaysAgo * 1000).toISOString().slice(0, 10);
  const githubRows = await client
    .select({ c: sql<number | string>`COALESCE(SUM(${schema.githubRepoStats.commit_count}), 0)` })
    .from(schema.githubRepoStats)
    .where(gte(schema.githubRepoStats.date, sevenDaysAgoDateStr));
  const githubCommits7d = Number(githubRows[0]?.c ?? 0);

  // Work Pulse: judged tier mix over the last 7 days + confirmed capabilities
  const coworkTiersRows = await client
    .select({
      tier1: sql<number | string>`SUM(CASE WHEN ${schema.pulseClassifications.tier} = 1 THEN 1 ELSE 0 END)`,
      tier2: sql<number | string>`SUM(CASE WHEN ${schema.pulseClassifications.tier} = 2 THEN 1 ELSE 0 END)`,
      tier3: sql<number | string>`SUM(CASE WHEN ${schema.pulseClassifications.tier} = 3 THEN 1 ELSE 0 END)`,
    })
    .from(schema.pulseClassifications)
    .innerJoin(schema.coworkMessages, eq(schema.coworkMessages.id, schema.pulseClassifications.cowork_message_id))
    .where(and(eq(schema.pulseClassifications.classifier_status, 'classified'), gte(schema.coworkMessages.occurred_at, sevenDaysAgo)));
  const coworkTiersRaw = coworkTiersRows[0];
  const coworkTiers = {
    tier1: coworkTiersRaw?.tier1 !== null && coworkTiersRaw?.tier1 !== undefined ? Number(coworkTiersRaw.tier1) : null,
    tier2: coworkTiersRaw?.tier2 !== null && coworkTiersRaw?.tier2 !== undefined ? Number(coworkTiersRaw.tier2) : null,
    tier3: coworkTiersRaw?.tier3 !== null && coworkTiersRaw?.tier3 !== undefined ? Number(coworkTiersRaw.tier3) : null,
  };

  const capabilitiesConfirmedRows = await client
    .select({ c: sql<number | string>`COUNT(*)` })
    .from(schema.pulseEvents)
    .where(and(eq(schema.pulseEvents.event_type, 'capability_creation'), eq(schema.pulseEvents.status, 'confirmed')));
  const capabilitiesConfirmed = Number(capabilitiesConfirmedRows[0]?.c ?? 0);

  // Changes and shares worked out here, so the model never calculates a figure.
  const aiShare = codeMetrics && githubCommits7d > 0 ? pctOf(Number(codeMetrics.commit_count ?? 0), githubCommits7d) : null;
  const derived = {
    activeUsersChangeVsLastWeek: pctChange(Number(activeThisWeek), Number(activeLastWeek)) ?? undefined,
    aiAssistedShareOfShippedCommits: aiShare !== null && aiShare <= 100 ? `${aiShare}%` : undefined,
  };

  const dataContext = JSON.stringify({
    derived,
    coworkPulse: {
      tierMixThisWeek: { tier1: coworkTiers.tier1 ?? 0, tier2: coworkTiers.tier2 ?? 0, tier3: coworkTiers.tier3 ?? 0 },
      capabilitiesConfirmedTotal: capabilitiesConfirmed,
    },
    codePulse: codeMetrics ? {
      sevenDay: codeMetrics,
      workMixAiJudged: codeWorkMix,
      githubTotalCommitsInMappedRepos: githubCommits7d > 0 ? githubCommits7d : undefined,
    } : null,
    ...(useCases ? { useCases } : {}),
    activeThisWeek, activeLastWeek, totalUsers,
    openAlerts, alertsBySeverity, coworkSessions, otelConfigured,
    surfaceBreakdown: surface,
    recentAlerts: recentAlerts.map(a => ({ severity: a.severity, title: a.title, type: a.alert_type, status: a.status })),
    snapshotSummary: {
      totalSnapshots: snapshots.length,
      uniqueUsers: new Set(snapshots.map(s => s.user_id)).size,
      totalMessages: snapshots.reduce((s, r) => s + r.messages_sent, 0),
      totalCodeCommits: snapshots.reduce((s, r) => s + r.code_commits, 0),
    },
  }, null, 2);

  try {
    // Every number in the model's text must come from the data or the prompt
    // (its own risk_score excepted); one retry, then GroundingRejectedError.
    const { value: grounded } = await createGroundedJson({
      client: createAnthropicClient(apiKey),
      // The Core AI model, chosen in Admin. No temperature: newer models refuse it.
      model: await getCoreAiModel(),
      maxTokens: 4000, // room for six recommendations
      ...DASHBOARD_BRIEFING_SHAPE,
      system: `You are the AI intelligence layer of Frontier Command Centre, a governance dashboard for an organisation's use of Claude. You write for IT leads and team managers at organisations rolling out Claude. You are concise, helpful, and proportionate.

WRITING STYLE (mandatory):
- Use British English spelling throughout (e.g. organisation, behaviour, categorise, licence, colour).
- All money in the data is in US dollars: always write it with a dollar sign (for example $1,917), never £ or €.
- Use British punctuation conventions (single quotes for speech, logical comma placement).
- NEVER use em dashes (—) or en dashes (–). Use commas, colons, semicolons, or full stops instead.
- Plain business language only. This rule is absolute: NEVER put an internal metric name or jargon phrase in the output. Banned phrases include (not limited to) "autonomy ratio", "DDS", "OTI", "ORS", "cache hit ratio", "tier 1/2/3", "tool actions per instruction".
- Describe EVERY surface (Cowork, Code, and, when enabled, Chat) the same way: by concrete measured activity in plain words. Lead with things a manager can picture (sessions run, commits shipped, capabilities confirmed, flags raised, users active) and treat cost as context. NEVER present an internal ratio or score as a headline measure (no "autonomy ratio", no "N tool actions per instruction", no numeric scores). If you describe how deep, autonomous, or sophisticated the work is, say it in plain words and attribute anything Claude judged (e.g. "work Claude judged to be mostly routine admin, with a growing share of multi-step tasks"). Never use tier numbers. Say "routine admin tasks / multi-step work / high-stakes autonomous work". For efficiency, say "most context is reused, keeping costs down" NOT "cache hit ratio of 83%".

TONE CALIBRATION (this is critical):
- You are a helpful advisor, NOT a threat detection system.
- Match your tone to the deployment stage. 3 users in week one is a pilot, not a crisis.
- PII flags are informational: they mean "someone typed something that looks like personal data". This is expected, normal behaviour. Flag it for awareness, don't treat it as a breach.
- A single PII flag does not warrant "high severity" language. It's a nudge to set up guidelines.
- Recommendations should be practical next steps, not emergency actions. "Consider adding a data handling reminder to onboarding" not "Address PII exposure immediately".
- Only use "high" priority for things that genuinely need urgent attention (actual credential exposure, a real policy violation, a user exfiltrating data at scale).

ALERT TYPE UNDERSTANDING. There are three distinct alert types you will see in the data:
- "policy" alerts: PII or credential detection. Regex matched sensitive data patterns (credit cards, API keys, SSNs, etc.) in a message. These are data presence alerts.
- "intent" alerts: Behavioural intent detection. The system detected a user requesting something risky (e.g. "extract all contacts from Salesforce", "bypass authentication", "delete all records"). These are AI-assessed with a severity and reasoning. Intent alerts indicate what someone asked Claude to do, not what data was present.
- "anomaly" alerts: AI-detected unusual usage patterns from scheduled analysis.

When discussing alerts, differentiate clearly:
- For "policy" (PII) alerts: advise on data handling guidelines, credential hygiene, and awareness training.
- For "intent" alerts: advise on reviewing the specific request in context. Many intent flags are legitimate developer work (discussing database schemas, testing access controls). Focus on whether the pattern suggests unauthorised activity, not just that a phrase was matched. Recommend reviewing the AI reasoning in the alert detail. Suggest refining custom intent categories if false positives are high.
- For "anomaly" alerts: advise on the specific behavioural pattern detected.
- NEVER suggest the detection system "needs calibration" or "may need tuning" unless false positive rates are genuinely high. The system is working as designed.
- NEVER lump all alerts together. Break down your analysis by alert type so the admin knows which are PII concerns vs behavioural intent vs anomalies.

RISK SCORE CALIBRATION:
- 0-20 (low): Everything is fine. Normal usage, no flags, good adoption trajectory.
- 21-40 (moderate): Minor items to note. A few PII flags, some users not yet onboarded. Normal early-stage stuff.
- 41-60 (elevated): Real issues worth attention. Multiple unresolved alerts, declining adoption, or repeated policy concerns.
- 61-80 (high): Genuine problems. Systematic policy violations, credential exposure, or significant governance gaps with real consequences.
- 81-100 (critical): Actual incidents. Active data breach, widespread misuse, or compliance failures requiring immediate action.
- For context: a pilot deployment with 3 users and a couple of PII flags should typically score 15-30, not 60+.

Return a JSON object with exactly these fields:
{
  "briefing": "4-6 sentences. ONE executive narrative covering the whole platform, in this order of usefulness: (1) adoption and governance state from Command Centre, with alerts by type, proportionate; (2) Cowork: sessions run and capabilities confirmed, plus in plain words how the character of knowledge work is shifting (attribute the judged part); (3) Code: engineering scale and shipping (sessions run and commits made in Claude sessions), with cost as context. Weave them into one story, do not write three labelled sections. British English. Conversational but professional.",
  "risk_score": <number 0-100>,
  "risk_label": "low" | "moderate" | "elevated" | "high" | "critical",
  "risk_reasoning": "1-2 sentences explaining the score. Be proportionate. Reference specific data points.",
  "recommendations": [
    {
      "priority": "high" | "medium" | "low",
      "title": "3-7 words, action-oriented",
      "detail": "EXACTLY 2 short sentences, 30 words at most in total: first what is happening, then what to do. Only use a number if it appears in the data exactly; never count or total anything yourself. No preamble, no hedging. Frame as improvements not emergencies.",
      "category": "security" | "adoption" | "governance" | "efficiency" | "intent"${useCases ? ' | "use_case"' : ''}
    }
  ],
  "adoption_headline": "EXACTLY ONE short sentence on adoption momentum with a number. Do not repeat a fact already in the briefing text; no advice."
}

COWORK TERMINOLOGY:
- "coworkSessions" is the count of distinct Cowork work sessions this week (each session = one conversation context in Claude). Always refer to this as "sessions", never "events". Individual messages within sessions are not counted here.
- The dashboard stat card shows this number as "Cowork Sessions". Use that same label when referencing it.

WORK PULSE (CLAUDE COWORK) DATA UNDERSTANDING:
- Report Cowork by concrete activity first: coworkSessions (sessions run this week) and coworkPulse.capabilitiesConfirmedTotal (new processes Claude now handles end-to-end, confirmed by a human; this is Cowork's "shipping" signal).
- coworkPulse.tierMixThisWeek is an AI-JUDGED read of the work's character: mostly routine admin tasks, meaningful multi-step / connector-assisted work, or high-stakes autonomous work. Use it only to describe in plain words how the character of work is shifting, always attributed ("work Claude judged to be…"). Never quote tier numbers, a score, or the phrase "DDS".

DEVELOPER PULSE (CLAUDE CODE) DATA UNDERSTANDING:
- Report Code by concrete activity: session_count (code sessions this week), commit_count (git commits shipped inside Claude sessions, Code's "shipping" signal), repo_count, and spend_usd (cost, as context not a verdict).
- codePulse.sevenDay also carries internal efficiency signals (autonomy_ratio and cache_hit_ratio) that are NOT measures to report. Do NOT put them, or any per-instruction / tool-count figure, in the narrative. At most describe efficiency in plain words ("most context is reused, keeping costs down"). Never say "autonomy ratio", "tool actions per instruction", or "cache hit ratio".
- codePulse.workMixAiJudged is an AI judgement of what kind of work the sessions were. When you cite it, attribute it (e.g. "sessions Claude judged to be mostly exploration"). All other codePulse numbers are measured, not judged.
- codePulse.githubTotalCommitsInMappedRepos, when present, is the total commits shipped in GitHub repos mapped for the overlay; derived.aiAssistedShareOfShippedCommits, when present, is the AI-assisted share of that shipping.

NUMBERS (mandatory): use only numbers that appear in the data, exactly as written (rounding is fine). Never calculate a new figure: no sums, differences, ratios or percentages of your own. Every change or share you may need is already in "derived" (e.g. activeUsersChangeVsLastWeek). The only number you author yourself is risk_score.
- Spend is context, not a verdict: rising spend with rising delegation and commits is healthy; rising spend without them is worth a look.

Return exactly 6 recommendations (the dashboard shows them as two rows of three). Do not manufacture concerns. If things are genuinely fine, say so and focus recommendations on growth and efficiency rather than inventing risks.
NEVER recommend configuring OpenTelemetry, observability, or telemetry setup. This is handled by the collector setup and is not a user action.
${useCases ? `
USE CASES DATA UNDERSTANDING (adoption programme):
The organisation has declared specific AI use cases and Command Centre tracks whether each is actually live in real telemetry. The "useCases" object carries a measured lifecycle rollup:
- "declared" = how many use cases are being tracked (non-archived). Each sits in one measured lifecycle: "adopted" (in regular use by several people), "piloting" (some early activity), "atRisk" (was seen, now gone quiet) or "notSeen" (declared but no matching activity yet). These are MEASURED from telemetry, not judged.
- Weave ONE plain sentence into the briefing narrative about how the declared use cases are landing: how many are in regular use, and name any that are newly adopted ("adoptedTitles") or that have gone quiet ("atRiskTitles"). Use the titles verbatim, as they are the organisation's own labels. Example: "Of nine declared use cases, five are now in regular use, including Monthly budget reconciliation; Contract review has gone quiet and is worth a nudge."
- "strategicBets" = use cases leadership flagged as strategic priorities; "strategicUnhealthy" = how many of those are at risk or not yet seen. A strategic bet that is not landing is a legitimate, proportionate reason to raise a "use_case" recommendation (suggest the owner review adoption or run a short enablement session). Do NOT treat quiet use cases as a security or risk concern.
- "deptOpportunities" (when present) = open department process opportunities Command Centre has drafted from the organisation's own activity, awaiting human review on the Use Cases register. The counts and department names are MEASURED. Weave in at most one sentence saying how many are open and where they concentrate; never invent their names or contents, and never treat them as risks.
- If "declared" is 0, do not mention use cases at all.
` : ''}${aup ? `
ACCEPTABLE USE POLICY:
The organisation has defined the following Acceptable Use Policy. Use it to make your briefing and recommendations more specific and relevant. Reference the policy when flagged activity relates to it (e.g. "Your AUP restricts sharing customer data, and this week's PII flags may relate to that guideline"). Do not quote the policy verbatim; summarise or reference it naturally.

<acceptable-use-policy>
${aup}
</acceptable-use-policy>
` : ''}
IMPORTANT: Return ONLY valid JSON. No markdown, no code fences.`,
      userMessage: `Here is the current organisational data:\n\n${dataContext}`,
    });

    // Keep each recommendation to two short sentences (the prompt asks; this guarantees it).
    // Trimming only removes text, so everything kept has already passed the number check.
    const result = {
      ...grounded,
      recommendations: grounded.recommendations.map(r => ({ ...r, detail: r.detail ? tightenRecommendation(r.detail) : r.detail })),
    };

    // Cache the result for subsequent requests
    const now = Date.now();
    briefingCache = { data: result, generatedAt: now };

    return NextResponse.json({ ...result, cached: false, generatedAt: now });
  } catch (err) {
    // Keep showing the last good briefing, dated, rather than an error. The
    // cache is in memory only, so after a restart there may be none to show.
    if (briefingCache) {
      logError('AI Briefing', err);
      return NextResponse.json({ ...briefingCache.data as Record<string, unknown>, cached: true, stale: true, generatedAt: briefingCache.generatedAt });
    }
    return errorResponse('AI Briefing', err, aiFailureOptions(err));
  }
}

type DashboardBriefing = {
  briefing: string;
  risk_score: number;
  risk_label: string;
  risk_reasoning?: string;
  recommendations: Array<{ priority?: string; title?: string; detail?: string; category?: string }>;
  adoption_headline?: string;
};

const DASHBOARD_BRIEFING_SHAPE: GroundedShape<DashboardBriefing> = {
  parse: (obj) => {
    const o = obj as DashboardBriefing;
    if (!o || typeof o.briefing !== 'string' || typeof o.risk_score !== 'number' || !Array.isArray(o.recommendations)) {
      throw new Error('dashboard briefing shape');
    }
    return o;
  },
  texts: (v) => [
    v.briefing, v.risk_reasoning ?? '', v.adoption_headline ?? '',
    ...v.recommendations.flatMap(r => [r.title ?? '', r.detail ?? '']),
  ],
  extraAllowed: (v) => [v.risk_score],
  // After two refusals, drop only what carries an unchecked number (rechecked before use).
  trim: (v, isClean) => trimDashboardBriefing(v, isClean),
};
