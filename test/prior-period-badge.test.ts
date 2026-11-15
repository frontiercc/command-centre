// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Developer Pulse's change badge compares the last 30 days with the 30 days
// before, and never works out a change against nothing.
import { describe, it, expect } from 'vitest';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PriorPeriodBadge, { priorPeriodChange } from '@/components/pulse/code/PriorPeriodBadge';

// The test build compiles JSX to React.createElement, which Next does not need in scope.
(globalThis as { React?: typeof React }).React = React;

describe('PriorPeriodBadge', () => {
  it('works out the change on the 30 days before, or null when there is nothing to compare with', () => {
    expect(priorPeriodChange(12, 8)).toBeCloseTo(0.5, 9);
    expect(priorPeriodChange(6, 8)).toBeCloseTo(-0.25, 9);
    expect(priorPeriodChange(5, 0)).toBeNull();
    expect(priorPeriodChange(5, null)).toBeNull();
    expect(priorPeriodChange(null, 5)).toBeNull();
  });

  it('says what it compares with', () => {
    const html = (pct: number | null) => renderToStaticMarkup(createElement(PriorPeriodBadge, { pct }));
    expect(html(0.5)).toContain('↑ 50% on the 30 days before');
    expect(html(-0.25)).toContain('↓ 25% on the 30 days before');
    expect(html(0.001)).toContain('No change on the 30 days before');
    expect(html(null)).toContain('Nothing in the 30 days before to compare with');
    expect(html(0.5)).not.toContain('week');
  });
});
