// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Deterministic FinOps section for the governance report. Mirrors the shape of
// compliance-sections.ts: every number is rendered HERE, in code, and the
// generator injects the finished markdown with "include EXACTLY as provided,
// do not modify" — the model never restates a figure.
//
// PERIOD NOTE: the chargeback engine is keyed on a CALENDAR MONTH ('YYYY-MM')
// because that is the unit finance bills on, and closed periods store an
// immutable snapshot against it. Reports run over an arbitrary start/end. We
// therefore resolve the month containing the report's END date and say so in
// the output rather than silently implying the figures match the report window.
import { buildChargeback, type ChargebackReport, type SurfaceSpend } from '@/lib/finance/chargeback';
import { buildModelEfficiency, type ModelEfficiencyReport } from '@/lib/finance/model-efficiency';

/** `YYYY-MM` for the month containing an ISO date string. */
export function monthOf(isoDate: string): string {
  const d = new Date(isoDate);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Whether the report window sits entirely inside the resolved month. */
export function periodMatchesMonth(periodStart: string, periodEnd: string): boolean {
  return monthOf(periodStart) === monthOf(periodEnd);
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Null renders as an em-less "not measured" — never a fabricated $0. */
function usdOrNone(n: number | null): string {
  return n === null ? 'not measured' : usd(n);
}

function pct(ratio: number | null): string {
  return ratio === null ? 'not measured' : `${Math.round(ratio * 100)}%`;
}

function tokens(n: number): string {
  return n.toLocaleString('en-GB');
}

function surfaceLine(label: string, s: SurfaceSpend): string {
  const total = s.tokens.input + s.tokens.output + s.tokens.cacheWrite + s.tokens.cacheRead;
  if (s.basis === 'dormant') {
    return `| ${label} | not captured on this deployment | — |`;
  }
  const spend = s.usd === null ? 'not measured' : usd(s.usd);
  const suffix = s.basis === 'estimate' ? ' (estimated)' : '';
  return `| ${label} | ${spend}${suffix} | ${tokens(total)} |`;
}

function costCentreTable(report: ChargebackReport): string {
  if (report.costCentres.length === 0) {
    return 'No cost centres are configured. All spend appears under Unallocated.';
  }
  const rows = report.costCentres
    .map(c => `| ${c.name} | ${c.code ?? '—'} | ${usd(c.totalUsd)} | ${usd(c.codeUsd)} | ${usd(c.coworkUsd)} |`)
    .join('\n');
  return `| Cost centre | GL code | Total | Code | Cowork |
|---|---|---|---|---|
${rows}`;
}

function modelEfficiencyBlock(label: string, r: ModelEfficiencyReport): string {
  if (!r.hasData) {
    return `**${label}:** no priced activity in this period.`;
  }
  const topModels = r.spendByModel
    .slice(0, 5)
    .map(m => `- ${m.model}: ${usd(m.spendUsd)} (${tokens(m.tokens)} tokens)`)
    .join('\n');

  const c = r.costByType;
  return `**${label}**

Spend by model (priced models only):
${topModels}

Cost by token class: input ${usd(c.inputUsd)}, output ${usd(c.outputUsd)}, cache write ${usd(c.cacheWriteUsd)}, cache read ${usd(c.cacheReadUsd)}${c.unclassifiedUsd > 0 ? `, unclassified ${usd(c.unclassifiedUsd)}` : ''}.

Cache efficiency: ${pct(r.cacheEfficiency.ratio)} of input-side tokens served from cache.`;
}

function dataQualityNotes(report: ChargebackReport, effs: ModelEfficiencyReport[]): string {
  const notes: string[] = [];

  if (report.estimated) {
    notes.push(
      '- Some spend is **estimated**: provider-decorated model IDs (Bedrock or Vertex) are priced at Anthropic list rates, which differ from actual provider billing. Treat these figures as visibility, not billing.',
    );
  }

  const unpriced = new Set<string>([...report.unpricedModels, ...effs.flatMap(e => e.unpricedModels)]);
  if (unpriced.size > 0) {
    notes.push(
      `- ${unpriced.size} model${unpriced.size === 1 ? '' : 's'} in use ${unpriced.size === 1 ? 'has' : 'have'} no configured rate and ${unpriced.size === 1 ? 'is' : 'are'} excluded from spend rather than counted as zero: ${[...unpriced].join(', ')}.`,
    );
  }

  const cov = report.coworkCostCoverage;
  if (cov.total > 0 && cov.withCost < cov.total) {
    notes.push(
      `- Cowork cost coverage is ${cov.withCost} of ${cov.total} records; the remainder carry no cost value and contribute nothing to the total.`,
    );
  }

  if (report.monthToDate) {
    notes.push('- This month is still in progress, so the figures are month-to-date and will rise.');
  }

  if (report.status === 'closed') {
    notes.push('- This period is **closed**: the figures are an immutable snapshot taken at close and are not recomputed.');
  }

  if (notes.length === 0) {
    notes.push('- No pricing gaps or coverage caveats apply to this period.');
  }

  return notes.join('\n');
}

/**
 * Pure renderer — all formatting decisions live here so the section can be
 * tested against fixtures without touching a database.
 */
export function renderFinopsSection(
  report: ChargebackReport,
  codeEff: ModelEfficiencyReport,
  coworkEff: ModelEfficiencyReport,
  periodStart: string,
  periodEnd: string,
): string {
  const period = monthOf(periodEnd);

  const scopeNote = periodMatchesMonth(periodStart, periodEnd)
    ? `Figures cover the calendar month **${period}**.`
    : `The report window spans more than one calendar month. Cost is billed and reconciled per month, so the figures below cover the calendar month **${period}** (the month containing the report end date), not the full report window.`;

  const s = report.surfaces;

  return `## Cost & Chargeback

${scopeNote}

**Total attributed spend: ${usd(report.grandTotalUsd)}**${report.estimated ? ' (partly estimated; see data quality below)' : ''}

### Spend by surface

| Surface | Spend | Tokens |
|---|---|---|
${surfaceLine('Chat', s.chat)}
${surfaceLine('Code', s.code)}
${surfaceLine('Cowork', s.cowork)}
| **Total** | **${usd(s.total.usd)}** | **${tokens(s.total.tokens.input + s.total.tokens.output + s.total.tokens.cacheWrite + s.total.tokens.cacheRead)}** |

### Spend by cost centre

${costCentreTable(report)}

Unallocated (users with no department or no matching cost centre): **${usd(report.unallocated.totalUsd)}** across ${report.unallocated.users.length} user${report.unallocated.users.length === 1 ? '' : 's'}.

### Model efficiency

${modelEfficiencyBlock('Code', codeEff)}

${modelEfficiencyBlock('Cowork', coworkEff)}

Cache savings this period: ${usdOrNone(report.cacheSavingsUsd)}.

### Data quality

${dataQualityNotes(report, [codeEff, coworkEff])}`;
}

/**
 * Build the FinOps section. Reads only — never writes, never closes a period.
 * Returns finished markdown for verbatim injection.
 */
export async function buildFinopsSection(periodStart: string, periodEnd: string): Promise<string> {
  const period = monthOf(periodEnd);
  const report = await buildChargeback(period);
  const [codeEff, coworkEff] = await Promise.all([
    buildModelEfficiency('code', period),
    buildModelEfficiency('cowork', period),
  ]);
  return renderFinopsSection(report, codeEff, coworkEff, periodStart, periodEnd);
}
