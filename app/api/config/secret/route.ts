// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { deleteConfigValues, type AppConfig } from '@/lib/config';
import { SECRET_KEYS } from '@/lib/config-secrets';

export const dynamic = 'force-dynamic';

export async function DELETE(request: NextRequest) {
  const session = await requireAdmin(request);
  if (!session) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const key = typeof body?.key === 'string' ? body.key : '';
  const def = Object.prototype.hasOwnProperty.call(SECRET_KEYS, key) ? SECRET_KEYS[key] : undefined;
  if (!def) {
    return NextResponse.json({ error: `'${key}' is not a removable secret` }, { status: 400 });
  }

  const cleared = [key as keyof AppConfig, ...def.associatedKeys];
  await deleteConfigValues(cleared);

  await logAccess({
    actorId: session.userId!,
    actorEmail: session.email!,
    actorIp: request.headers.get('x-forwarded-for') || undefined,
    resource: `config/${key}`,
    action: 'DELETE',
    outcome: 'success',
    detail: `Removed ${def.label}; also reset: ${def.associatedKeys.join(', ') || 'nothing'}`,
  });

  return NextResponse.json({ ok: true, cleared });
}
