// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { getAdminSession, requireAdmin } from '@/lib/auth/admin-auth';
import { BUILT_IN_CATEGORIES } from '@/lib/intent/categories';
import { getCustomCategories, saveCustomCategories } from '@/lib/intent/custom';
import type { IntentCategory } from '@/lib/intent/types';

export const dynamic = 'force-dynamic';

const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

/**
 * GET — return built-in categories + custom categories.
 * Built-in categories reflect their enabled state from config (if toggled).
 */
export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Intent categories — admin only (admin intent page).
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const custom = await getCustomCategories();

  // Built-in toggle overrides: check if admin has toggled any built-in off
  const builtInOverrides = custom.filter(c => c.builtIn);
  const overrideMap = new Map(builtInOverrides.map(c => [c.id, c.enabled]));

  const builtIn = BUILT_IN_CATEGORIES.map(c => ({
    ...c,
    enabled: overrideMap.has(c.id) ? overrideMap.get(c.id)! : c.enabled,
  }));

  const customOnly = custom.filter(c => !c.builtIn);

  return NextResponse.json({ builtIn, custom: customOnly });
}

/**
 * POST — save custom categories + built-in toggle overrides.
 * Body: { builtInToggles: Record<string, boolean>, custom: IntentCategory[] }
 */
export async function POST(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { builtInToggles, custom } = body as {
      builtInToggles?: Record<string, boolean>;
      custom?: IntentCategory[];
    };

    const toSave: IntentCategory[] = [];

    // Save built-in toggle overrides (only store overrides that differ from default)
    if (builtInToggles) {
      for (const cat of BUILT_IN_CATEGORIES) {
        if (builtInToggles[cat.id] !== undefined && builtInToggles[cat.id] !== cat.enabled) {
          toSave.push({ ...cat, enabled: builtInToggles[cat.id] });
        }
      }
    }

    // Validate and save custom categories
    if (custom && Array.isArray(custom)) {
      for (const cat of custom) {
        if (!cat.id || !cat.name || !cat.phrases || !Array.isArray(cat.phrases)) {
          return NextResponse.json({ error: `Invalid category: ${cat.name || 'unnamed'} (requires id, name, and phrases array)` }, { status: 400 });
        }
        if (cat.phrases.length === 0) {
          return NextResponse.json({ error: `Category "${cat.name}" must have at least one phrase` }, { status: 400 });
        }
        if (!VALID_SEVERITIES.has(cat.defaultSeverity)) {
          return NextResponse.json({ error: `Invalid severity "${cat.defaultSeverity}" for category "${cat.name}"` }, { status: 400 });
        }

        toSave.push({
          id: cat.id,
          name: cat.name,
          description: cat.description || '',
          phrases: cat.phrases.filter((p: string) => p.trim()),
          defaultSeverity: cat.defaultSeverity,
          builtIn: false,
          enabled: cat.enabled !== false,
        });
      }
    }

    await saveCustomCategories(toSave);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse('api/intent-categories', err);
  }
}
