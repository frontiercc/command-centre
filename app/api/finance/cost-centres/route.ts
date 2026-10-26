// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Admin
// writes: createCentre/renameCentre/deleteCentre/mapDept/unmapDept. Each
// action is a single statement (or a read-then-write pair, which can race),
// and none of these use withTx.
// KNOWN GOTCHA: renameCentre OVERWRITES `code` from the request body, so
// callers must round-trip it themselves. Cost-centre NAME uniqueness has no
// DB-level UNIQUE constraint (schema has none); the case-insensitive check
// below is the only enforcement.
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { getAllConfig } from '@/lib/config';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

type TypedClient = Awaited<ReturnType<typeof getTypedClient>>;

interface CentreRow {
  id: number;
  name: string;
  code: string | null;
}

function normalizedName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function findCentreByName(client: TypedClient, name: string, excludeId?: number): Promise<CentreRow | undefined> {
  const rows = await client
    .select({ id: schema.chargebackCostCentres.id, name: schema.chargebackCostCentres.name, code: schema.chargebackCostCentres.code })
    .from(schema.chargebackCostCentres);
  return rows.find(
    (r) => r.name.trim().toLowerCase() === name.trim().toLowerCase() && r.id !== excludeId
  );
}

export async function GET(request: NextRequest) {
  if ((await getAllConfig()).chargebackEnabled !== true) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }

  const client = await getTypedClient();
  const centres = await client
    .select({ id: schema.chargebackCostCentres.id, name: schema.chargebackCostCentres.name, code: schema.chargebackCostCentres.code })
    .from(schema.chargebackCostCentres)
    .orderBy(schema.chargebackCostCentres.name);
  const mapRows = (await client
    .select({ department: schema.chargebackDeptMap.department, costCentreId: schema.chargebackDeptMap.cost_centre_id })
    .from(schema.chargebackDeptMap));
  // department IS NOT NULL AND TRIM(department) <> ''.
  const departmentRows = await client
    .selectDistinct({ d: schema.users.department })
    .from(schema.users)
    .where(and(isNotNull(schema.users.department), sql`TRIM(${schema.users.department}) <> ''`))
    .orderBy(schema.users.department);

  await logAccess({
    actorId: session.userId!,
    actorEmail: session.email!,
    actorIp: request.headers.get('x-forwarded-for') || undefined,
    resource: 'finance/cost-centres',
    action: 'READ',
    outcome: 'success',
  });

  return NextResponse.json({
    centres,
    map: mapRows,
    departments: departmentRows.map((r) => r.d as string),
  });
}

export async function POST(request: NextRequest) {
  if ((await getAllConfig()).chargebackEnabled !== true) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 });
  }

  const client = await getTypedClient();
  const action = body.action;

  async function logWriteSuccess() {
    await logAccess({
      actorId: session!.userId!,
      actorEmail: session!.email!,
      actorIp: request.headers.get('x-forwarded-for') || undefined,
      resource: 'finance/cost-centres',
      action: 'WRITE',
      outcome: 'success',
    });
  }

  if (action === 'createCentre') {
    const name = normalizedName(body.name);
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (await findCentreByName(client, name)) {
      return NextResponse.json({ error: 'A cost centre with that name already exists' }, { status: 409 });
    }
    const code = typeof body.code === 'string' && body.code.length > 0 ? body.code : null;
    const inserted = await client
      .insert(schema.chargebackCostCentres)
      .values({ name, code })
      .returning({ id: schema.chargebackCostCentres.id });
    await logWriteSuccess();
    return NextResponse.json({ id: Number(inserted[0].id), name, code: code ?? null }, { status: 201 });
  }

  if (action === 'renameCentre') {
    const id = typeof body.id === 'number' ? body.id : Number(body.id);
    const name = normalizedName(body.name);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }
    const existingRows = await client
      .select({ id: schema.chargebackCostCentres.id, name: schema.chargebackCostCentres.name, code: schema.chargebackCostCentres.code })
      .from(schema.chargebackCostCentres)
      .where(eq(schema.chargebackCostCentres.id, id))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      return NextResponse.json({ error: 'Cost centre not found' }, { status: 404 });
    }
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    const dup = await findCentreByName(client, name, id);
    if (dup) {
      return NextResponse.json({ error: 'A cost centre with that name already exists' }, { status: 409 });
    }
    // GOTCHA (do not change): `code` is overwritten from the request body;
    // omitting it clears the existing code to null.
    const code = typeof body.code === 'string' && body.code.length > 0 ? body.code : null;
    await client
      .update(schema.chargebackCostCentres)
      .set({ name, code })
      .where(eq(schema.chargebackCostCentres.id, id));
    await logWriteSuccess();
    return NextResponse.json({ ok: true });
  }

  if (action === 'deleteCentre') {
    const id = typeof body.id === 'number' ? body.id : Number(body.id);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }
    await client.delete(schema.chargebackCostCentres).where(eq(schema.chargebackCostCentres.id, id));
    await logWriteSuccess();
    return NextResponse.json({ ok: true });
  }

  if (action === 'mapDept') {
    const department = normalizedName(body.department);
    const costCentreId = typeof body.costCentreId === 'number' ? body.costCentreId : Number(body.costCentreId);
    if (!department) {
      return NextResponse.json({ error: 'department is required' }, { status: 400 });
    }
    if (!Number.isFinite(costCentreId)) {
      return NextResponse.json({ error: 'costCentreId is required' }, { status: 400 });
    }
    const centreRows = await client
      .select({ id: schema.chargebackCostCentres.id })
      .from(schema.chargebackCostCentres)
      .where(eq(schema.chargebackCostCentres.id, costCentreId))
      .limit(1);
    if (!centreRows[0]) {
      return NextResponse.json({ error: 'Cost centre not found' }, { status: 400 });
    }
    await client
      .insert(schema.chargebackDeptMap)
      .values({ department, cost_centre_id: costCentreId })
      .onConflictDoUpdate({
        target: schema.chargebackDeptMap.department,
        set: { cost_centre_id: costCentreId },
      });
    await logWriteSuccess();
    return NextResponse.json({ ok: true });
  }

  if (action === 'unmapDept') {
    const department = normalizedName(body.department);
    if (!department) {
      return NextResponse.json({ error: 'department is required' }, { status: 400 });
    }
    await client.delete(schema.chargebackDeptMap).where(eq(schema.chargebackDeptMap.department, department));
    await logWriteSuccess();
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
