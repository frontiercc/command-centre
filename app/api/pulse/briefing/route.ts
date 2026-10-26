// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { BRIEFING_DEFAULT_MODEL } from '@/lib/anthropic/constants';
import { getOrgBriefingModel, getUserBriefingModel } from '@/lib/anthropic/model';
import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { aiFailureOptions } from '@/lib/anthropic/grounded-json';
import { and, eq, gte } from 'drizzle-orm';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue, setConfigValue } from '@/lib/config';
import { generateUserWeeklyBriefing } from '@/lib/pulse/briefings/weekly';
import { generateCioBriefing } from '@/lib/pulse/briefings/cio';

export const dynamic = 'force-dynamic';

const FALLBACK_BRIEFING_MODEL = BRIEFING_DEFAULT_MODEL;

/** Detect Anthropic model-not-found errors so we can auto-heal the stored config. */
function isModelNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  // Anthropic SDK throws with status 404 and error.type === 'not_found_error'
  if (e.status === 404) return true;
  // Also catch if the error message contains the API response body
  const msg = (e.message as string | undefined) ?? '';
  return msg.includes('not_found_error') || msg.includes('"type":"not_found_error"');
}

/**
 * A personal briefing's model was not found. A saved personal model is
 * cleared so the briefings follow the Core AI model again; when the model came
 * from the Core AI setting itself, say so — clearing nothing would fix it.
 */
async function userModelUnavailable(model: string, saved: boolean): Promise<NextResponse> {
  if (saved) {
    await setConfigValue('pulseUserBriefingModel', '');
    return NextResponse.json(
      { error: `Personal briefing model "${model}" is no longer available. Reset to follow the Core AI model. Please try again.` },
      { status: 400 },
    );
  }
  return NextResponse.json(
    { error: `The Core AI model "${model}" is no longer available. Choose another on Admin → System, then try again.` },
    { status: 400 },
  );
}

/**
 * POST /api/pulse/briefing
 *
 * Body: { type: 'user', userId: string }       — personal model
 *    or { type: 'all_users' }   — personal model; regenerates for all active users
 *    or { type: 'cio' } / { type: 'dept', dept }  — organisation model
 *
 * Admin only. Returns { ok: true, generated: number } on success.
 */
export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || !canAccessPulseAdmin(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { type: string; userId?: string; dept?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Personal briefings and organisation briefings use different models
  // (lib/anthropic/model.ts); /admin/pulse shows both.
  const orgModel = await getOrgBriefingModel();
  const userModel = await getUserBriefingModel();
  const userModelSaved = (await getConfigValue('pulseUserBriefingModel')) !== '';
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 24 * 3600;

  if (body.type === 'user') {
    // Single user briefing
    if (!body.userId) {
      return NextResponse.json({ error: 'userId required' }, { status: 400 });
    }
    try {
      await generateUserWeeklyBriefing(body.userId, sevenDaysAgo, now, userModel);
      return NextResponse.json({ ok: true, generated: 1 });
    } catch (err) {
      if (isModelNotFound(err)) {
        return userModelUnavailable(userModel, userModelSaved);
      }
      return errorResponse('Pulse Briefing', err, aiFailureOptions(err));
    }
  }

  if (body.type === 'cio') {
    // CIO / org briefing — covers last 30 days as the on-demand window
    const thirtyDaysAgo = now - 30 * 24 * 3600;
    try {
      await generateCioBriefing(thirtyDaysAgo, now, orgModel);
      return NextResponse.json({ ok: true, generated: 1 });
    } catch (err) {
      if (isModelNotFound(err)) {
        await setConfigValue('pulseBriefingModel', FALLBACK_BRIEFING_MODEL);
        return NextResponse.json(
          { error: `Briefing model "${orgModel}" is no longer available. Reset to ${FALLBACK_BRIEFING_MODEL}. Please try again.` },
          { status: 400 }
        );
      }
      return errorResponse('Pulse Briefing', err, aiFailureOptions(err));
    }
  }

  if (body.type === 'dept') {
    if (!body.dept || typeof body.dept !== 'string') {
      return NextResponse.json({ error: 'dept required' }, { status: 400 });
    }
    const thirtyDaysAgo = now - 30 * 24 * 3600;
    try {
      const { generateDeptBriefing } = await import('@/lib/pulse/briefings/dept');
      await generateDeptBriefing(body.dept, thirtyDaysAgo, now, orgModel);
      return NextResponse.json({ ok: true, generated: 1 });
    } catch (err) {
      if (isModelNotFound(err)) {
        await setConfigValue('pulseBriefingModel', FALLBACK_BRIEFING_MODEL);
        return NextResponse.json(
          { error: `Briefing model "${orgModel}" is no longer available. Reset to ${FALLBACK_BRIEFING_MODEL}. Please try again.` },
          { status: 400 }
        );
      }
      return errorResponse('Pulse Briefing', err, aiFailureOptions(err));
    }
  }

  if (body.type === 'all_users') {
    // Bulk — regenerate for all users active in the past 7 days
    const client = await getTypedClient();
    const pc = schema.pulseClassifications;
    const activeUsers = await client
      .selectDistinct({ user_id: pc.user_id })
      .from(pc)
      .where(and(eq(pc.classifier_status, 'classified'), gte(pc.classified_at, sevenDaysAgo)));

    let succeeded = 0;
    let failed = 0;

    for (const { user_id } of activeUsers) {
      try {
        await generateUserWeeklyBriefing(user_id, sevenDaysAgo, now, userModel);
        succeeded++;
      } catch (err) {
        if (isModelNotFound(err)) {
          // Abort the bulk run — caller should retry after fixing the model
          return userModelUnavailable(userModel, userModelSaved);
        }
        failed++;
      }
    }

    return NextResponse.json({ ok: true, generated: succeeded, failed });
  }

  return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
}
