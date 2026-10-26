// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Admin identity mappings + unmatched-author queue for per-user GitHub
// attribution. Auth mirrors ../route.ts exactly:
// GET admin|manager, writes admin-only. Mapping changes take effect on the
// next sync (the sync rewrites the full window — self-healing). No
// prototype-pollution guard is needed here: identities are stored as DB rows
// and looked up via a Map, never used as object keys server-side.
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

/** Normalise an identity to one of the two stored forms. */
function normaliseIdentity(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s || s.length > 200) return null;
  if (s.startsWith('login:')) {
    const login = s.slice('login:'.length).trim();
    return login ? `login:${login}` : null;
  }
  if (s.includes('@')) return s;          // an email
  return `login:${s}`;                    // a bare login
}

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!['admin', 'manager'].includes(session.role ?? '')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const client = await getTypedClient();
  const gim = schema.githubIdentityMap;
  const gua = schema.githubUnmatchedAuthors;
  const usr = schema.users;
  const mappings = await client
    .select({ identity: gim.identity, user_id: gim.user_id, display_name: usr.display_name, email: usr.email })
    .from(gim)
    .leftJoin(usr, eq(usr.id, gim.user_id))
    .orderBy(gim.identity);
  const unmatched = await client
    .select({ identity: gua.identity, commit_count: gua.commit_count })
    .from(gua)
    .orderBy(gua.identity);
  return NextResponse.json({
    mappings: mappings.map(m => ({ identity: m.identity, user_id: m.user_id, display_name: m.display_name || m.email || m.user_id })),
    unmatched: unmatched.map(u => ({ identity: u.identity, commit_count: Number(u.commit_count) })).sort((a, b) => b.commit_count - a.commit_count),
  });
}

export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  let body: { identity?: string; userId?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const identity = typeof body.identity === 'string' ? normaliseIdentity(body.identity) : null;
  if (!identity) return NextResponse.json({ error: 'identity must be an email, a GitHub login, or login:<name>' }, { status: 400 });
  if (!body.userId || typeof body.userId !== 'string') return NextResponse.json({ error: 'userId is required' }, { status: 400 });
  const client = await getTypedClient();
  const userRows = await client.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, body.userId)).limit(1);
  if (!userRows[0]) return NextResponse.json({ error: 'Unknown userId' }, { status: 400 });
  const gim = schema.githubIdentityMap;
  await client
    .insert(gim)
    .values({ identity, user_id: body.userId, created_at: Math.floor(Date.now() / 1000), created_by: session.userId ?? null })
    .onConflictDoUpdate({ target: gim.identity, set: { user_id: body.userId } });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  let body: { identity?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const identity = typeof body.identity === 'string' ? normaliseIdentity(body.identity) : null;
  if (!identity) return NextResponse.json({ error: 'identity is required' }, { status: 400 });
  const client = await getTypedClient();
  await client.delete(schema.githubIdentityMap).where(eq(schema.githubIdentityMap.identity, identity));
  return NextResponse.json({ ok: true });
}
