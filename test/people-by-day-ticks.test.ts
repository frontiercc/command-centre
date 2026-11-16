// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// "Who is using it each day?": the scale runs to the top tick, so a busiest day
// of 56 people is drawn under a labelled 60, not above a top label of 30.
import { describe, it, expect } from 'vitest';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PeopleByDay from '@/components/dashboard/PeopleByDay';
import { PRODUCTS, zeroCounts } from '@/lib/dashboard/vendor';

// The test build compiles JSX to React.createElement, which Next does not need in scope.
(globalThis as { React?: typeof React }).React = React;

function render(peak: number): string {
  const product = PRODUCTS[0];
  const days = Array.from({ length: 14 }, (_, i) => ({
    date: `2026-11-${String(i + 1).padStart(2, '0')}`,
    products: { ...zeroCounts(), [product.id]: i === 6 ? peak : 10 },
  }));
  return renderToStaticMarkup(createElement(PeopleByDay, {
    days, products: [product], activeThisWeek: peak, activeLastWeek: peak, productNames: product.label,
  }));
}

const tickLabels = (html: string) => [...html.matchAll(/tabular-nums" style="top:([\d.]+)%">(\d+)</g)].map(m => [Number(m[2]), Number(m[1])]);

describe('PeopleByDay y axis', () => {
  it('labels the top tick and scales the lines to it', () => {
    const html = render(56);
    expect(tickLabels(html)).toEqual([[0, 100], [30, 50], [60, 0]]);
    // The peak of 56 sits below the 60 line (y > 0), not off the top.
    const y56 = (1 - 56 / 60) * 100;
    expect(html).toContain(`,${y56}`);
  });

  it('keeps every tick when the peak is already a multiple of five', () => {
    expect(tickLabels(render(20)).map(([v]) => v)).toEqual([0, 10, 20]);
  });
});
