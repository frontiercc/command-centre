// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { buildCrosswalk, type CodeSignals } from '@/lib/pulse/code/framework';

const full: CodeSignals = {
  spendUsd: 1234.5, autonomyRatio: 3.2, commitCount: 87, prCount: 12,
  linesAdded: 5400, linesRemoved: 1200, editAcceptCount: 90, editRejectCount: 10,
  frictionIndex: 0.08, engagedHours: 140, cacheHitRatio: 0.72, hasWorkMix: true,
};

describe('buildCrosswalk', () => {
  it('returns the four DX Core 4 boxes in order', () => {
    const boxes = buildCrosswalk(full);
    expect(boxes.map(b => b.dimension)).toEqual(['speed', 'quality', 'effectiveness', 'impact']);
  });

  it('formats edit acceptance as a percentage and marks it a proxy', () => {
    const quality = buildCrosswalk(full).find(b => b.dimension === 'quality')!;
    const accept = quality.cells.find(c => c.label.toLowerCase().includes('acceptance'))!;
    expect(accept.value).toBe('90%');
    expect(accept.fit).toBe('proxy');
  });

  it('marks Claude spend as ai_specific, never a framework outcome', () => {
    const impact = buildCrosswalk(full).find(b => b.dimension === 'impact')!;
    const spend = impact.cells.find(c => c.label.toLowerCase().includes('spend'))!;
    expect(spend.fit).toBe('ai_specific');
  });

  it('renders null signals as "—" and never as 0', () => {
    const empty: CodeSignals = {
      spendUsd: null, autonomyRatio: null, commitCount: null, prCount: null,
      linesAdded: null, linesRemoved: null, editAcceptCount: null, editRejectCount: null,
      frictionIndex: null, engagedHours: null, cacheHitRatio: null, hasWorkMix: false,
    };
    const boxes = buildCrosswalk(empty);
    const allCells = boxes.flatMap(b => b.cells);
    for (const c of allCells) {
      expect(c.value === null || c.value === '—').toBe(true);
      expect(c.value).not.toBe('0');
      expect(c.value).not.toBe('$0');
    }
  });

  it('shows a not_captured work-mix cell when the classifier is off', () => {
    const noMix = { ...full, hasWorkMix: false };
    const impact = buildCrosswalk(noMix).find(b => b.dimension === 'impact')!;
    const mix = impact.cells.find(c => c.label.toLowerCase().includes('work mix'))!;
    expect(mix.fit).toBe('not_captured');
  });

  it('every box carries an externalNote pointing at the data that would fill it', () => {
    for (const b of buildCrosswalk(full)) {
      expect(b.externalNote.length).toBeGreaterThan(0);
    }
  });

  it('partial-null lines: renders em-dash for unmeasured side, never 0', () => {
    const partialLines = { ...full, linesRemoved: null };
    const speed = buildCrosswalk(partialLines).find(b => b.dimension === 'speed')!;
    const codeOutput = speed.cells.find(c => c.label.includes('Code output'))!;
    expect(codeOutput.value).toContain('—');
    expect(codeOutput.value).not.toMatch(/−0\b/);
  });

  it('partial-null acceptance: returns null when either count is null, never fabricates a rate', () => {
    const partialAccept = { ...full, editRejectCount: null };
    const quality = buildCrosswalk(partialAccept).find(b => b.dimension === 'quality')!;
    const acceptCell = quality.cells.find(c => c.label.includes('acceptance'))!;
    expect(acceptCell.value).toBeNull();
  });
});
