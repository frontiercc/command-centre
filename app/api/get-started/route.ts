// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The dashboard's "Get started" panel (admin only): the setup steps and their
// state, and Hide. Deliberately not under /api/admin/setup, which middleware
// leaves open for first-admin creation.
import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { getConfigValue, setConfigValue } from '@/lib/config';
import { getSetupStatus, parseStepsDone, SETUP_STEPS, type SetupStep } from '@/lib/setup/status';
import { logError } from '@/lib/api/errors';
import { readJsonLimited } from '@/lib/api/body';

export const dynamic = 'force-dynamic';

async function gate(request: NextRequest, action: 'READ' | 'WRITE') {
  const session = await getAdminSession(request);
  if (!session.authenticated) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }), actor: null };
  const actor = { actorId: session.userId ?? '', actorEmail: session.email ?? '', actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'get-started' };
  if (session.role !== 'admin') {
    await logAccess({ ...actor, action, outcome: 'denied' });
    return { error: NextResponse.json({ error: 'Admin only' }, { status: 403 }), actor: null };
  }
  return { error: null, actor };
}

export async function GET(request: NextRequest) {
  const g = await gate(request, 'READ');
  if (g.error) return g.error;
  try {
    return NextResponse.json(await getSetupStatus());
  } catch (err) {
    logError('Get started', err);
    return NextResponse.json({ error: 'Could not load the setup steps' }, { status: 500 });
  }
}

/**
 * { action: 'hide' } hides the panel for every admin on this install;
 * { action: 'show' } brings it back;
 * { action: 'rubric-reviewed' } ticks the tiers step without changing the tiers;
 * { action: 'step-done', step } ticks any of the five steps by hand.
 */
export async function POST(request: NextRequest) {
  const g = await gate(request, 'WRITE');
  if (g.error) return g.error;
  let action: unknown;
  let step: unknown;
  try {
    const body = (await readJsonLimited<{ action?: unknown; step?: unknown }>(request, 1024)).value;
    action = body?.action;
    step = body?.step;
  } catch { action = undefined; }
  if (action === 'step-done') {
    if (typeof step !== 'string' || !(SETUP_STEPS as readonly string[]).includes(step)) {
      return NextResponse.json({ error: 'Unknown step' }, { status: 400 });
    }
    try {
      const done = parseStepsDone(await getConfigValue('setupStepsDone'));
      if (!done.includes(step as SetupStep)) done.push(step as SetupStep);
      await setConfigValue('setupStepsDone', JSON.stringify(done));
      await logAccess({ ...g.actor, action: 'WRITE', outcome: 'success', detail: `marked the ${step} step as done` });
      return NextResponse.json({ ok: true });
    } catch (err) {
      logError('Get started', err);
      return NextResponse.json({ error: 'Could not save' }, { status: 500 });
    }
  }
  const ACTIONS = {
    hide: { key: 'setupGuideHidden', value: 'true', detail: 'hid the Get started panel' },
    show: { key: 'setupGuideHidden', value: 'false', detail: 'showed the Get started panel again' },
    'rubric-reviewed': { key: 'setupRubricReviewed', value: 'true', detail: 'marked the tiers as reviewed' },
  } as const;
  if (action !== 'hide' && action !== 'show' && action !== 'rubric-reviewed') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
  try {
    await setConfigValue(ACTIONS[action].key, ACTIONS[action].value);
    await logAccess({ ...g.actor, action: 'WRITE', outcome: 'success', detail: ACTIONS[action].detail });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError('Get started', err);
    return NextResponse.json({ error: 'Could not save' }, { status: 500 });
  }
}
