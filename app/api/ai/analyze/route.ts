// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { logError } from '@/lib/api/errors';
import { runAnomalyDetection, generateAdoptionInsights } from '@/lib/anthropic/ai';
import { getAdminSession, canAccessCorePlatform } from '@/lib/auth/admin-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  // Auth gate — this endpoint triggers paid Claude API calls, so it must never
  // be reachable by an unauthenticated (cookie-presence-only) request. Mirror
  // the core-platform gate used by dashboard/events/alerts/reports.
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessCorePlatform(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const results: Record<string, unknown> = {};

  try {
    results.anomalies = await runAnomalyDetection();
  } catch (err) {
    logError('AI Analyze anomalies', err);
    results.anomalies = { error: 'The AI request failed. Details are in the server log.' };
  }

  try {
    results.adoption = await generateAdoptionInsights();
  } catch (err) {
    logError('AI Analyze adoption', err);
    results.adoption = { error: 'The AI request failed. Details are in the server log.' };
  }

  return NextResponse.json(results);
}
