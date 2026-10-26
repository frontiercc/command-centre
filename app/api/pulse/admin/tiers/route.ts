// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table>.
// Saving writes the config and a version-history row; existing
// classifications are kept.
import { validateTaxonomy } from '@/lib/pulse/taxonomy-validate';
import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { setConfigValue } from '@/lib/config';
import { getTierConfig, buildClassifierSystemMessage, DEFAULT_TIER_CONFIG, type TierConfig } from '@/lib/pulse/tier-config';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const config = await getTierConfig();
  const promptPreview = buildClassifierSystemMessage(config);

  return NextResponse.json({ config, promptPreview, defaults: DEFAULT_TIER_CONFIG });
}

export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { config: TierConfig };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { config } = body;

  if (!config?.tiers?.tier1 || !config?.tiers?.tier2 || !config?.tiers?.tier3) {
    return NextResponse.json({ error: 'config.tiers must include tier1, tier2, tier3' }, { status: 400 });
  }
  if (!Array.isArray(config?.taxonomy?.tier1)) {
    return NextResponse.json({ error: 'config.taxonomy must include tier1, tier2, tier3 arrays' }, { status: 400 });
  }
  const taxonomyError = validateTaxonomy(config.taxonomy);
  if (taxonomyError) return NextResponse.json({ error: taxonomyError }, { status: 400 });
  if (typeof config.confidenceThreshold !== 'number' ||
      config.confidenceThreshold < 0 || config.confidenceThreshold > 1) {
    return NextResponse.json({ error: 'confidenceThreshold must be 0.0–1.0' }, { status: 400 });
  }

  await setConfigValue('pulseClassifierConfig', JSON.stringify(config));

  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);

  // Write version history snapshot
  await client.insert(schema.pulseRubricVersions).values({
    changed_by: session.email!,
    changed_at: now,
    rubric_json: JSON.stringify(config),
    change_summary: null,
  });

  // A saved rubric applies from the moment it is saved: new prompts use it,
  // past classifications stay as they are. Resetting every row to
  // 'unclassified' would empty Work Mix and the other cards until the
  // classifier had redone the whole history.
  const promptPreview = buildClassifierSystemMessage(config);
  return NextResponse.json({ ok: true, promptPreview });
}
