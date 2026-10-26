// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table>. No
// aggregates here (plain DISTINCT read), so no Number()-coercion is needed.
import { NextRequest, NextResponse } from 'next/server';
import { ne } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { setConfigValue } from '@/lib/config';
import { getCodeModelRates, DEFAULT_RATES, isEstimatedPricing, type ModelRate } from '@/lib/pulse/code/rates';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!['admin', 'manager'].includes(session.role ?? '')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const rates = await getCodeModelRates();

  // Models seen in telemetry with no rate entry — surfaced as "unpriced"
  const client = await getTypedClient();
  const cam = schema.codeAssistantMeta;
  const seenModels = await client
    .selectDistinct({ model: cam.model })
    .from(cam)
    .where(ne(cam.model, ''));
  // Same rule as health.ts: a provider id priced via the normalised fallback is estimated, not unpriced.
  const unpricedModels = seenModels.map(m => m.model).filter((m): m is string => !!m && !rates[m] && !isEstimatedPricing(m, rates));

  return NextResponse.json({ rates, defaults: DEFAULT_RATES, unpricedModels });
}

function isValidRate(value: unknown): value is ModelRate {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (['in', 'out', 'cacheWrite', 'cacheRead'] as const).every(
    k => typeof r[k] === 'number' && isFinite(r[k] as number) && (r[k] as number) >= 0
  );
}

export async function PUT(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const rates = (body as { rates?: unknown })?.rates;
  if (typeof rates !== 'object' || rates === null || Array.isArray(rates)) {
    return NextResponse.json({ error: 'Expected { rates: { "<model-id>": { in, out, cacheWrite, cacheRead } } }' }, { status: 400 });
  }

  for (const [model, rate] of Object.entries(rates as Record<string, unknown>)) {
    if (!isValidRate(rate)) {
      return NextResponse.json(
        { error: `Invalid rate for "${model}": each entry needs numeric in, out, cacheWrite, cacheRead ($/MTok, >= 0)` },
        { status: 400 }
      );
    }
  }

  await setConfigValue('codeModelRates', JSON.stringify(rates));
  return NextResponse.json({ ok: true, rates: await getCodeModelRates() });
}
