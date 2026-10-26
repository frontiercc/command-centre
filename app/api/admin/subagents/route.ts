// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Claude subagents register (Admin → Claude subagents). Admin only: it names
 * who runs which subagent and what it cost them, so every read is written to
 * the access log.
 */
import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { buildSubagentRegister } from '@/lib/subagents/register';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });

  try {
    const register = await buildSubagentRegister();
    await logAccess({
      actorId: session.userId!, actorEmail: session.email!, resource: 'admin/subagents', action: 'READ',
      outcome: 'success', detail: `${register.rows.length} subagents`,
    });
    return NextResponse.json(register);
  } catch (err) {
    await logAccess({
      actorId: session.userId!, actorEmail: session.email!, resource: 'admin/subagents', action: 'READ',
      outcome: 'error',
    });
    return errorResponse('Claude subagents', err, { message: 'Could not load Claude Sub Agents. Details are in the server log.' });
  }
}
