// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Act-next list — part of the Workflow Impact package, reworked by
 * Department Process Transformation, then adjusted the same
 * day: model review returns to this panel, rendered beneath the coaching rows.
 *
 * The panel originally merged four independent sources on /pulse/cio. Two
 * stay retired because the same signal already has a proper home elsewhere:
 * a new emergent-suggestion workflow now surfaces in the Use Cases
 * suggestion tray (and, for a department-scoped cluster, the dept process
 * boxes below); a confirmed use case going quiet already raises a
 * use_case_at_risk alert plus a Weekly Digest line. Coaching +
 * per-department coaching-opportunity counts remain the org-wide "who to
 * coach next" signal, and model review (admin|manager only, when FinOps
 * Model Efficiency is enabled) was restored the same day — the decision was
 * that it belongs here too, alongside coaching, not only on /finops.
 *
 * Coaching rows are COUNTS ONLY (dept + count) — no user identity may ever
 * enter a row here, mirroring `getCoachingCountsByDept`'s own structural
 * guarantee (see lib/usecases/spread.ts).
 *
 * Model-review rows never carry a dollar figure — `estCeilingUsd` and its
 * pricing caveats stay on /finops; this list only names the premium model
 * and (when known) a cheaper target.
 *
 * Ordering: coaching rows always render above model_review rows, regardless
 * of reach — the final sort orders by type first, then reach desc within
 * each type.
 *
 * `buildDeptProcessBoxes` lives in this same file so the /pulse/cio page has
 * one call site for "what to act on next" as a whole: department process
 * boxes (`lib/usecases/suggestion-store.ts`'s
 * `listOpenDeptBoxes`) render above everything else, including coaching.
 */
import { getCoachingCountsByDept } from '@/lib/usecases/spread';
import { listOpenDeptBoxes, type DeptProcessBox } from '@/lib/usecases/suggestion-store';
import { buildModelEfficiency } from '@/lib/finance/model-efficiency';
import { currentPeriod } from '@/lib/finance/period';
import { formatModelLabel } from '@/lib/pulse/code/model-label';
import { canAccessPulseAdmin, type UserRole } from '@/lib/auth/admin-auth';
import { getAllConfig } from '@/lib/config';

export type ActNextType = 'coaching' | 'model_review';

export interface ActNextRow {
  type: ActNextType;
  title: string;
  detail: string;
  reach: number;
  href: string;
}

const MODEL_REVIEW_CAP = 3;
const PER_TYPE_CAP = 4;
const LIST_CAP = 10;

// Coaching always renders above model_review, regardless of reach.
const TYPE_ORDER: Record<ActNextType, number> = { coaching: 0, model_review: 1 };

export async function buildActNext(role: string, nowS: number): Promise<ActNextRow[]> {
  const rows: ActNextRow[] = [];

  // Config gates read once, defensively — a config-read failure disables
  // both the coaching and model-review sources rather than throwing.
  let useCasesEnabled = false;
  let financeModelEfficiencyEnabled = false;
  try {
    const cfg = await getAllConfig();
    useCasesEnabled = cfg.useCasesEnabled === true;
    financeModelEfficiencyEnabled = cfg.financeModelEfficiencyEnabled === true;
  } catch { /* both gates stay off */ }

  if (useCasesEnabled) {
    // Coaching — counts only, never names (getCoachingCountsByDept is also
    // flag-gated internally; the check above is belt-and-braces).
    try {
      const coaching = await getCoachingCountsByDept(nowS);
      for (const c of coaching) {
        if (c.count <= 0) continue;
        rows.push({
          type: 'coaching',
          title: `${c.count} coaching opportunit${c.count === 1 ? 'y' : 'ies'} in ${c.dept}`,
          detail: 'Their work matches a registered use case they have never used. Click through for the names and the evidence',
          reach: c.count,
          href: `/pulse/dept?dept=${encodeURIComponent(c.dept)}`,
        });
      }
    } catch { /* contributes nothing */ }
  }

  // Model review — admin|manager only, and only when FinOps Model Efficiency
  // is enabled. Never a dollar figure here — estCeilingUsd stays on /finops.
  if (canAccessPulseAdmin(role as UserRole) && financeModelEfficiencyEnabled) {
    try {
      const period = currentPeriod(nowS);
      const modelRows: ActNextRow[] = [];
      for (const surface of ['code', 'cowork'] as const) {
        const report = await buildModelEfficiency(surface, period, nowS);
        for (const activity of report.activities) {
          const flag = activity.flag;
          if (!flag || flag.suppressedReason) continue;
          modelRows.push({
            type: 'model_review',
            // Display names ("Claude Opus 4.8"), never raw API ids.
            title: `Review ${formatModelLabel(flag.premiumModel).label} usage`,
            detail: flag.targetModel
              ? `Cheaper model available: ${formatModelLabel(flag.targetModel).label}`
              : 'Spend is concentrated on a premium model',
            reach: 0,
            href: '/finops',
          });
        }
      }
      rows.push(...modelRows.slice(0, MODEL_REVIEW_CAP));
    } catch { /* contributes nothing */ }
  }

  // Dedupe by (type, case-insensitive trimmed title) BEFORE the per-type cap —
  // kept from the original multi-source design; still guards coaching (e.g.
  // two department names differing only by case). Keep the higher-reach row;
  // on a tie keep whichever was seen first.
  const dedupeSeen = new Map<string, ActNextRow>();
  const deduped: ActNextRow[] = [];
  for (const row of rows) {
    const dedupeKey = `${row.type}::${row.title.trim().toLowerCase()}`;
    const existing = dedupeSeen.get(dedupeKey);
    if (!existing) {
      dedupeSeen.set(dedupeKey, row);
      deduped.push(row);
    } else if (row.reach > existing.reach) {
      const idx = deduped.indexOf(existing);
      deduped[idx] = row;
      dedupeSeen.set(dedupeKey, row);
    }
  }

  // Cap each type at PER_TYPE_CAP (keeping its highest-reach rows) before the
  // final merge — a source that produces many rows (e.g. a coaching-heavy
  // week) must never crowd the other source out of the top LIST_CAP.
  const byType = new Map<ActNextType, ActNextRow[]>();
  for (const row of deduped) {
    const group = byType.get(row.type) ?? [];
    group.push(row);
    byType.set(row.type, group);
  }
  const capped: ActNextRow[] = [];
  for (const group of byType.values()) {
    group.sort((a, b) => b.reach - a.reach);
    capped.push(...group.slice(0, PER_TYPE_CAP));
  }

  // Coaching before model_review regardless of reach, then reach desc
  // within each type.
  capped.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || b.reach - a.reach);
  return capped.slice(0, LIST_CAP);
}

/**
 * Department process boxes — the top of the /pulse/cio act-next panel.
 * Gated on `useCasesEnabled` AND
 * `useCasesSuggestUseContent` (switching content analysis
 * off must hide already-mined department rows everywhere they render, not
 * just stop the mining job from producing new ones — this panel is the
 * other display surface alongside the suggestions route). Any failure
 * (config read or the store call itself) contributes nothing rather than
 * throwing, matching the rest of this module's convention.
 */
export async function buildDeptProcessBoxes(): Promise<DeptProcessBox[]> {
  let useCasesEnabled = false;
  let contentEnabled = false;
  try {
    const cfg = await getAllConfig();
    useCasesEnabled = cfg.useCasesEnabled === true;
    contentEnabled = cfg.useCasesSuggestUseContent === 'true';
  } catch {
    return [];
  }
  if (!useCasesEnabled || !contentEnabled) return [];

  try {
    return await listOpenDeptBoxes();
  } catch {
    return [];
  }
}
