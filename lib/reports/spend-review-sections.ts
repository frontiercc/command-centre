// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Deterministic Spend Review section for the report: who spends what on which
// kind of work, the better routes for each of the biggest spenders, the most
// efficient people, and (with the admin key) Anthropic limits and requests for
// more usage. Every number is rendered HERE and injected verbatim; the model
// never restates a figure. Names individuals: the section is
// admin and manager only, like FinOps.
//
// PERIOD: Spend Review works on a calendar month (UTC), so the section covers
// the month containing the report's END date and says so, as FinOps does.
import { buildSpendReviewIndex, buildSpendReview, priorPeriod, EFFICIENCY_MIN_SESSIONS, type SpendReviewIndex, type SpendReview, type ReviewRoute, type EfficiencyEntry } from '@/lib/finance/spend-review';
import { getSpendLimits, indexByEmail, primaryRow, shareUsed, NEAR_LIMIT_SHARE, type SpendLimitsSnapshot } from '@/lib/anthropic/spend-limits';
import { formatModelLabel } from '@/lib/pulse/code/model-label';
import { monthOf, periodMatchesMonth } from '@/lib/reports/finops-sections';
import { currentPeriod } from '@/lib/finance/period';
import { gapPct } from '@/lib/finance/spend-review-format';

/** The biggest spenders whose advice is spelled out person by person. */
export const REPORT_PEOPLE = 10;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function monthName(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
function usd(n: number): string {
  return n >= 100 ? `$${Math.round(n).toLocaleString('en-GB')}` : `$${n.toFixed(2)}`;
}
function pct(r: number | null): string {
  return r === null ? 'not measured' : `${Math.round(r * 100)}%`;
}
function model(m: string): string {
  return formatModelLabel(m).label;
}
/** Share of a month gone by at `nowMs` (1 for a month already over), so a month in progress is
 *  compared with last month at the same pace, as the Spend Review page does. */
export function monthElapsed(period: string, nowMs: number): number {
  const [y, m] = period.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1);
  const end = Date.UTC(y, m, 1);
  return Math.min(1, Math.max(0.01, (nowMs - start) / (end - start)));
}

function change(now: number, prior: number | null, pace: number): string {
  const against = pace < 1 ? "last month's pace" : 'last month';
  if (prior !== null) prior = prior * pace;
  if (prior === null || prior < 1) return 'new this month';
  const ratio = now / prior;
  if (ratio >= 3) return `${ratio.toFixed(1)} times ${against}`;
  const d = ratio - 1;
  return Math.abs(d) < 0.005 ? `flat on ${against}` : `${d > 0 ? 'up' : 'down'} ${Math.round(Math.abs(d) * 100)}% on ${against}`;
}

/** One plain sentence per suggestion. */
export function routeSentence(r: ReviewRoute): string {
  if (r.kind === 'tool') {
    return `use the ${r.name} ${r.toolType}: ${r.peerUsers} colleagues use it in ${pct(r.peerSessionShare)} of their sessions of this work`;
  }
  if (r.kind === 'context') {
    return `long conversations: ${pct(r.rereadShare)} of this cost is re-reading earlier conversation, against ${pct(r.peerRereadShare)} for colleagues; a fresh session for each new piece of work would cut it`;
  }
  const saving = r.estSavingUsd !== null ? `, about ${usd(r.estSavingUsd)}${r.savingShare !== null ? ` (${pct(r.savingShare)} of this work)` : ''} less at list price (estimate)` : '';
  if (r.direction === 'save') {
    return `save with ${model(r.toModel)} instead of ${model(r.fromModel)}: ${pct(r.priceRatio)} of the price per token, backed by ${r.to.sessions} colleague sessions of this work${saving}`;
  }
  if (r.direction === 'trial') {
    return `worth a trial: ${model(r.toModel)} at ${pct(r.priceRatio)} of ${model(r.fromModel)}'s price per token; too few colleagues use it for this work to show results${saving}`;
  }
  return `worth trying ${model(r.toModel)}: colleagues' sessions on it reach the outcome ${pct(r.to.rate)} of the time against ${pct(r.from.rate)}, over ${r.to.sessions} sessions, at ${r.priceRatio.toFixed(1)} times the price`;
}

export interface SpendReviewSectionInput {
  period: string;
  periodStart: string;
  periodEnd: string;
  index: SpendReviewIndex;
  reviews: SpendReview[];
  /** Anthropic limits, only for the current month. */
  limits: SpendLimitsSnapshot | null;
  /** Share of the month gone by (1 for a past month); changes are against last month at this pace. */
  pace?: number;
  /** The efficiency board shown, and its month: last month's while this month has nobody ranked yet. */
  board?: { rows: EfficiencyEntry[]; period: string };
}

/** Pure renderer: everything the section says comes from `input`. */
export function renderSpendReviewSection(input: SpendReviewSectionInput): string {
  const { index, reviews, period } = input;
  const s = index.summary;
  const pace = input.pace ?? 1;
  const board = input.board ?? { rows: index.efficiency, period };
  const out: string[] = [];
  out.push(`### Spend Review: ${monthName(period)}`);
  out.push(periodMatchesMonth(input.periodStart, input.periodEnd)
    ? `Figures cover ${monthName(period)}, measured by Command Centre from Code and Cowork telemetry (Chat is not included). Kind of work is AI-judged; savings are estimates at list price.`
    : `Spend Review works by calendar month, so these figures cover ${monthName(period)}, the month containing the report's end date, not the full report window. Measured by Command Centre from Code and Cowork telemetry (Chat is not included). Kind of work is AI-judged; savings are estimates at list price.`);

  if (index.people.length === 0) {
    out.push('No measured spend in this month.');
    return out.join('\n\n');
  }

  out.push('#### Where the money goes');
  const bullets = [
    `Total measured spend: **${usd(s.totalUsd)}**, ${change(s.totalUsd, s.priorTotalUsd, pace)}, across ${s.people} people.`,
    s.halfSpendPeople !== null ? `${s.halfSpendPeople} ${s.halfSpendPeople === 1 ? 'person accounts' : 'people account'} for half of it.` : null,
    s.topWork.length ? `Biggest kinds of work: ${s.topWork.map(w => `${w.label} (${w.surface === 'code' ? 'Code' : 'Cowork'}, ${pct(w.share)})`).join(', ')}.` : null,
    s.orgRereadShare !== null ? `${pct(s.orgRereadShare)} of the month's cost is Claude re-reading earlier conversation on every message.` : null,
  ].filter(Boolean) as string[];
  out.push(bullets.map(b => `- ${b}`).join('\n'));

  out.push('#### Biggest spenders');
  const top = [...index.people].sort((a, b) => b.totalUsd - a.totalUsd).slice(0, REPORT_PEOPLE);
  out.push(['| Person | Department | Spend | Main kind of work | Change | Suggestions |', '|---|---|---|---|---|---|',
    ...top.map(p => `| ${p.displayName} | ${p.department ?? '—'} | ${p.unpricedOnly ? 'not priced' : usd(p.totalUsd)} | ${p.mainWork ? `${p.mainWork.label} (${pct(p.mainWork.share)})` : '—'} | ${change(p.totalUsd, p.priorTotalUsd, pace)} | ${p.routeCount} |`),
  ].join('\n'));

  // Advice person by person, for the biggest spenders.
  const flagged = (r: SpendReview) => (r.scheduledTasks ?? []).filter(t => t.cheaperFamilies.length && t.costlyModel);
  const withAdvice = reviews.filter(r => r.work.some(w => w.routes.length) || flagged(r).length);
  if (withAdvice.length) {
    out.push('#### Better routes for the biggest spenders');
    out.push(withAdvice.map(r => {
      const lines = r.work.filter(w => w.routes.length).map(w => `  - ${w.label} (${pct(w.share)} of their spend, ${usd(w.spendUsd)}): ${w.routes.map(routeSentence).join('; ')}.`);
      for (const t of flagged(r)) {
        lines.push(`  - Scheduled task ${t.name} (${t.runs} runs, ${usd(t.spendUsd)}): runs unattended with ${t.costlyShare >= 0.995 && t.mainModel === t.costlyModel ? `all of its cost on ${model(t.costlyModel!)}` : `${pct(t.costlyShare)} of its cost on pricier models, mainly ${model(t.costlyModel!)}`}; routine work like this usually runs fine on ${t.cheaperFamilies.join(' or ')}.`);
      }
      return `- **${r.displayName}** (${usd(r.totals.totalUsd)})\n${lines.join('\n')}`;
    }).join('\n'));
  }

  // Totals across everyone reviewed.
  const all = reviews.flatMap(r => r.work.flatMap(w => w.routes.map(x => ({ person: r.displayName, x }))));
  const saves = all.filter(a => a.x.kind === 'model' && a.x.direction === 'save');
  const trials = all.filter(a => a.x.kind === 'model' && a.x.direction === 'trial');
  const sum = (xs: typeof all) => xs.reduce((t, a) => t + (a.x.kind === 'model' ? a.x.estSavingUsd ?? 0 : 0), 0);
  if (saves.length || trials.length) {
    const lines = [];
    if (saves.length) lines.push(`Proven cheaper models: ${new Set(saves.map(a => a.person)).size} of these people, about **${usd(sum(saves))}** in the month at list price (estimate).`);
    if (trials.length) lines.push(`Untested trials: ${new Set(trials.map(a => a.person)).size} of these people, up to about ${usd(sum(trials))} if the cheaper model does the job (estimate, untested here).`);
    out.push(lines.map(l => `- ${l}`).join('\n'));
  }

  if (board.rows.length) {
    out.push(`#### Most efficient in ${monthName(board.period)}`);
    if (board.period !== period) out.push(`Showing ${monthName(board.period)}: nobody has ${EFFICIENCY_MIN_SESSIONS} sessions in ${monthName(period)} yet, which the comparison needs to be fair.`);
    out.push('Typical session cost against colleagues doing the same kinds of work, weighted by where each person\'s money goes; ranked only when their share of Tier 3 work is within 10 points of colleagues\'.');
    out.push(['| | Person | Department | Cost vs colleagues | Sessions | Tier 3 (vs colleagues) |', '|---|---|---|---|---|---|',
      ...board.rows.map((e, i) => `| ${i + 1} | ${e.displayName} | ${e.department ?? '—'} | ${gapPct(e.vsColleagues)} below | ${e.sessions} | ${pct(e.deepRate)} vs ${pct(e.peerDeepRate)} |`),
    ].join('\n'));
  }

  // Anthropic limits (current month, admin key with read:spend_limits).
  if (input.limits && input.limits.status === 'ok') {
    const { members, requests } = indexByEmail(input.limits);
    const rows = [...members.values()].map(m => ({ m, row: primaryRow(m) })).filter(x => x.row && x.row.limit !== null);
    const over = rows.filter(x => (shareUsed(x.row) ?? 0) >= 1);
    const near = rows.filter(x => { const v = shareUsed(x.row) ?? 0; return v >= NEAR_LIMIT_SHARE && v < 1; });
    out.push('#### Anthropic spend limits');
    out.push([
      `- Over their limit: ${over.length ? over.map(x => `${x.m.name ?? x.m.email} (${usd(x.row!.spend)} of ${usd(x.row!.limit!)})`).join(', ') : 'nobody'}.`,
      `- At ${Math.round(NEAR_LIMIT_SHARE * 100)}% or more: ${near.length ? near.map(x => `${x.m.name ?? x.m.email} (${pct(shareUsed(x.row))})`).join(', ') : 'nobody'}.`,
      `- Pending requests for more usage: ${requests.size ? [...requests.values()].map(r => r.name ?? r.email).join(', ') : 'none'}.`,
      '- Reported by Anthropic, covering every surface including Chat.',
    ].join('\n'));
  }
  return out.join('\n\n');
}

/** Build the section. Reads only. */
export async function buildSpendReviewSection(periodStart: string, periodEnd: string): Promise<string> {
  const period = monthOf(periodEnd);
  const index = await buildSpendReviewIndex(period);
  const top = [...index.people].filter(p => !p.unpricedOnly).sort((a, b) => b.totalUsd - a.totalUsd).slice(0, REPORT_PEOPLE);
  const reviews: SpendReview[] = [];
  for (const p of top) reviews.push(await buildSpendReview(p.userId, period));
  const nowMs = Date.now();
  const isCurrent = period === currentPeriod(Math.floor(nowMs / 1000));
  const limits = isCurrent ? await getSpendLimits() : null;
  // As on the page: early in a month nobody has enough sessions to rank, so show last month's board.
  let board = { rows: index.efficiency, period };
  if (isCurrent && board.rows.length === 0) {
    const prior = priorPeriod(period);
    const priorIndex = await buildSpendReviewIndex(prior);
    if (priorIndex.efficiency.length) board = { rows: priorIndex.efficiency, period: prior };
  }
  return renderSpendReviewSection({ period, periodStart, periodEnd, index, reviews, limits, pace: isCurrent ? monthElapsed(period, nowMs) : 1, board });
}
