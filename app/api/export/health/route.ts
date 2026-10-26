// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { verifyConnectorToken } from '@/lib/connector/tokens';
import { getConnectorHealth } from '@/lib/connector/data';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const token = await verifyConnectorToken(request.headers.get('authorization'));
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json(await getConnectorHealth());
}
