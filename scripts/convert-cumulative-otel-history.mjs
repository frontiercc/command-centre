#!/usr/bin/env node
// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * One-off correction for Claude Code metric rows stored before the receiver read OTLP temporality.
 *
 * A client set to cumulative temporality sends running totals. Before 1.4.5 the receiver stored
 * each total as if it were an increment, so summing them overstated engaged time, lines, pull
 * requests and edits for those clients. This script finds the sessions that sent running totals
 * and rewrites their rows as increments: each value minus the one before it in the same series,
 * or the value itself where the counter restarted.
 *
 * A session counts as cumulative when its active-time series never goes down and adds up to more
 * than the time the session spans, which increments cannot do. Rows from delta clients are left
 * alone, and running the script again changes nothing, because converted rows no longer pass that
 * test.
 *
 * Reports what it would change and changes nothing, unless --apply is given:
 *
 *   docker compose exec hub node scripts/convert-cumulative-otel-history.mjs
 *   docker compose exec hub node scripts/convert-cumulative-otel-history.mjs --apply
 */

import pg from 'pg';
import { pgSslOption } from './pg-ssl.mjs';

const APPLY = process.argv.includes('--apply');
/** Slack on top of a session's span, for the first interval and clock skew. */
const SPAN_SLACK_SECS = 600;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Run this inside the hub container.');
  process.exit(1);
}

const db = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslOption(process.env.CCC_PG_SSL, process.env.DATABASE_URL),
});

const CUMULATIVE_SESSIONS = `
  WITH at AS (
    SELECT session_id, type, occurred_at, value,
           LAG(value) OVER (PARTITION BY session_id, type ORDER BY occurred_at, id) AS prev
    FROM code_otel_metrics
    WHERE metric_name = 'claude_code.active_time.total' AND session_id IS NOT NULL
  )
  SELECT DISTINCT session_id FROM (
    SELECT session_id, type, COUNT(*) AS n, SUM(value) AS total,
           MAX(occurred_at) - MIN(occurred_at) AS span,
           BOOL_AND(prev IS NULL OR value >= prev) AS rising
    FROM at GROUP BY session_id, type
  ) s
  WHERE n >= 2 AND rising AND total > span + ${SPAN_SLACK_SECS}
`;

const CONVERTED = `
  SELECT m.id, m.user_id, m.metric_name, m.type, m.occurred_at, m.value AS old_value,
         CASE WHEN m.prev IS NULL OR m.value < m.prev THEN m.value ELSE m.value - m.prev END AS new_value
  FROM (
    SELECT id, user_id, metric_name, type, occurred_at, value,
           LAG(value) OVER (
             PARTITION BY session_id, metric_name, COALESCE(type, ''), COALESCE(model, ''), COALESCE(language, '')
             ORDER BY occurred_at, id
           ) AS prev
    FROM code_otel_metrics
    WHERE session_id IN (${CUMULATIVE_SESSIONS})
  ) m
`;

async function main() {
  await db.connect();
  const since30 = Math.floor(Date.now() / 1000) - 30 * 86400;

  const sessions = await db.query(`
    SELECT COUNT(*)::int AS sessions,
           (SELECT COUNT(DISTINCT user_id)::int FROM code_otel_metrics WHERE session_id IN (${CUMULATIVE_SESSIONS})) AS people,
           (SELECT COUNT(DISTINCT session_id)::int FROM code_otel_metrics WHERE session_id IS NOT NULL) AS all_sessions
    FROM (${CUMULATIVE_SESSIONS}) c
  `);
  const s = sessions.rows[0];
  console.log(`Sessions that sent running totals: ${s.sessions} of ${s.all_sessions}, from ${s.people} people.`);

  const totals = await db.query(`
    SELECT metric_name, COALESCE(type, '') AS type,
           ROUND(SUM(old_value)) AS before_all, ROUND(SUM(new_value)) AS after_all,
           ROUND(SUM(old_value) FILTER (WHERE occurred_at >= $1)) AS before_30d,
           ROUND(SUM(new_value) FILTER (WHERE occurred_at >= $1)) AS after_30d,
           COUNT(*)::int AS rows
    FROM (${CONVERTED}) x
    GROUP BY 1, 2 ORDER BY 1, 2
  `, [since30]);
  console.log('\nTotals on those sessions, before and after (all time | last 30 days):');
  for (const r of totals.rows) {
    const label = `${r.metric_name}${r.type ? ` (${r.type})` : ''}`;
    console.log(`  ${label.padEnd(48)} ${String(r.before_all).padStart(12)} -> ${String(r.after_all).padStart(10)} | ${String(r.before_30d ?? 0).padStart(12)} -> ${String(r.after_30d ?? 0).padStart(10)}   (${r.rows} rows)`);
  }

  // Sanity check: corrected active time cannot exceed the time the sessions span.
  const check = await db.query(`
    WITH conv AS (SELECT * FROM (${CONVERTED}) x WHERE metric_name = 'claude_code.active_time.total'),
         span AS (SELECT session_id, MAX(occurred_at) - MIN(occurred_at) AS secs FROM code_otel_metrics
                  WHERE session_id IN (${CUMULATIVE_SESSIONS}) GROUP BY session_id)
    SELECT ROUND((SELECT SUM(new_value) FROM conv) / 3600.0) AS active_hours_after,
           ROUND((SELECT SUM(secs) FROM span) / 3600.0) AS session_hours_spanned
  `);
  console.log(`\nCheck: active time after correction ${check.rows[0].active_hours_after} h, against ${check.rows[0].session_hours_spanned} h the sessions span.`);

  if (!APPLY) {
    console.log('\nReport only: nothing was changed. Run with --apply to rewrite these rows.');
    await db.end();
    return;
  }

  await db.query('BEGIN');
  const updated = await db.query(`
    UPDATE code_otel_metrics m SET value = x.new_value
    FROM (${CONVERTED}) x
    WHERE m.id = x.id AND x.new_value <> x.old_value
  `);
  await db.query('COMMIT');
  console.log(`\nRewrote ${updated.rowCount} rows. The hourly Developer Pulse roll-up recomputes its figures on its next run.`);
  await db.end();
}

main().catch(async (e) => {
  console.error('Failed:', e.message);
  try { await db.query('ROLLBACK'); } catch { /* not in a transaction */ }
  await db.end().catch(() => {});
  process.exit(1);
});
