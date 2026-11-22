// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The productivity strip: engaged time reads as the sum of the two parts shown
// under it, pull requests from telemetry are pull requests opened, and edit
// acceptance names its 7-day window like the other figures.
import { describe, it, expect } from 'vitest';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CodeProductivityStrip from '@/components/pulse/code/CodeProductivityStrip';
import { formatDuration } from '@/components/pulse/code/CodeStatStrip';
import type { CodeMetricsRow } from '@/components/pulse/code/CodeStatStrip';

// The test build compiles JSX to React.createElement, which Next does not need in scope.
(globalThis as { React?: typeof React }).React = React;

describe('formatDuration', () => {
  it('rounds to the nearest minute', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(30)).toBe('30s');
    expect(formatDuration(90)).toBe('2m');
    expect(formatDuration(3600 + 29 * 60 + 40)).toBe('1h 30m');
    expect(formatDuration(7200)).toBe('2h');
  });
});

describe('CodeProductivityStrip', () => {
  const metrics = {
    active_time_user_s: 50 * 60 + 40, // 50m 40s, shown as 51m
    active_time_cli_s: 9 * 60 + 40,   // 9m 40s, shown as 10m
    commit_count: 3, pr_count: 1, lines_added: 10, lines_removed: 2,
    edit_accept_count: 3, edit_reject_count: 1,
  } as unknown as CodeMetricsRow;
  const html = renderToStaticMarkup(createElement(CodeProductivityStrip, { metrics }));

  it('shows engaged time as the sum of its rounded parts', () => {
    expect(html).toContain('51m people at the keyboard · 10m Claude working');
    expect(html).toContain('1h 1m');
  });

  it('labels pull requests from telemetry as opened, and edit acceptance as 30 days', () => {
    expect(html).toContain('1 pull request opened');
    expect(html).not.toContain('merged');
    expect(html).toContain('Edit acceptance · 30 days');
  });
});
