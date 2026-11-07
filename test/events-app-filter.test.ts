// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// GET /api/events?app=... : the Audit Log's app filter. Claude in Office prompts
// are stored beside Cowork prompts with `product` set (NULL = Cowork), so the
// filter picks Cowork alone, any Office app, or one Office app. An unknown
// value is refused rather than ignored.
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const sessionResult = { authenticated: true, role: 'admin', userId: 'a1', email: 'a@x.test' };
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => sessionResult };
});
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn() }));

describe('GET /api/events app filter', () => {
  it('returns Cowork, Claude in Office or one Office app', async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const { client, cleanup } = await createTestDbClient('postgres');
    try {
      const { schema } = await import('@/lib/db/schema');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = client as any;
      await db.insert(schema.users).values({ id: 'u1', email: 'u1@x.test', display_name: 'User One' });
      const prompt = (id: string, product: string | null, occurred_at: number) => ({
        id, session_id: `s-${id}`, user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork',
        source: 'otel', product, content_preview: id, content_full: id, occurred_at,
      });
      await db.insert(schema.coworkMessages).values([
        prompt('cw', null, 400),
        prompt('xl', 'excel', 300),
        prompt('wd', 'word', 200),
        prompt('gs', 'sheets', 150),
        prompt('gd', 'docs', 120),
      ]);
      await db.insert(schema.coworkSkillInvocations).values([
        { id: 'skill-1', user_id: 'u1', session_id: 's-cw', skill_name: 'docx', occurred_at: 100, source: 'otel', surface: 'cowork' },
      ]);

      const { GET } = await import('@/app/api/events/route');
      const ids = async (q: string) => {
        const res = await GET(new NextRequest(`http://localhost/api/events${q}`));
        expect(res.status).toBe(200);
        return ((await res.json()) as Array<{ id: string }>).map(r => r.id).sort();
      };

      expect(await ids('?app=cowork')).toEqual(['cw']);
      // Claude in Office and Claude in Google are separate groups.
      expect(await ids('?app=office')).toEqual(['wd', 'xl']);
      expect(await ids('?app=google')).toEqual(['gd', 'gs']);
      expect(await ids('?app=excel')).toEqual(['xl']);
      expect(await ids('?app=docs')).toEqual(['gd']);
      expect(await ids('?app=outlook')).toEqual([]);
      // No app filter: every prompt plus the skill event, as before.
      expect(await ids('?surface=cowork')).toEqual(['cw', 'gd', 'gs', 'skill-1', 'wd', 'xl']);

      const bad = await GET(new NextRequest('http://localhost/api/events?app=teams'));
      expect(bad.status).toBe(400);
    } finally {
      await cleanup();
    }
  }, 120_000);
});
