// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table>. The
// PUT handler's "replace all mappings" runs inside a real transaction
// (withTx) — the only write path in this route group
// that needed one.
import { NextRequest, NextResponse } from 'next/server';
import { isNotNull } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { withTx } from '@/lib/db/with-tx';
import { schema } from '@/lib/db/schema';
import { getConfigValue, setConfigValue } from '@/lib/config';
import { getMappings, isValidGithubRepo, runGithubSync } from '@/lib/pulse/code/github-sync';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!['admin', 'manager'].includes(session.role ?? '')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = await getTypedClient();
  const css = schema.codeSessionStats;
  const reposSeenRows = await client
    .selectDistinct({ repo: css.repo })
    .from(css)
    .where(isNotNull(css.repo));
  const reposSeen = reposSeenRows.map(r => r.repo).filter((r): r is string => r !== null).sort();

  return NextResponse.json({
    reposSeen,
    mappings: await getMappings(),
    tokenConfigured: !!(await getConfigValue('githubToken')),
    lastSync: (await getConfigValue('githubSyncLastRun')) || null,
  });
}

export async function PUT(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let body: { mappings?: Array<{ repo: string; github_repo: string }>; token?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.mappings !== undefined) {
    if (!Array.isArray(body.mappings)) {
      return NextResponse.json({ error: 'mappings must be an array of { repo, github_repo }' }, { status: 400 });
    }
    for (const m of body.mappings) {
      if (!m.repo || typeof m.repo !== 'string') {
        return NextResponse.json({ error: 'Each mapping needs a repo name' }, { status: 400 });
      }
      if (m.github_repo && !isValidGithubRepo(m.github_repo)) {
        return NextResponse.json({ error: `"${m.github_repo}" is not a valid owner/repo` }, { status: 400 });
      }
    }
    const client = await getTypedClient();
    const grm = schema.githubRepoMap;
    // withTx (not a bare client.transaction()) — it adds the nested-transaction
    // guard (see lib/db/with-tx.ts's header).
    await withTx(client, async (tx) => {
      await tx.delete(grm);
      const toInsert = body.mappings!.filter(m => m.github_repo).map(m => ({ repo: m.repo, github_repo: m.github_repo }));
      if (toInsert.length > 0) await tx.insert(grm).values(toInsert);
    });
  }

  if (body.token !== undefined) {
    // Remove-only: a blank/masked token is never treated as an intentional
    // clear — blanking the field + Save must never clear a stored secret.
    // DELETE /api/config/secret is the only clear path for this key (see
    // app/api/admin/digest/route.ts's digestSlackWebhookUrl fix for the
    // same pattern).
    if (body.token.trim() !== '' && !body.token.includes('••••••••')) {
      await setConfigValue('githubToken', body.token);
    }
  }

  return NextResponse.json({ ok: true, mappings: await getMappings() });
}

/** Trigger a sync immediately (admin) — used by the admin UI's Sync Now button. */
export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const result = await runGithubSync();
  return NextResponse.json(result);
}
