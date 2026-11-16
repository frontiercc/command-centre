// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The dashboard's "Who is using it each day?" and "Which departments are using
// it?" panels cover the last 30 days. The sentence above the daily lines keeps
// the Active users card's 7-day figures. POSTGRES ONLY.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import PeopleByDay from '@/components/dashboard/PeopleByDay';
import DepartmentHeatmap from '@/components/dashboard/DepartmentHeatmap';
import { PRODUCTS, zeroCounts } from '@/lib/dashboard/vendor';

// The test build compiles JSX to React.createElement, which Next does not need in scope.
(globalThis as { React?: typeof React }).React = React;

let sql: TestSql;
let cleanup: () => Promise<void>;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;

  // Ana used Claude Chat 20 days ago (inside 30 days, outside 7); Ben 40 days ago (outside 30).
  await sql.run(`INSERT INTO users (id, email, display_name, department, source, first_seen_at, last_seen_at) VALUES
    ('u-ana', 'ana@example.org', 'Ana', 'Finance', 'otel', 1, ?),
    ('u-ben', 'ben@example.org', 'Ben', 'Finance', 'otel', 1, ?)`, [NOW - 20 * DAY, NOW - 40 * DAY]);
  await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, occurred_at) VALUES
    ('m-ana', 'cc-ana', 'u-ana', 'cowork_user_message', 'chat', 'compliance', ?),
    ('m-ben', 'cc-ben', 'u-ben', 'cowork_user_message', 'chat', 'compliance', ?)`, [NOW - 20 * DAY, NOW - 40 * DAY]);
});
afterAll(async () => cleanup());

describe('dashboard panels over 30 days', () => {
  it('gives 30 days of daily points, oldest first, ending today', async () => {
    const { getPeopleByDayByProduct, DASHBOARD_PANEL_DAYS } = await import('@/lib/dashboard/queries');
    expect(DASHBOARD_PANEL_DAYS).toBe(30);
    const days = await getPeopleByDayByProduct(DASHBOARD_PANEL_DAYS, NOW);
    expect(days).toHaveLength(30);
    expect(days[29].date).toBe(new Date(NOW * 1000).toISOString().slice(0, 10));
    const anaDay = new Date((NOW - 20 * DAY) * 1000).toISOString().slice(0, 10);
    expect(days.find(d => d.date === anaDay)?.products.claude_chat).toBe(1);
    expect(days.reduce((n, d) => n + d.products.claude_chat, 0)).toBe(1);
  });

  it('counts a department over the last 30 days, all and per vendor', async () => {
    const { getDepartmentBreakdownByProduct } = await import('@/lib/dashboard/queries');
    const all = (await getDepartmentBreakdownByProduct('all', NOW)).find(d => d.department === 'Finance')!;
    expect(all).toMatchObject({ user_count: 2, active_users: 1 });
    expect(all.products.claude_chat).toBe(1);
    const claude = (await getDepartmentBreakdownByProduct('claude', NOW)).find(d => d.department === 'Finance')!;
    expect(claude).toMatchObject({ user_count: 2, active_users: 1 });
    const openai = (await getDepartmentBreakdownByProduct('openai', NOW)).find(d => d.department === 'Finance')!;
    expect(openai.active_users).toBe(0);
  });

  it('labels both panels with 30 days, and keeps the Active users sentence on 7 days', () => {
    const product = PRODUCTS[0];
    const days = Array.from({ length: 30 }, (_, i) => ({
      date: new Date((NOW - (29 - i) * DAY) * 1000).toISOString().slice(0, 10),
      products: { ...zeroCounts(), [product.id]: 3 },
    }));
    const people = renderToStaticMarkup(createElement(PeopleByDay, {
      days, products: [product], activeThisWeek: 5, activeLastWeek: 4, productNames: 'Claude',
    }));
    expect(people).toContain('Last 30 days');
    expect(people).toContain('used Claude in the last 7 days');
    expect(people).not.toContain('14 days');
    // Date labels every 7 days back from today, so 30 days stay readable: today, -7, -14, -21, -28.
    expect(people.match(/whitespace-nowrap" style="left:/g)).toHaveLength(5);

    const depts = renderToStaticMarkup(createElement(DepartmentHeatmap, {
      data: [{ department: 'Finance', user_count: 2, active_users: 1, products: zeroCounts() }], targetPct: null,
    }));
    expect(depts).toContain('Last 30 days');
    expect(depts).toContain('active in the last 30 days');
    expect(depts).not.toContain('7 days');
  });
});
