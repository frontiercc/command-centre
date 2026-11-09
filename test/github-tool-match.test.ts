// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Matching GitHub commits to the commits Claude Code and Codex recorded, by
// person and time (lib/pulse/code/github-tool-match.ts). Pure, no database.
import { describe, it, expect } from 'vitest';
import { matchCommitsToTools, MATCH_TOLERANCE_S, githubRepoBasis } from '@/lib/pulse/code/github-tool-match';

const T = 1_790_000_000;
const MIN = 60;

describe('matchCommitsToTools', () => {
  it('uses a 15-minute tolerance either side', () => {
    expect(MATCH_TOLERANCE_S).toBe(15 * MIN);
    const tags = matchCommitsToTools([T, T + 40 * MIN], { claude: [T + 15 * MIN], codex: [T + 40 * MIN - 15 * MIN - 1] });
    expect(tags).toEqual(['claude', null]);
  });

  it('matches each tool commit to at most one GitHub commit', () => {
    const tags = matchCommitsToTools([T, T + MIN, T + 2 * MIN], { claude: [T + MIN], codex: [] });
    expect(tags).toEqual([null, 'claude', null]);
  });

  it('a count of two tool commits matches two GitHub commits', () => {
    const tags = matchCommitsToTools([T, T + MIN, T + 2 * MIN], { claude: [T + MIN, T + MIN], codex: [] });
    expect(tags.filter(t => t === 'claude')).toHaveLength(2);
  });

  it('closest pairs win, so Claude Code and Codex commits minutes apart each find their own commit', () => {
    const tags = matchCommitsToTools([T, T + 5 * MIN], { claude: [T + 4 * MIN], codex: [T + MIN] });
    expect(tags).toEqual(['codex', 'claude']);
  });

  it('leaves commits with no tool commit nearby as no AI tool recorded', () => {
    expect(matchCommitsToTools([T], { claude: [], codex: [] })).toEqual([null]);
    expect(matchCommitsToTools([T], { claude: [T + 3600], codex: [T - 3600] })).toEqual([null]);
  });

  it('does not depend on the order commits arrive in', () => {
    const tags = matchCommitsToTools([T + 10 * MIN, T], { claude: [T], codex: [T + 10 * MIN] });
    expect(tags).toEqual(['codex', 'claude']);
  });
});

describe('githubRepoBasis', () => {
  it('follows the tab once Codex data exists, and counts every repo on a hub without Codex', () => {
    expect(githubRepoBasis('claude', true)).toBe('claude');
    expect(githubRepoBasis('openai', true)).toBe('openai');
    expect(githubRepoBasis('all', true)).toBe('all');
    expect(githubRepoBasis('claude', false)).toBe('all');
  });
});
