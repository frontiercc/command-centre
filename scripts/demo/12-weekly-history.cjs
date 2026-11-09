// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Sample data: the all-products weekly history (pulse_metrics, granularity
// 'week'), worked out last, once every sample prompt is in and graded.
// 01-organisation.cjs writes a first version, but later steps add the
// follow-up prompts (10-conversations.cjs) and the ChatGPT prompts
// (11-chatgpt-codex.ts), so without this the All view's past weeks would
// count fewer prompts than the Claude and OpenAI views. Same counts and same
// department rule as 01-organisation.cjs. Run by scripts/demo/load.cjs.
const { Client } = require('pg');

const WEEK = 7 * 86400;
// Every completed week the sample reaches back over (90 days, inside 14 weeks).
const WEEKS = 14;

function weekStart(ts) {
  const d = new Date(ts * 1000);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  return midnight - ((d.getUTCDay() + 6) % 7) * 86400;
}

const COUNTS = `SUM(CASE WHEN pc.tier = 1 THEN 1 ELSE 0 END) AS t1,
  SUM(CASE WHEN pc.tier = 2 THEN 1 ELSE 0 END) AS t2,
  SUM(CASE WHEN pc.tier = 3 THEN 1 ELSE 0 END) AS t3,
  COUNT(*) AS total`;

const UPSERT = `INSERT INTO pulse_metrics (scope_type, scope_id, period_start, period_end, dds, event_count, tier_1_count, tier_2_count, tier_3_count, computed_at, granularity)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'week')
  ON CONFLICT (scope_type, scope_id, period_start) WHERE granularity = 'week'
  DO UPDATE SET period_end = EXCLUDED.period_end, dds = EXCLUDED.dds, event_count = EXCLUDED.event_count,
    tier_1_count = EXCLUDED.tier_1_count, tier_2_count = EXCLUDED.tier_2_count, tier_3_count = EXCLUDED.tier_3_count,
    computed_at = EXCLUDED.computed_at`;

(async () => {
  const ssl = process.env.CCC_PG_SSL && process.env.CCC_PG_SSL !== 'disable' ? { rejectUnauthorized: false } : false;
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl });
  await db.connect();
  const now = Math.floor(Date.now() / 1000);
  const current = weekStart(now);
  let users = 0, departments = 0;

  // Clear the completed weeks first: an earlier step's row for someone with no
  // graded prompts left that week would otherwise stay behind.
  await db.query(
    `DELETE FROM pulse_metrics WHERE granularity = 'week' AND scope_type IN ('user', 'function')
       AND period_start >= $1 AND period_start < $2`, [current - WEEKS * WEEK, current]);

  const write = async (scopeType, scopeId, wStart, row) => {
    const total = Number(row.total ?? 0);
    if (total === 0) return false;
    const t1 = Number(row.t1 ?? 0), t2 = Number(row.t2 ?? 0), t3 = Number(row.t3 ?? 0);
    await db.query(UPSERT, [scopeType, scopeId, wStart, wStart + WEEK - 1, (3 * t3 + 2 * t2 + t1) / total, total, t1, t2, t3, now]);
    return true;
  };

  for (let weeksAgo = WEEKS; weeksAgo >= 1; weeksAgo--) {
    const wStart = current - weeksAgo * WEEK;
    const wEnd = wStart + WEEK - 1;
    const perUser = await db.query(
      `SELECT pc.user_id, ${COUNTS}
         FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
        WHERE pc.classifier_status = 'classified' AND cm.occurred_at >= $1 AND cm.occurred_at <= $2
        GROUP BY pc.user_id`, [wStart, wEnd]);
    for (const row of perUser.rows) if (row.user_id && await write('user', row.user_id, wStart, row)) users++;

    const perDept = await db.query(
      `SELECT u.department, ${COUNTS}
         FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
         JOIN users u ON u.id = pc.user_id
        WHERE pc.classifier_status = 'classified' AND cm.occurred_at >= $1 AND cm.occurred_at <= $2
          AND u.department IS NOT NULL AND u.department <> ''
        GROUP BY u.department`, [wStart, wEnd]);
    for (const row of perDept.rows) if (await write('function', row.department, wStart, row)) departments++;
  }

  console.log(`${users} person weeks and ${departments} department weeks of all-products history.`);
  await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
