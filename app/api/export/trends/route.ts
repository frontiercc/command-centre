// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { verifyConnectorToken } from '@/lib/connector/tokens';
import { getConnectorTrend, InvalidMetricError } from '@/lib/connector/data';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const token = await verifyConnectorToken(request.headers.get('authorization'));
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const metric = request.nextUrl.searchParams.get('metric');
  if (!metric) {
    return NextResponse.json({ error: 'metric is required' }, { status: 400 });
  }

  const weeksParam = request.nextUrl.searchParams.get('weeks');
  let weeks: number | undefined;
  if (weeksParam !== null) {
    weeks = Number(weeksParam);
    if (!Number.isFinite(weeks)) {
      return NextResponse.json({ error: 'weeks must be a valid integer' }, { status: 400 });
    }
  }

  try {
    const result = await getConnectorTrend(metric, weeks);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof InvalidMetricError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
