// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Human time vs Claude time: the pure pieces. The estimate
// check, the prompts (unchanged when the switch is off; Cowork never framed as
// engineering), the digest evidence (masked + fenced) and the totals.
import { describe, it, expect } from 'vitest';
import { parseHumanMinutes, tierGetsEstimate, MAX_HUMAN_MINUTES } from '@/lib/pulse/human-time';
import { buildCodeClassifierSystemMessage, DEFAULT_CODE_CLASSIFIER_CONFIG } from '@/lib/pulse/code/classifier-prompt';
import { buildSessionDigest, type SessionDigestRow } from '@/lib/pulse/code/classifier';
import { buildEstimatePrompt, parseEstimateReply } from '@/lib/pulse/session-estimates';
import { summariseHumanTime } from '@/lib/pulse/human-time-summary';

describe('parseHumanMinutes', () => {
  it('accepts three whole minutes in order', () => {
    expect(parseHumanMinutes({ low: 30, likely: 60, high: 120 })).toEqual({ low: 30, likely: 60, high: 120 });
    expect(parseHumanMinutes({ low: 1, likely: 1, high: MAX_HUMAN_MINUTES })).not.toBeNull();
  });
  it.each([
    ['out of order', { low: 60, likely: 30, high: 120 }],
    ['fractional', { low: 30, likely: 60.5, high: 120 }],
    ['zero', { low: 0, likely: 60, high: 120 }],
    ['over 40 hours', { low: 30, likely: 60, high: MAX_HUMAN_MINUTES + 1 }],
    ['strings', { low: '30', likely: '60', high: '120' }],
    ['missing', { likely: 60 }],
    ['not an object', 60],
    ['null', null],
  ])('rejects %s, never clamps', (_n, v) => {
    expect(parseHumanMinutes(v)).toBeNull();
  });
  it('estimates Tier 2 and 3 only', () => {
    expect([1, 2, 3].map(tierGetsEstimate)).toEqual([false, true, true]);
  });
});

describe('Code classifier prompt', () => {
  it('is unchanged with the switch off', () => {
    const plain = buildCodeClassifierSystemMessage(DEFAULT_CODE_CLASSIFIER_CONFIG);
    expect(buildCodeClassifierSystemMessage(DEFAULT_CODE_CLASSIFIER_CONFIG, { humanTime: false })).toBe(plain);
    expect(plain).not.toContain('human_minutes');
    expect(plain).toContain("A session's first_prompt is fenced this way.");
  });
  it('asks for a by-hand estimate for tier 2/3 when on', () => {
    const on = buildCodeClassifierSystemMessage(DEFAULT_CODE_CLASSIFIER_CONFIG, { humanTime: true });
    expect(on).toContain('4. human_minutes');
    expect(on).toContain('ONLY for sessions you put at tier 2 or 3');
    expect(on).toContain('later_prompts are fenced');
  });
});

const ROW: SessionDigestRow = {
  session_id: 's1', user_id: 'u1', repo: null, git_branch: null, first_at: 0, last_at: 3600,
  user_msg_count: 4, assistant_turns: 30, tool_use_count: 80, error_count: 1, commit_count: 2,
  input_tokens: 0, output_tokens: 0, skills_json: null, mcp_json: null, models_json: null,
};

describe('buildSessionDigest evidence', () => {
  it('adds nothing without evidence', () => {
    expect(buildSessionDigest(ROW, 'Fix the login bug')).not.toContain('lines_added');
  });
  it('adds lines, PRs and masked, fenced later prompts', () => {
    const d = buildSessionDigest(ROW, 'Fix the login bug', {
      linesAdded: 120, linesRemoved: 30, pullRequests: 1,
      laterPrompts: ['Now email jane.doe@example.com the summary'],
    });
    expect(d).toContain('lines_added: 120');
    expect(d).toContain('lines_removed: 30');
    expect(d).toContain('pull_requests: 1');
    expect(d).toContain('later_prompts:');
    expect(d).not.toContain('jane.doe@example.com');
  });
});

describe('Cowork estimate prompt', () => {
  it('frames the work as the role, never engineering', () => {
    const p = buildEstimatePrompt({ prompts: ['Draft the NDA'], kindOfWork: 'legal_drafting', department: 'Legal', systems: [], outputs: ['NDA_Acme_v2.docx'] });
    expect(p).toContain('Outputs produced: NDA_Acme_v2.docx');
    expect(p).toContain('BOTH what the person asked for in the prompts and what the session produced');
    expect(buildEstimatePrompt({ prompts: ['x'], kindOfWork: 'analysis', department: null, systems: [], outputs: [] })).toContain('no file produced');
    expect(p).toContain('someone in Legal');
    expect(p).toContain('legal drafting work');
    expect(p.toLowerCase()).not.toContain('engineer');
  });
  it('parses a JSON reply, tolerating prose around it', () => {
    expect(parseEstimateReply('{"low": 20, "likely": 45, "high": 90}')).toEqual({ low: 20, likely: 45, high: 90 });
    expect(parseEstimateReply('Sure: {"low":20,"likely":45,"high":90}')).toEqual({ low: 20, likely: 45, high: 90 });
    expect(parseEstimateReply('about an hour')).toBeNull();
    expect(parseEstimateReply('{"low": 90, "likely": 45, "high": 20}')).toBeNull();
  });
});

describe('summariseHumanTime', () => {
  const s = (id: string, likely: number, secs: number, kind: string | null) =>
    ({ session_id: id, low: likely / 2, likely, high: likely * 2, claudeSecs: secs, kind });
  it('totals both figures and withholds the ratio below the floor', () => {
    const r = summariseHumanTime([s('a', 120, 1800, 'feature'), s('b', 60, 600, 'bugfix')], 20);
    expect(r.sessions).toBe(2);
    expect(r.humanMinutes).toEqual({ low: 90, likely: 180, high: 360 });
    expect(r.claudeMinutes).toBe(40);
    expect(r.ratio).toBeNull();
  });
  it('shows the ratio at the floor and keeps kinds with 5+ sessions', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => s(`f${i}`, 60, 600, 'feature')),
      ...Array.from({ length: 4 }, (_, i) => s(`b${i}`, 30, 600, 'bugfix')),
      s('n', 30, 600, null),
    ];
    const r = summariseHumanTime(rows, 10);
    expect(r.ratio).toBeCloseTo((300 + 120 + 30) / 100);
    expect(r.byKind.map(k => k.kind)).toEqual(['feature']);
    expect(r.byKind[0]).toEqual({ kind: 'feature', sessions: 5, humanMinutes: 300, claudeMinutes: 50 });
  });
});

describe('text outputs', () => {
  const total = { sessions: 42, humanMinutes: 18_600, claudeMinutes: 2_640 };
  it('builds the digest/Highlights sentence from computed figures', async () => {
    const { humanTimeSentence } = await import('@/lib/pulse/human-time');
    expect(humanTimeSentence({ total }, 'Last week')).toBe(
      'Last week: about 310 hours of Tier 2 and 3 work by hand (AI estimate), done in 44 hours with Claude (measured), across 42 sessions.');
  });
  it('renders the Reports section, estimate labelled in words, null as not measured', async () => {
    const { renderHumanTimeSection } = await import('@/lib/reports/human-time-sections');
    expect(renderHumanTimeSection(null)).toContain('Not measured in this period');
    const empty = { sessions: 0, humanMinutes: { low: 0, likely: 0, high: 0 }, claudeMinutes: 0, ratio: null, byKind: [], windowDays: 7 };
    const md = renderHumanTimeSection({
      code: { ...empty, sessions: 6, humanMinutes: { low: 300, likely: 600, high: 1200 }, claudeMinutes: 120,
        byKind: [{ kind: 'feature', sessions: 5, humanMinutes: 500, claudeMinutes: 100 }] },
      cowork: empty,
      total: { sessions: 6, humanMinutes: 600, claudeMinutes: 120 },
    });
    expect(md).toContain('**The by-hand figures are AI estimates**');
    expect(md).toContain('| Code | 6 | about 10 (range 5.0–20) | 2.0 |');
    expect(md).toContain('| Cowork | 0 | not measured | not measured |');
    expect(md).toContain('- feature: about 8.3 hours by hand against 1.7 hours with Claude, 5 sessions');
  });
  it('adds a Highlights line only when there are figures', async () => {
    const { renderHighlightsPost: renderHighlights } = await import('@/lib/highlights/render');
    const base = {
      weekStart: 0, weekEnd: 604800, headcount: 3, workItems: [], engineeringMix: [],
      systems: { totalCalls: 0, distinctSystems: 0, top: [] }, codeOutput: null, tier3Count: 0, shoutouts: null,
    };
    const composed = { subject: 'A week of work', deliverables: [] };
    expect(renderHighlights({ ...base }, composed)).not.toContain('by hand');
    expect(renderHighlights({ ...base, humanTime: total }, composed)).toContain('About 310 hours of work by hand (AI estimate), done in 44 hours with Claude, across 42 sessions');
  });
});

describe('separate Cowork and Code switches', () => {
  it('an unset Code switch follows Cowork; a set one stands alone', async () => {
    const { effectiveCodeHumanTime } = await import('@/lib/pulse/human-time');
    expect(effectiveCodeHumanTime('', 'true')).toBe(true);
    expect(effectiveCodeHumanTime(undefined, 'false')).toBe(false);
    expect(effectiveCodeHumanTime('false', 'true')).toBe(false);
    expect(effectiveCodeHumanTime('true', 'false')).toBe(true);
  });
});
