// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Anthropic's own skills on the S&C Board: each "Explore from Anthropic" card
// shows its uses and the people who used them, the same all-time counts as
// the Board's other cards, or "Not used yet". They are not the organisation's
// to claim, so they stay out of its skill count and its skills to try.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { anthropicUsesLine } from '@/components/library/anthropic-uses';

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: async () => ({ authenticated: true, role: 'admin', email: 'u3@corp.com', userId: 'u3', department: null }),
  };
});

const NOW = Math.floor(Date.now() / 1000);
let cleanup: () => Promise<void>;

describe('anthropicUsesLine', () => {
  it('gives uses and people, or Not used yet', () => {
    expect(anthropicUsesLine({ invocation_count: 217, user_count: 59 })).toBe('217 uses · 59 people');
    expect(anthropicUsesLine({ invocation_count: 1, user_count: 1 })).toBe('1 use · 1 person');
    expect(anthropicUsesLine({ invocation_count: 0, user_count: 0 })).toBe('Not used yet');
  });
});

describe('S&C Board: Anthropic skills', () => {
  beforeAll(async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const h = await createTestDbClient('postgres');
    cleanup = h.cleanup;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = h.client;
    const { schema } = await import('@/lib/db/schema');
    await client.insert(schema.users).values([
      { id: 'u1', email: 'u1@corp.com', display_name: 'Ada', department: 'Sales' },
      { id: 'u2', email: 'u2@corp.com', display_name: 'Bo', department: 'Sales' },
      { id: 'u3', email: 'u3@corp.com', display_name: 'Cy', department: 'Sales' },
    ]);
    await client.insert(schema.skillLibraryEntries).values([
      { name: 'team-report', type: 'skill', surface: 'cowork', source: 'org', is_published: 1, created_at: NOW, updated_at: NOW },
      { name: 'doc-coauthoring', type: 'skill', surface: 'cowork', source: 'anthropic', is_published: 1, created_at: NOW, updated_at: NOW },
      { name: 'anthropic-skills:pdf', type: 'skill', surface: 'cowork', source: 'anthropic', is_published: 1, created_at: NOW, updated_at: NOW },
    ]);
    const use = (id: string, user: string, skill: string) =>
      ({ id, user_id: user, session_id: `s-${id}`, skill_name: skill, occurred_at: NOW - 3600, surface: 'cowork' });
    await client.insert(schema.coworkSkillInvocations).values([
      use('i1', 'u1', 'doc-coauthoring'),
      use('i2', 'u1', 'doc-coauthoring'),
      use('i3', 'u2', 'doc-coauthoring'),
      use('i4', 'u1', 'team-report'),
    ]);
  }, 120_000);
  afterAll(async () => cleanup?.());

  async function board() {
    const { GET } = await import('../app/api/library/route');
    return (await GET(new NextRequest('http://localhost/api/library?type=skill&per_page=200'))).json();
  }

  it('gives each Anthropic skill its uses and people', async () => {
    const body = await board();
    const by = new Map((body.entries as Array<{ name: string; source: string; invocation_count: number; user_count: number }>).map(e => [e.name, e]));
    expect(by.get('doc-coauthoring')).toMatchObject({ source: 'anthropic', invocation_count: 3, user_count: 2 });
    expect(anthropicUsesLine(by.get('doc-coauthoring')!)).toBe('3 uses · 2 people');
    expect(by.get('anthropic-skills:pdf')).toMatchObject({ source: 'anthropic', invocation_count: 0, user_count: 0 });
    expect(anthropicUsesLine(by.get('anthropic-skills:pdf')!)).toBe('Not used yet');
  });

  it("keeps Anthropic skills out of the organisation's skill count and skills to try", async () => {
    const body = await board();
    expect(body.stats.skill_count).toBe(1);
    const toTry = (body.skills_to_try as Array<{ name: string }>).map(s => s.name);
    expect(toTry).toContain('team-report');
    expect(toTry).not.toContain('doc-coauthoring');
  });
});
