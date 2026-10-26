// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Where the money went: one set of model calls split into the main
 * conversation and subagents, and by model, subagent and skill.
 * Client-safe and pure: the Audit Log and Spend Review both use it.
 *
 * A call is a SUBAGENT call when it carries a subagent name, MAIN when it
 * carries a query_source but no subagent name (the person's own conversation,
 * plus Claude's housekeeping such as titles and compaction), and NOT RECORDED
 * when it carries neither: older Claude Code and Cowork records did not keep
 * either field, so those calls cannot be placed.
 *
 * Spend is priced exactly as FinOps prices it (Claude Code at the admin model
 * rates, Cowork as Claude reports it). A call with no price adds to its call
 * count and is listed as unpriced, never counted as $0.
 */

export interface SpendFact {
  model: string | null;
  subagent: string | null;
  skill: string | null;
  /** True when the call recorded where it came from (query_source or a subagent name). */
  sourceRecorded: boolean;
  /** Priced spend; null when the model has no price. */
  usd: number | null;
  calls: number;
}

export interface NamedSpend {
  name: string;
  usd: number;
  calls: number;
}

export interface SpendSplit {
  /** Priced spend across every call; null when nothing could be priced. */
  totalUsd: number | null;
  mainUsd: number;
  subagentUsd: number;
  notRecordedUsd: number;
  calls: number;
  byModel: NamedSpend[];
  bySubagent: NamedSpend[];
  bySkill: NamedSpend[];
  unpricedModels: string[];
}

export class SpendSplitAcc {
  private total = 0;
  private priced = false;
  private main = 0;
  private sub = 0;
  private none = 0;
  private calls = 0;
  private models = new Map<string, NamedSpend>();
  private subagents = new Map<string, NamedSpend>();
  private skills = new Map<string, NamedSpend>();
  private unpriced = new Set<string>();

  add(f: SpendFact): void {
    const usd = f.usd !== null && Number.isFinite(f.usd) ? f.usd : null;
    this.calls += f.calls;
    if (usd === null) {
      if (f.model) this.unpriced.add(f.model);
    } else {
      this.total += usd;
      this.priced = true;
      if (f.subagent) this.sub += usd;
      else if (f.sourceRecorded) this.main += usd;
      else this.none += usd;
    }
    if (f.model) bump(this.models, f.model, usd, f.calls);
    if (f.subagent) bump(this.subagents, f.subagent, usd, f.calls);
    if (f.skill) bump(this.skills, f.skill, usd, f.calls);
  }

  merge(other: SpendSplitAcc): void {
    this.total += other.total;
    this.priced ||= other.priced;
    this.main += other.main;
    this.sub += other.sub;
    this.none += other.none;
    this.calls += other.calls;
    for (const [k, v] of other.models) bump(this.models, k, v.usd, v.calls);
    for (const [k, v] of other.subagents) bump(this.subagents, k, v.usd, v.calls);
    for (const [k, v] of other.skills) bump(this.skills, k, v.usd, v.calls);
    for (const m of other.unpriced) this.unpriced.add(m);
  }

  result(): SpendSplit {
    return {
      totalUsd: this.priced ? this.total : null,
      mainUsd: this.main,
      subagentUsd: this.sub,
      notRecordedUsd: this.none,
      calls: this.calls,
      byModel: ranked(this.models),
      bySubagent: ranked(this.subagents),
      bySkill: ranked(this.skills),
      unpricedModels: [...this.unpriced].sort(),
    };
  }
}

function bump(map: Map<string, NamedSpend>, name: string, usd: number | null, calls: number): void {
  const e = map.get(name) ?? { name, usd: 0, calls: 0 };
  if (usd !== null) e.usd += usd;
  e.calls += calls;
  map.set(name, e);
}

function ranked(map: Map<string, NamedSpend>): NamedSpend[] {
  return [...map.values()].sort((a, b) => b.usd - a.usd || b.calls - a.calls || a.name.localeCompare(b.name));
}

/** True when a split has anything worth showing beyond its total. */
export function hasBreakdown(s: SpendSplit | null | undefined): boolean {
  return !!s && (s.subagentUsd > 0 || s.bySubagent.length > 0 || s.bySkill.length > 0);
}
