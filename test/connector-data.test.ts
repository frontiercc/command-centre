// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let tokens: typeof import('@/lib/connector/tokens');
let period: typeof import('@/lib/pulse/period');

// Route handlers (imported dynamically after DB is set up, matching the
// createTestDatabase() dynamic-import convention so the DB singleton picks up
// the fresh database before any module that opens it at import time).
let summaryRoute: typeof import('../app/api/export/summary/route');
let trendsRoute: typeof import('../app/api/export/trends/route');
let healthRoute: typeof import('../app/api/export/health/route');

const SECRET_USER_ID = 'zz-secret-user-777';
const SECRET_DISPLAY_NAME = 'Secret Person';

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  tokens = await import('@/lib/connector/tokens');
  period = await import('@/lib/pulse/period');
  summaryRoute = await import('../app/api/export/summary/route');
  trendsRoute = await import('../app/api/export/trends/route');
  healthRoute = await import('../app/api/export/health/route');

  await seedFixtures();
});

afterAll(async () => cleanup());

async function seedFixtures() {
  const now = Math.floor(Date.now() / 1000);
  const completedWeekStart = period.priorWeekStart(now); // last COMPLETED week
  const currentWeekStart = period.weekStart(now);
  const priorCompletedWeekStart = completedWeekStart - 7 * 24 * 3600;

  // Secret user — must never leak into org-level aggregates or pass-through fields.
  await sql.run(
    `INSERT INTO users (id, email, display_name, department, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [SECRET_USER_ID, 'secret@example.com', SECRET_DISPLAY_NAME, 'Engineering', now - 1000, now]
  );

  // Org-level (organisation scope) code_metrics rows for the completed week and
  // the prior completed week (so digest deltas + trend series have real data).
  const insertOrgCodeMetric = (params: unknown[]) => sql.run(
    `INSERT INTO code_metrics (
       scope_type, scope_id, period_start, period_end, granularity,
       spend_usd, commit_count, pr_count, session_count, active_time_user_s, computed_at
     ) VALUES ('organisation', 'org', ?, ?, 'week', ?, ?, ?, ?, ?, ?)`,
    params
  );
  await insertOrgCodeMetric([
    completedWeekStart, completedWeekStart + 7 * 24 * 3600,
    123.45, 10, 2, 5, 3600, now,
  ]);
  await insertOrgCodeMetric([
    priorCompletedWeekStart, priorCompletedWeekStart + 7 * 24 * 3600,
    100.0, 8, 1, 4, 3000, now,
  ]);

  // A user-scope code_metrics row correlated with the secret user, for the
  // completed week — this must not leak into org summary/trend/health output.
  await sql.run(
    `INSERT INTO code_metrics (
       scope_type, scope_id, period_start, period_end, granularity,
       spend_usd, commit_count, pr_count, session_count, active_time_user_s, computed_at
     ) VALUES ('user', ?, ?, ?, 'week', ?, ?, ?, ?, ?, ?)`,
    [
      SECRET_USER_ID, completedWeekStart, completedWeekStart + 7 * 24 * 3600,
      999.99, 50, 20, 1, 100, now,
    ]
  );

  // pulse_metrics user-scope rows for the completed + prior completed weeks
  // (drives buildCowork() + the event_count/tier_3_count trend sum).
  const insertUserPulseMetric = (params: unknown[]) => sql.run(
    `INSERT INTO pulse_metrics (
       scope_type, scope_id, period_start, period_end, granularity,
       event_count, tier_3_count, computed_at
     ) VALUES ('user', ?, ?, ?, 'week', ?, ?, ?)`,
    params
  );
  await insertUserPulseMetric([
    'some-other-user', completedWeekStart, completedWeekStart + 7 * 24 * 3600, 42, 7, now,
  ]);
  await insertUserPulseMetric([
    SECRET_USER_ID, completedWeekStart, completedWeekStart + 7 * 24 * 3600, 5, 1, now,
  ]);
  await insertUserPulseMetric([
    'some-other-user', priorCompletedWeekStart, priorCompletedWeekStart + 7 * 24 * 3600, 30, 4, now,
  ]);

  // An alert referencing the secret user by name, inside the completed week
  // window, to stress-test that the anomaly title pass-through doesn't leak
  // it. This is the TOP-severity 'open' alert in the window (critical, most
  // recent), so buildAnomaly() (lib/digest/build.ts) surfaces it as THE
  // anomaly — unconditionally exercising the connector's structural
  // org-only guard (getConnectorSummary must null out the title because
  // alerts.user_id is set), not merely relying on a lower-severity alert
  // losing a ranking tie. This mirrors real usage: an anomaly-detection
  // alert can legitimately be titled with a person's name.
  await sql.run(
    `INSERT INTO alerts (id, user_id, alert_type, severity, title, explanation, status, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    [
      'alert-secret-1', SECRET_USER_ID, 'anomaly', 'critical',
      `Unusual activity involving ${SECRET_DISPLAY_NAME}`, 'test fixture', completedWeekStart + 200,
    ]
  );
  await sql.run(
    `INSERT INTO alerts (id, user_id, alert_type, severity, title, explanation, status, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    [
      'alert-org-1', null, 'policy', 'critical',
      'Org-wide spend spike detected', 'test fixture', completedWeekStart + 100,
    ]
  );

  void currentWeekStart; // reserved for future partial-week assertions
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('GET /api/export/summary', () => {
  it('returns 401 without a token', async () => {
    const req = new NextRequest('http://localhost/api/export/summary');
    const res = await summaryRoute.GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 with a bad/garbage token', async () => {
    const req = new NextRequest('http://localhost/api/export/summary', {
      headers: authHeader('garbage-not-a-real-token'),
    });
    const res = await summaryRoute.GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 200 with a valid minted token and the expected shape', async () => {
    const { token } = await tokens.mintConnectorToken('summary-test');
    const req = new NextRequest('http://localhost/api/export/summary', {
      headers: authHeader(token),
    });
    const res = await summaryRoute.GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('generatedAt');
    expect(body).toHaveProperty('code');
    expect(body).toHaveProperty('cowork');
    expect(body).toHaveProperty('anomaly');
    expect(body).toHaveProperty('weekStart');
    expect(body).toHaveProperty('weekEnd');
  });

  it('never includes briefingExcerpt', async () => {
    const { token } = await tokens.mintConnectorToken('summary-no-briefing');
    const req = new NextRequest('http://localhost/api/export/summary', {
      headers: authHeader(token),
    });
    const res = await summaryRoute.GET(req);
    const body = await res.json();
    expect(body).not.toHaveProperty('briefingExcerpt');
    expect(JSON.stringify(body)).not.toContain('briefingExcerpt');
  });
});

describe('GET /api/export/trends', () => {
  it('returns 401 without a token', async () => {
    const req = new NextRequest('http://localhost/api/export/trends?metric=spend_usd');
    const res = await trendsRoute.GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 with a bad/garbage token', async () => {
    const req = new NextRequest('http://localhost/api/export/trends?metric=spend_usd', {
      headers: authHeader('garbage-not-a-real-token'),
    });
    const res = await trendsRoute.GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 when metric is missing', async () => {
    const { token } = await tokens.mintConnectorToken('trends-missing-metric');
    const req = new NextRequest('http://localhost/api/export/trends', {
      headers: authHeader(token),
    });
    const res = await trendsRoute.GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('returns 200 with a valid minted token and the expected shape for spend_usd', async () => {
    const { token } = await tokens.mintConnectorToken('trends-spend');
    const req = new NextRequest('http://localhost/api/export/trends?metric=spend_usd&weeks=4', {
      headers: authHeader(token),
    });
    const res = await trendsRoute.GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('metric', 'spend_usd');
    expect(body).toHaveProperty('weeks', 4);
    expect(Array.isArray(body.series)).toBe(true);
  });

  it('returns 200 for the pulse_metrics-summed metrics (event_count, tier_3_count)', async () => {
    const { token } = await tokens.mintConnectorToken('trends-event-count');
    const req = new NextRequest('http://localhost/api/export/trends?metric=event_count&weeks=4', {
      headers: authHeader(token),
    });
    const res = await trendsRoute.GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metric).toBe('event_count');
    expect(Array.isArray(body.series)).toBe(true);
    // Missing weeks contribute 0, not null, per the CIO-route convention.
    for (const point of body.series) {
      expect(point.value === null ? true : typeof point.value === 'number').toBe(true);
    }
  });

  it('rejects a disallowed / injection-attempt metric with 400', async () => {
    const { token } = await tokens.mintConnectorToken('trends-injection');
    const req = new NextRequest(
      'http://localhost/api/export/trends?metric=' + encodeURIComponent('spend_usd; DROP TABLE users'),
      { headers: authHeader(token) }
    );
    const res = await trendsRoute.GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('rejects an unrelated non-allowlisted column with 400', async () => {
    const { token } = await tokens.mintConnectorToken('trends-not-a-real-column');
    const req = new NextRequest('http://localhost/api/export/trends?metric=not_a_real_column', {
      headers: authHeader(token),
    });
    const res = await trendsRoute.GET(req);
    expect(res.status).toBe(400);
  });

  it('clamps weeks=999 down to 26 at the route level', async () => {
    const { token } = await tokens.mintConnectorToken('trends-clamp-high');
    const req = new NextRequest('http://localhost/api/export/trends?metric=spend_usd&weeks=999', {
      headers: authHeader(token),
    });
    const res = await trendsRoute.GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.weeks).toBe(26);
    expect(body.series.length).toBe(26);
  });

  it('clamps weeks=0 up to 1 at the route level', async () => {
    const { token } = await tokens.mintConnectorToken('trends-clamp-low');
    const req = new NextRequest('http://localhost/api/export/trends?metric=spend_usd&weeks=0', {
      headers: authHeader(token),
    });
    const res = await trendsRoute.GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.weeks).toBe(1);
    expect(body.series.length).toBe(1);
  });

  it('returns 400 when weeks is present but not a valid integer', async () => {
    const { token } = await tokens.mintConnectorToken('trends-weeks-non-numeric');
    const req = new NextRequest('http://localhost/api/export/trends?metric=spend_usd&weeks=abc', {
      headers: authHeader(token),
    });
    const res = await trendsRoute.GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });
});

describe('GET /api/export/health', () => {
  it('returns 401 without a token', async () => {
    const req = new NextRequest('http://localhost/api/export/health');
    const res = await healthRoute.GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 with a bad/garbage token', async () => {
    const req = new NextRequest('http://localhost/api/export/health', {
      headers: authHeader('garbage-not-a-real-token'),
    });
    const res = await healthRoute.GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 200 with a valid minted token and the expected shape', async () => {
    const { token } = await tokens.mintConnectorToken('health-test');
    const req = new NextRequest('http://localhost/api/export/health', {
      headers: authHeader(token),
    });
    const res = await healthRoute.GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('unpricedModels');
    expect(body).toHaveProperty('estimatedModels');
    expect(body).toHaveProperty('unattributedOtel');
    expect(body).toHaveProperty('orphanSessions');
    expect(body).toHaveProperty('malformedModelsJson');
    expect(body).toHaveProperty('aggregatorLastRun');
    expect(body).toHaveProperty('lastOtelIngest');
    expect(body).toHaveProperty('lastMetaIngest');
  });
});

describe('org-only guard: no per-user identity ever leaks through /api/export/*', () => {
  it('summary/trends/health responses never contain the secret user id or display name', async () => {
    const { token } = await tokens.mintConnectorToken('org-only-guard');

    const summaryReq = new NextRequest('http://localhost/api/export/summary', {
      headers: authHeader(token),
    });
    const summaryRes = await summaryRoute.GET(summaryReq);
    const summaryText = JSON.stringify(await summaryRes.json());

    const trendsReq = new NextRequest('http://localhost/api/export/trends?metric=event_count&weeks=8', {
      headers: authHeader(token),
    });
    const trendsRes = await trendsRoute.GET(trendsReq);
    const trendsText = JSON.stringify(await trendsRes.json());

    const trendsReq2 = new NextRequest('http://localhost/api/export/trends?metric=spend_usd&weeks=8', {
      headers: authHeader(token),
    });
    const trendsRes2 = await trendsRoute.GET(trendsReq2);
    const trendsText2 = JSON.stringify(await trendsRes2.json());

    const healthReq = new NextRequest('http://localhost/api/export/health', {
      headers: authHeader(token),
    });
    const healthRes = await healthRoute.GET(healthReq);
    const healthText = JSON.stringify(await healthRes.json());

    for (const text of [summaryText, trendsText, trendsText2, healthText]) {
      expect(text).not.toContain(SECRET_USER_ID);
      expect(text).not.toContain(SECRET_DISPLAY_NAME);
    }
  });
});

describe('anomaly title structural org-only guarantee (connector path only)', () => {
  it('a user-linked top-severity alert yields { severity, title: null } in the summary, and the name is absent from the serialized payload', async () => {
    const data = await import('@/lib/connector/data');
    const summary = await data.getConnectorSummary() as { anomaly: { title: string | null; severity: string } | null };

    // alert-secret-1 (user_id = SECRET_USER_ID, critical, most recent) is the
    // top-ranked 'open' alert in the fixture window — see seedFixtures().
    expect(summary.anomaly).not.toBeNull();
    expect(summary.anomaly!.severity).toBe('critical');
    expect(summary.anomaly!.title).toBeNull();

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(SECRET_DISPLAY_NAME);
    expect(serialized).not.toContain(SECRET_USER_ID);
  });

  it('the MCP get_weekly_summary path inherits the same title suppression (shared getConnectorSummary)', async () => {
    const mcp = await import('@/lib/connector/mcp');
    const res = await mcp.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_weekly_summary', arguments: {} } });
    const json = res.json as { result: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(json.result.content[0].text) as { anomaly: { title: string | null; severity: string } | null };
    expect(parsed.anomaly).not.toBeNull();
    expect(parsed.anomaly!.title).toBeNull();
  });

  it('a NULL-user_id alert still yields its title when it is the top-ranked alert', async () => {
    // Isolated scenario: only a non-identifying alert in the window (no
    // user_id) — buildAnomaly() must still surface its title unfiltered.
    const isolatedNow = Math.floor(Date.now() / 1000) - 400 * 7 * 24 * 3600; // far enough back to have no fixture rows
    const isolatedPeriodStart = period.weekStart(isolatedNow) - 7 * 24 * 3600;

    await sql.run(
      `INSERT INTO code_metrics (
         scope_type, scope_id, period_start, period_end, granularity,
         spend_usd, commit_count, pr_count, session_count, active_time_user_s, computed_at
       ) VALUES ('organisation', 'org', ?, ?, 'week', ?, ?, ?, ?, ?, ?)`,
      [isolatedPeriodStart, isolatedPeriodStart + 7 * 24 * 3600, 50.0, 3, 1, 2, 1000, isolatedNow]
    );

    await sql.run(
      `INSERT INTO alerts (id, user_id, alert_type, severity, title, explanation, status, generated_at)
       VALUES (?, NULL, ?, ?, ?, ?, 'open', ?)`,
      ['alert-isolated-org', 'policy', 'high', 'Isolated org-only alert', 'test fixture', isolatedPeriodStart + 100]
    );

    const { buildDigest } = await import('@/lib/digest/build');
    const digest = await buildDigest(isolatedNow);
    expect(digest?.anomaly).not.toBeNull();
    expect(digest?.anomaly?.title).toBe('Isolated org-only alert');
    expect(digest?.anomaly?.userLinked).toBe(false);
  });
});

describe('token wiring: last_used_at is bumped by a successful export call', () => {
  it('bumps last_used_at after a real route call', async () => {
    const { token, record } = await tokens.mintConnectorToken('last-used-bump');
    expect(record.lastUsedAt).toBeNull();

    const req = new NextRequest('http://localhost/api/export/health', {
      headers: authHeader(token),
    });
    const res = await healthRoute.GET(req);
    expect(res.status).toBe(200);

    const list = await tokens.listConnectorTokens();
    const entry = list.find((r) => r.id === record.id);
    expect(entry?.lastUsedAt).not.toBeNull();
    expect(entry?.lastUsedAt as number).toBeGreaterThan(0);
  });
});

describe('getConnectorTrend weeks clamping (direct unit test)', () => {
  it('clamps weeks > 26 down to 26', async () => {
    const data = await import('@/lib/connector/data');
    const result = await data.getConnectorTrend('spend_usd', 999);
    expect(result.weeks).toBe(26);
  });

  it('clamps weeks < 1 up to 1', async () => {
    const data = await import('@/lib/connector/data');
    const result = await data.getConnectorTrend('spend_usd', 0);
    expect(result.weeks).toBe(1);

    const negativeResult = await data.getConnectorTrend('spend_usd', -5);
    expect(negativeResult.weeks).toBe(1);
  });

  it('defaults to 8 weeks when weeks is undefined', async () => {
    const data = await import('@/lib/connector/data');
    const result = await data.getConnectorTrend('spend_usd', undefined as unknown as number);
    expect(result.weeks).toBe(8);
  });

  it('defaults to 8 weeks when weeks is NaN', async () => {
    const data = await import('@/lib/connector/data');
    const result = await data.getConnectorTrend('spend_usd', NaN);
    expect(result.weeks).toBe(8);
  });

  it('throws InvalidMetricError for a disallowed metric', async () => {
    const data = await import('@/lib/connector/data');
    await expect(data.getConnectorTrend('not_a_real_column', 4)).rejects.toThrow(data.InvalidMetricError);
  });
});
