// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table>. The
// optional dept/userId filters are a plain array of Drizzle conditions folded
// through `and()`. `files_uploaded` is a plain TEXT column (not jsonb), so it
// is read with JSON.parse(...).
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, isNotNull, ne, gte, type SQL } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getFileCategoryMix } from '@/lib/pulse/cowork/file-categories';

export const dynamic = 'force-dynamic';

export interface FileUploadRow {
  session_id: string;
  started_at: number;
  filename: string;
  project_name: string | null;
  user_id: string;
  display_name: string | null;
  email: string | null;
  department: string | null;
}

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const client = await getTypedClient();
  const { searchParams } = request.nextUrl;

  const dept = searchParams.get('dept') ?? null;
  const userId = searchParams.get('userId') ?? null;
  const days = parseInt(searchParams.get('days') ?? '30', 10);
  const search = searchParams.get('search')?.toLowerCase() ?? null;

  const since = Math.floor(Date.now() / 1000) - days * 24 * 3600;

  const cs = schema.coworkSessions;
  const u = schema.users;

  const conditions: SQL[] = [
    isNotNull(cs.files_uploaded),
    ne(cs.files_uploaded, '[]'),
    gte(cs.started_at, since),
  ];
  if (dept) conditions.push(eq(u.department, dept));
  if (userId) conditions.push(eq(cs.user_id, userId));

  const rows = await client
    .select({
      session_id: cs.id,
      started_at: cs.started_at,
      files_uploaded: cs.files_uploaded,
      project_name: cs.project_name,
      user_id: cs.user_id,
      display_name: u.display_name,
      email: u.email,
      department: u.department,
    })
    .from(cs)
    .leftJoin(u, eq(u.id, cs.user_id))
    .where(and(...conditions))
    .orderBy(desc(cs.started_at))
    .limit(500);

  // Explode JSON arrays into one row per file
  const files: FileUploadRow[] = [];
  for (const row of rows) {
    let names: string[] = [];
    try { names = JSON.parse(row.files_uploaded!); } catch { continue; }
    for (const filename of names) {
      if (search && !filename.toLowerCase().includes(search)) continue;
      files.push({
        session_id: row.session_id,
        started_at: row.started_at!,
        filename,
        project_name: row.project_name,
        user_id: row.user_id!,
        display_name: row.display_name,
        email: row.email,
        department: row.department,
      });
    }
  }

  // Department list for filter dropdown
  const deptRows = await client
    .selectDistinct({ department: u.department })
    .from(cs)
    .leftJoin(u, eq(u.id, cs.user_id))
    .where(and(isNotNull(cs.files_uploaded), ne(cs.files_uploaded, '[]'), isNotNull(u.department)));
  const depts = deptRows.map(r => r.department as string);

  // Files by category describes the file estate, so it sits beside the file
  // list it summarises. Reuses the existing engine rather than a second query,
  // and honours the page's own day filter. Its own try/catch: a failure
  // hides one card rather than emptying the file list.
  let fileCategoryMix: Awaited<ReturnType<typeof getFileCategoryMix>> = [];
  try {
    fileCategoryMix = await getFileCategoryMix(days);
  } catch (e) {
    console.error('[admin/files] file category mix failed', e);
  }

  return NextResponse.json({ files, depts, total: files.length, fileCategoryMix });
}
