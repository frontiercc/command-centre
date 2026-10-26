// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres.
// resolveLinkedUserId is the only inline query in this leaf route; createUseCase/
// listUseCases (lib/usecases/queries.ts) are already async and stay awaited.
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { createUseCase, listUseCases } from '@/lib/usecases/queries';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

const VALID_ORIGINS = new Set(['planned', 'emergent', 'ideated']);
const VALID_STATUSES = new Set(['candidate', 'confirmed', 'archived']);

export async function GET(request: NextRequest) {
  if ((await getAllConfig()).useCasesEnabled !== true) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessPulseAdmin(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const status = params.get('status') || undefined;
  const origin = params.get('origin') || undefined;

  const rows = await listUseCases({ status, origin });
  const res = NextResponse.json(rows);

  // Surface the viewer's linked cowork user id via a response header (not the
  // JSON body — the body shape is a bare array and is asserted as such by
  // existing tests). Same resolution as /api/pulse/me: linked_cowork_user_id
  // first, falling back to an email match against `users`.
  const linkedUserId = await resolveLinkedUserId(session.email);
  if (linkedUserId) res.headers.set('X-Linked-User-Id', linkedUserId);

  return res;
}

async function resolveLinkedUserId(email?: string): Promise<string | null> {
  if (!email) return null;
  const client = await getTypedClient();
  const linkedRows = await client
    .select({ linked_cowork_user_id: schema.adminUsers.linked_cowork_user_id })
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.email, email))
    .limit(1);
  if (linkedRows[0]?.linked_cowork_user_id) return linkedRows[0].linked_cowork_user_id;
  const byEmailRows = await client
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  return byEmailRows[0]?.id ?? null;
}

export async function POST(request: NextRequest) {
  if ((await getAllConfig()).useCasesEnabled !== true) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessPulseAdmin(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body.title !== 'string' || body.title.trim() === '') {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  // Sessions are judged against a use case's description, so a use case
  // without one can never be recognised.
  if (typeof body.description !== 'string' || body.description.trim() === '') {
    return NextResponse.json({ error: 'description is required: it is what sessions are judged against' }, { status: 400 });
  }

  if ('origin' in body && !VALID_ORIGINS.has(body.origin)) {
    return NextResponse.json({ error: 'invalid origin' }, { status: 400 });
  }

  if ('status' in body && !VALID_STATUSES.has(body.status)) {
    return NextResponse.json({ error: 'invalid status' }, { status: 400 });
  }

  const created = await createUseCase({
    title: body.title,
    description: body.description ?? null,
    ownerUserId: body.ownerUserId ?? null,
    departments: body.departments ?? [],
    surfaces: body.surfaces ?? [],
    keywords: body.keywords ?? [],
    skills: body.skills ?? [],
    connectors: body.connectors ?? [],
    taskTypes: body.taskTypes ?? [],
    // Guided intake default: planned origin, confirmed status. Extract/ideate
    // routes (later slices) override these to 'ideated'/'emergent' + 'candidate'.
    origin: body.origin ?? 'planned',
    status: body.status ?? 'confirmed',
    captureMethod: body.captureMethod ?? 'guided',
    sourceExcerpt: body.sourceExcerpt ?? null,
    createdBy: session.userId,
  });

  return NextResponse.json(created, { status: 201 });
}
