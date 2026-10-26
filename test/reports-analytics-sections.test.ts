// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Pure renderers for the four non-FinOps analytics report sections. As with
// the FinOps tests, these assert the honesty rules rather than the prose:
// nulls never become zeros, judged figures always announce themselves, and
// empty data produces an explicit statement instead of a misleading blank.
import { describe, it, expect } from 'vitest';
import { renderCodePulseSection, safeRatio, perUnit, toNum, type CodePulseFacts } from '@/lib/reports/code-pulse-sections';
import { renderCoworkPulseSection, type CoworkPulseFacts } from '@/lib/reports/cowork-pulse-sections';
import { renderScBoardSection, type ScBoardFacts } from '@/lib/reports/library-sections';
import { renderUseCasesSection, isLive, type UseCasesFacts } from '@/lib/reports/usecases-sections';

// ── Developer Pulse ─────────────────────────────────────────────────────────────

function codeFacts(over: Partial<CodePulseFacts> = {}): CodePulseFacts {
  return {
    hasData: true,
    spendUsd: 100,
    engagedHours: 12.5,
    linesAdded: 1200,
    linesRemoved: 300,
    commitCount: 20,
    prCount: 5,
    editAccept: 80,
    editReject: 20,
    autonomyRatio: 0.42,
    cacheHitRatio: 0.65,
    sessionCount: 30,
    repoCount: 4,
    skillLeverage: 1.1,
    frictionIndex: 0.08,
    workMix: [{ workType: 'feature', count: 12 }],
    tierMix: [{ tier: 1, count: 5 }, { tier: 2, count: 7 }],
    ...over,
  };
}

describe('Developer Pulse helpers', () => {
  it('returns null rather than a fabricated zero ratio', () => {
    expect(safeRatio(0, 0)).toBeNull();
    expect(safeRatio(1, 4)).toBe(0.25);
  });

  it('returns null per-unit cost when there are no units', () => {
    expect(perUnit(100, 0)).toBeNull();
    expect(perUnit(null, 5)).toBeNull();
    expect(perUnit(100, 4)).toBe(25);
  });

  it('coerces Postgres string numerics and rejects junk', () => {
    expect(toNum('12.5')).toBe(12.5);
    expect(toNum(12.5)).toBe(12.5);
    expect(toNum(null)).toBeNull();
    expect(toNum('')).toBeNull();
    expect(toNum('abc')).toBeNull();
  });
});

describe('renderCodePulseSection', () => {
  it('says plainly when no metrics exist', () => {
    const md = renderCodePulseSection(codeFacts({ hasData: false }));
    expect(md).toContain('No Developer Pulse metrics have been computed yet');
  });

  it('renders measured signals', () => {
    const md = renderCodePulseSection(codeFacts());
    expect(md).toContain('12.5 hours');
    expect(md).toContain('| Commits | 20 |');
    expect(md).toContain('80% (80 accepted, 20 rejected)');
  });

  it('shows not measured instead of zero for null signals', () => {
    const md = renderCodePulseSection(codeFacts({ spendUsd: null, autonomyRatio: null, engagedHours: null }));
    expect(md).toContain('| Spend | not measured |');
    expect(md).toContain('| Autonomy ratio | not measured |');
    expect(md).toContain('| Engaged time | not measured |');
    expect(md).not.toContain('| Spend | $0.00 |');
  });

  it('suppresses per-unit cost when the denominator is zero', () => {
    const md = renderCodePulseSection(codeFacts({ prCount: 0 }));
    expect(md).toContain('| Cost per pull request | not measured |');
  });

  it('labels the work mix as AI-judged and warns against reading it as counts of record', () => {
    const md = renderCodePulseSection(codeFacts());
    expect(md).toContain('Work mix (AI-judged)');
    expect(md).toContain('not measured from telemetry');
    expect(md).toContain('feature (12)');
  });

  it('states when nothing has been classified', () => {
    const md = renderCodePulseSection(codeFacts({ workMix: [], tierMix: [] }));
    expect(md).toContain('No sessions have been classified yet');
  });
});

// ── Work Pulse ───────────────────────────────────────────────────────────

function coworkFacts(over: Partial<CoworkPulseFacts> = {}): CoworkPulseFacts {
  return {
    hasData: true,
    dds: 2.4, oti: 0.55, psr: 0.31, ors: 0.72,
    orsBreadth: 0.5, orsOverlap: 0.2, orsPropagation: 0.9,
    metricVersion: 2, otiEarlyRead: false,
    tier1: 50, tier2: 30, tier3: 20, eventCount: 100,
    taskTypes: [{ taskType: 'analysis', count: 40 }],
    frontierPush: 3, capabilityCreation: 1,
    ...over,
  };
}

describe('renderCoworkPulseSection', () => {
  it('announces up front that the whole section is judged', () => {
    const md = renderCoworkPulseSection(coworkFacts());
    expect(md).toContain('**AI-judged**, not measured');
    expect(md).toContain('should not be read as counts of record');
  });

  it('states the metric version and warns against cross-version comparison', () => {
    const md = renderCoworkPulseSection(coworkFacts());
    expect(md).toContain('metric version 2');
    expect(md).toContain('must not be compared across a version change');
  });

  it('flags an early-read OTI', () => {
    expect(renderCoworkPulseSection(coworkFacts({ otiEarlyRead: true }))).toContain('early read');
  });

  it('renders tier shares', () => {
    const md = renderCoworkPulseSection(coworkFacts());
    expect(md).toContain('| Tier 1 | 50 | 50% |');
    expect(md).toContain('| Tier 3 | 20 | 20% |');
  });

  it('shows not measured for null scores', () => {
    const md = renderCoworkPulseSection(coworkFacts({ dds: null, ors: null }));
    expect(md).toContain('(DDS) | not measured');
    expect(md).toContain('(ORS) | not measured');
  });

  it('states when there are no emerging candidates', () => {
    const md = renderCoworkPulseSection(coworkFacts({ frontierPush: 0, capabilityCreation: 0 }));
    expect(md).toContain('No frontier-push or capability-creation candidates');
  });

  it('says plainly when no metrics exist', () => {
    expect(renderCoworkPulseSection(coworkFacts({ hasData: false }))).toContain('No Work Pulse metrics');
  });
});

// ── Skills & Connectors ────────────────────────────────────────────────────

function scFacts(over: Partial<ScBoardFacts> = {}): ScBoardFacts {
  return {
    hasData: true,
    newEntries: [{ name: 'triage', type: 'skill', createdAt: 1 }],
    unclaimed: [{ name: 'orphan-connector', type: 'connector' }],
    totalEntries: 10,
    topSkills: [{ name: 'triage', invocations: 40, users: 6, departments: 2 }],
    topConnectors: [{ name: 'jira', invocations: 25, users: 1, departments: 1 }],
    connectorReads: 20, connectorWrites: 5, connectorUnknown: 0,
    singleUserTools: ['jira'],
    crossDeptTools: ['triage'],
    ...over,
  };
}

describe('renderScBoardSection', () => {
  it('leads ownership with the accountability gap', () => {
    const md = renderScBoardSection(scFacts());
    expect(md).toContain('1 of 10 registered entries have no named owner');
    expect(md).toContain('orphan-connector');
  });

  it('confirms full ownership when nothing is unclaimed', () => {
    expect(renderScBoardSection(scFacts({ unclaimed: [] }))).toContain('All 10 registered entries have a named owner');
  });

  it('splits connector calls by read and write and says why write matters', () => {
    const md = renderScBoardSection(scFacts());
    expect(md).toContain('20 read, 5 write');
    expect(md).toContain('change state in an external system');
  });

  it('calls out key-person dependencies and cross-department spread', () => {
    const md = renderScBoardSection(scFacts());
    expect(md).toContain('key-person dependency');
    expect(md).toContain('jira');
    expect(md).toContain('across more than one department');
  });

  it('states when nothing is new in the period', () => {
    expect(renderScBoardSection(scFacts({ newEntries: [] }))).toContain('No new skills or connectors appeared');
  });

  it('says plainly when there is no data at all', () => {
    expect(renderScBoardSection(scFacts({ hasData: false }))).toContain('No skills or connectors have been observed');
  });
});

// ── Use Cases ──────────────────────────────────────────────────────────────

describe('renderUseCasesSection', () => {
  const facts = (rows: UseCasesFacts['rows']): UseCasesFacts => ({ hasData: rows.length > 0, rows });

  it('treats every lifecycle except not_seen as found', () => {
    expect(isLive('adopted')).toBe(true);
    expect(isLive('piloting')).toBe(true);
    expect(isLive('at_risk')).toBe(true);
    expect(isLive('not_seen')).toBe(false);
  });

  it('counts found versus not seen', () => {
    const md = renderUseCasesSection(facts([
      { title: 'Contract review', lifecycle: 'adopted', lastActivatedAt: 1 },
      { title: 'Invoice triage', lifecycle: 'not_seen', lastActivatedAt: null },
    ]));
    expect(md).toContain('1 of 2 registered use cases was found in telemetry; 1 was not seen');
    expect(md).toContain('| Contract review | Live | adopted |');
    expect(md).toContain('| Invoice triage | Not seen | not_seen |');
  });

  it('explains that not seen is a measured absence, not a judgement', () => {
    const md = renderUseCasesSection(facts([{ title: 'X', lifecycle: 'not_seen', lastActivatedAt: null }]));
    expect(md).toContain('measured absence, not a judgement');
  });

  it('says plainly when nothing is registered', () => {
    expect(renderUseCasesSection(facts([]))).toContain('No use cases have been registered');
  });
});
