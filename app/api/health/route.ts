// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. UNAUTHENTICATED
// route polled by the Docker healthcheck every 30s (see docker-compose.yml) —
// it MUST keep returning 200 with the same JSON shape and degrade gracefully,
// never throw.
//
// `migrationCount` is not read on Postgres (there is no `_migrations` table
// wired up here) and is always reported as 0.
import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { getAdminSession } from '@/lib/auth/admin-auth';
import packageJson from '@/package.json';

// Disable Next.js route caching — all API routes read live data from the database
export const dynamic = 'force-dynamic';

// ─── Raw-execution facade (mirrors lib/db/queries.ts's rawAll) ────────────────
interface RawFacade {
  execute?: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute!(query);
  return res.rows as T[];
}

export async function GET(request: NextRequest) {
  let dbOk = false;
  const migrationCount = 0;

  try {
    const client = await getTypedClient();
    // Trivial liveness probe — the one thing that actually
    // determines `dbOk`/the healthcheck's HTTP status.
    const liveness = await rawAll<{ ok: number }>(client, sql`SELECT 1 as ok`);
    dbOk = liveness[0]?.ok === 1;
  } catch {
    dbOk = false;
  }

  const status = dbOk ? 'ok' : 'degraded';
  const httpStatus = dbOk ? 200 : 503;

  // Unauthenticated callers (Docker/Fly.io health checks) get status only.
  // getAdminSession reads the DB to validate the session cookie, so when the
  // DB is down it can throw for an authenticated caller. This endpoint must
  // NEVER throw (the Docker healthcheck AND the database-unavailable banner
  // both depend on always getting back JSON) — fall back to the same
  // minimal status-only body the unauthenticated branch returns.
  let session;
  try {
    session = await getAdminSession(request);
  } catch {
    return NextResponse.json({ status }, { status: httpStatus });
  }
  if (!session.authenticated) {
    return NextResponse.json({ status }, { status: httpStatus });
  }

  return NextResponse.json(
    {
      status,
      version: packageJson.version,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      db: {
        ok: dbOk,
        migrations: migrationCount,
      },
    },
    { status: httpStatus }
  );
}
