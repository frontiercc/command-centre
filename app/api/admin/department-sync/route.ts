// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Department sync (Admin → Access & Keys): status, the first-run preview,
// Apply, Run now and Return to directory. Admin only; every action is
// access-logged. The switch and the name map are ordinary settings saved
// through /api/config.
import { NextRequest, NextResponse } from 'next/server';
import { eq, inArray, or } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { getTypedClient } from '@/lib/db/client';
import * as schema from '@/lib/db/schema.pg';
import { getConfigValue, setConfigValue } from '@/lib/config';
import { parseDepartmentMap } from '@/lib/directory/department-rules';
import {
  getDirectoryProvider, isDepartmentSyncActive, previewDepartmentSync, runDepartmentSync, returnToDirectory,
  type SyncStats,
} from '@/lib/directory/department-sync';

export const dynamic = 'force-dynamic';

type Gate = { ok: true; actor: Parameters<typeof logAccess>[0] } | { ok: false; response: NextResponse };

async function gate(request: NextRequest, action: 'READ' | 'WRITE'): Promise<Gate> {
  const session = await getAdminSession(request);
  if (!session.authenticated) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const actor = {
    actorId: session.userId ?? '', actorEmail: session.email ?? '',
    actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'admin/department-sync',
    action, outcome: 'success' as const,
  };
  if (session.role !== 'admin') {
    await logAccess({ ...actor, outcome: 'denied' });
    return { ok: false, response: NextResponse.json({ error: 'Admin only' }, { status: 403 }) };
  }
  return { ok: true, actor };
}

function parseStats(json: string): SyncStats | null {
  if (!json) return null;
  try { return JSON.parse(json) as SyncStats; } catch { return null; }
}

interface PersonRef { kind: 'user' | 'admin'; id: string; name: string; email: string | null; department: string | null }

export async function GET(request: NextRequest) {
  const g = await gate(request, 'READ');
  if (!g.ok) return g.response;
  try {
    const db = await getTypedClient();
    const provider = await getDirectoryProvider();
    const lastStats = parseStats(await getConfigValue('departmentSyncLastStats'));

    // People kept manual: monitored people first, then login accounts not linked to one.
    const manualUsers = await db.select({ id: schema.users.id, name: schema.users.display_name, email: schema.users.email, department: schema.users.department })
      .from(schema.users).where(eq(schema.users.department_source, 'manual')).limit(200);
    const manualAdmins = await db.select({ id: schema.adminUsers.id, name: schema.adminUsers.display_name, email: schema.adminUsers.email, department: schema.adminUsers.department, linked: schema.adminUsers.linked_cowork_user_id })
      .from(schema.adminUsers).where(eq(schema.adminUsers.department_source, 'manual')).limit(200);
    const listedUsers = new Set(manualUsers.map(u => u.id));
    const manualPeople: PersonRef[] = [
      ...manualUsers.map(u => ({ kind: 'user' as const, id: u.id, name: u.name || u.email || u.id, email: u.email, department: u.department })),
      ...manualAdmins.filter(a => !a.linked || !listedUsers.has(a.linked))
        .map(a => ({ kind: 'admin' as const, id: a.id, name: a.name || String(a.email), email: String(a.email), department: a.department })),
    ];

    // People the last lookup could not find (ids only are stored in the stats).
    const ids = lastStats?.notFoundIds ?? [];
    const notFoundPeople: PersonRef[] = [];
    if (ids.length > 0) {
      const us = await db.select({ id: schema.users.id, name: schema.users.display_name, email: schema.users.email, department: schema.users.department })
        .from(schema.users).where(inArray(schema.users.id, ids));
      const as = await db.select({ id: schema.adminUsers.id, name: schema.adminUsers.display_name, email: schema.adminUsers.email, department: schema.adminUsers.department })
        .from(schema.adminUsers).where(inArray(schema.adminUsers.id, ids));
      for (const u of us) notFoundPeople.push({ kind: 'user', id: u.id, name: u.name || u.email || u.id, email: u.email, department: u.department });
      for (const a of as) notFoundPeople.push({ kind: 'admin', id: a.id, name: a.name || String(a.email), email: String(a.email), department: a.department });
    }

    await logAccess(g.actor);
    return NextResponse.json({
      enabled: (await getConfigValue('departmentSyncEnabled')) === 'true',
      appliedAt: Number(await getConfigValue('departmentSyncAppliedAt')) || null,
      active: await isDepartmentSyncActive(),
      provider: provider.kind === 'none' ? { kind: 'none' } : { kind: provider.kind, label: provider.label },
      map: parseDepartmentMap(await getConfigValue('departmentSyncMap')),
      lastRun: Number(await getConfigValue('departmentSyncLastRun')) || null,
      lastStats,
      manualPeople,
      notFoundPeople,
    });
  } catch (err) {
    await logAccess({ ...g.actor, outcome: 'error', detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Could not load department sync' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const g = await gate(request, 'WRITE');
  if (!g.ok) return g.response;
  let body: { action?: unknown; kind?: unknown; id?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request' }, { status: 400 }); }
  const action = typeof body.action === 'string' ? body.action : '';

  try {
    if (action === 'preview' || action === 'apply' || action === 'run') {
      if ((await getConfigValue('departmentSyncEnabled')) !== 'true') {
        return NextResponse.json({ error: 'Turn on department sync first' }, { status: 409 });
      }
      if ((await getDirectoryProvider()).kind !== 'entra') {
        return NextResponse.json({ error: 'Department sync currently works with Microsoft Entra ID only' }, { status: 409 });
      }
    }

    if (action === 'preview') {
      const stats = await previewDepartmentSync();
      await logAccess({ ...g.actor, detail: 'preview' });
      return NextResponse.json({ stats });
    }

    if (action === 'apply' || action === 'run') {
      if (action === 'run' && !(await isDepartmentSyncActive())) {
        return NextResponse.json({ error: 'Apply the preview first' }, { status: 409 });
      }
      let stats: SyncStats;
      try {
        stats = await runDepartmentSync(action === 'apply' ? 'apply' : 'run_now');
      } catch {
        // The detail is in error_events; the stats carry the fixed message.
        await logAccess({ ...g.actor, outcome: 'error', detail: action });
        return NextResponse.json({ error: "Couldn't reach Microsoft Entra ID. The detail is in System health." }, { status: 502 });
      }
      // Applied even when the daily lookup lacks User.Read.All: departments then update at sign-in.
      if (action === 'apply') await setConfigValue('departmentSyncAppliedAt', String(Math.floor(Date.now() / 1000)));
      await logAccess({ ...g.actor, detail: action });
      return NextResponse.json({ stats });
    }

    if (action === 'return') {
      const kind = body.kind === 'admin' ? 'admin' : body.kind === 'user' ? 'user' : null;
      const id = typeof body.id === 'string' && body.id.length <= 200 ? body.id : '';
      if (!kind || !id) return NextResponse.json({ error: 'kind and id are required' }, { status: 400 });
      const db = await getTypedClient();
      if (kind === 'user') {
        const person = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, id));
        if (person.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        const email = person[0].email;
        const admins = await db.select({ id: schema.adminUsers.id }).from(schema.adminUsers)
          .where(email ? or(eq(schema.adminUsers.linked_cowork_user_id, id), eq(schema.adminUsers.email, email)) : eq(schema.adminUsers.linked_cowork_user_id, id));
        await returnToDirectory({ userIds: [id], adminUserId: admins[0]?.id ?? null });
      } else {
        const rows = await db.select({ linked: schema.adminUsers.linked_cowork_user_id, email: schema.adminUsers.email }).from(schema.adminUsers).where(eq(schema.adminUsers.id, id));
        if (rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        const users = await db.select({ id: schema.users.id }).from(schema.users)
          .where(rows[0].linked ? or(eq(schema.users.id, rows[0].linked), eq(schema.users.email, String(rows[0].email))) : eq(schema.users.email, String(rows[0].email)));
        await returnToDirectory({ adminUserId: id, userIds: users.map(u => u.id) });
      }
      await logAccess({ ...g.actor, detail: `return:${kind}` });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    await logAccess({ ...g.actor, outcome: 'error', detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Department sync request failed' }, { status: 500 });
  }
}
