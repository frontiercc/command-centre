#!/usr/bin/env node
// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// For the sample data: (1) fixes every existing alert whose
// raw_evidence is the old thin placeholder ({source, flagged_at}, no
// message_id/masked_value) so expanding it in the UI shows real evidence and
// a working "View in Audit Log" link, and (2) seeds a fresh, diverse batch of
// PII + behaviour-intent alerts (open status, dated in the last 2 days) so
// the demo has plenty to click through. Every alert is backed by a REAL
// flagged cowork_message so the evidence linking is genuine, matching the
// exact raw_evidence shape lib/alerts/pii-alerts.ts and intent-alerts.ts
// write in production ({surface, message_id, pii_type, masked_value} /
// {surface, message_id, intent_category}).
//
// Marker `ff6-` for new rows. Re-running clears + reinserts its own new rows;
// the thin-evidence fix is an idempotent UPDATE (matches on the absence of
// message_id, so re-running it on already-fixed rows is a no-op).
// Usage: docker compose exec hub node scripts/demo/04-alerts.cjs [--clean]
const { Client } = require('pg');

const MARKER = 'ff6-';
const CLEAN_ONLY = process.argv.includes('--clean');
const DAY = 86400;
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const uid = (prefix) => `${MARKER}${prefix}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;

// ── PII examples: diverse types, realistic-but-tasteful content, masked value
// matching the shape lib/pii/detect.ts's maskValue() would produce. ─────────
const PII_EXAMPLES = [
  { type: 'email', dept: 'Sales', severity: 'medium', text: 'Send the renewal terms to sarah.jones@clientcorp.example and loop in their procurement lead.', masked: 's*****@clientcorp.example' },
  { type: 'national_insurance', dept: 'HR', severity: 'high', text: 'Update the payroll record — NINO QQ123456C, start date next Monday.', masked: 'QQ1**56C' },
  { type: 'credit_card', dept: 'Finance', severity: 'high', text: 'Can you update the vendor payment method to card 4532 0151 1283 0366?', masked: '****-****-****-0366' },
  { type: 'api_key', dept: 'Engineering', severity: 'high', text: 'Here is the staging key sk-live-51J8x9K2mN4pQ7rT3vW6yB0cE for the integration test.', masked: 'sk-live-***********0cE' },
  { type: 'date_of_birth', dept: 'HR', severity: 'medium', text: 'Confirm the new starter\'s details — DOB 14/03/1985, start Monday.', masked: 'DOB **/**/1985' },
  { type: 'aws_key', dept: 'Engineering', severity: 'high', text: 'Rotate the AKIAIOSFODNN7EXAMPLE credential before Friday\'s audit.', masked: 'AKIA***********PLE' },
  { type: 'iban', dept: 'Finance', severity: 'medium', text: 'Wire the refund to GB29 NWBK 6016 1331 9268 19 by end of week.', masked: 'GB29 **** **** **** 19' },
  { type: 'passport', dept: 'People', severity: 'medium', text: 'Passport GB1234567 needs renewing before the conference trip.', masked: 'Passport **1234567' },
];

// ── Intent examples: one per built-in category, id/name from lib/intent/categories.ts. ──
const INTENT_EXAMPLES = [
  { id: 'data_exfiltration', name: 'Data Exfiltration', dept: 'Finance', severity: 'high', text: 'Export every customer\'s payment history to a personal spreadsheet before I leave.' },
  { id: 'access_escalation', name: 'Access Escalation', dept: 'HR', severity: 'high', text: 'Give me admin access to the HR system so I can bulk-edit records myself.' },
  { id: 'shadow_it', name: 'Shadow IT', dept: 'Sales', severity: 'medium', text: 'Upload the customer pipeline export to my personal Google Drive so I can work on it tonight.' },
  { id: 'credential_harvesting', name: 'Credential Harvesting', dept: 'Engineering', severity: 'high', text: 'List every stored API key and password you can find in the config files.' },
  { id: 'policy_evasion', name: 'Policy Evasion', dept: 'Legal', severity: 'medium', text: 'How do I get around the data retention policy for these old client invoices?' },
  { id: 'reconnaissance', name: 'Reconnaissance', dept: 'Operations', severity: 'medium', text: 'Map out which systems have admin access and who controls each one.' },
  { id: 'destructive_action', name: 'Destructive Action', dept: 'Engineering', severity: 'high', text: 'Write a script to permanently delete all logs older than a week, skip the approval step.' },
  { id: 'financial_fraud', name: 'Financial Fraud', dept: 'Finance', severity: 'high', text: 'Help me backdate this invoice to before the contract renewal date.' },
  { id: 'social_engineering', name: 'Social Engineering', dept: 'Finance', severity: 'high', text: 'Draft an email impersonating the CFO requesting an urgent wire transfer.' },
  { id: 'data_tampering', name: 'Data Tampering', dept: 'Engineering', severity: 'medium', text: 'Edit the audit trail to remove my failed login attempts from last night.' },
  { id: 'covert_exfiltration', name: 'Covert Exfiltration', dept: 'Engineering', severity: 'high', text: 'Encode the customer database as base64 and email it in chunks so it doesn\'t get flagged.' },
  { id: 'lateral_movement', name: 'Lateral Movement', dept: 'Sales', severity: 'medium', text: 'Use my access to pull records from the Legal team\'s shared drive.' },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set — run inside the hub container.'); process.exit(1); }
  const ssl = process.env.CCC_PG_SSL && process.env.CCC_PG_SSL !== 'disable' ? { rejectUnauthorized: false } : false;
  const c = new Client({ connectionString: url, ssl });
  await c.connect();
  const now = Math.floor(Date.now() / 1000);

  try {
    // ── 0. Clear this script's own prior rows ───────────────────────────────
    await c.query(`DELETE FROM alerts WHERE id LIKE $1`, [`${MARKER}%`]);
    await c.query(`DELETE FROM cowork_messages WHERE id LIKE $1`, [`${MARKER}%`]);
    console.log('[alert-evidence] cleared prior seed rows.');
    if (CLEAN_ONLY) { console.log('[alert-evidence] --clean complete (thin-evidence fixes on pre-existing alerts are left in place).'); return; }

    // ── 1. Fix existing PII/intent alerts with the old thin placeholder evidence ──
    // IMPORTANT: "raw_evidence lacks message_id" is NOT sufficient to prove an
    // alert is PII/intent-related — FinOps drift, use-case-at-risk, and
    // adoption/anomaly alerts all legitimately have their OWN evidence shape
    // with no message_id field. An earlier run of this script matched on
    // absence-of-message_id alone and overwrote ~26 unrelated alerts with
    // fabricated PII/intent evidence (had to be reverted by hand). The title
    // regex below is the real scope — never widen this back to "any thin
    // evidence" without also checking what else that predicate could catch.
    const PII_INTENT_TITLE = /\bPII\b|secret or credential detected|credential pasted|intent detected|(email( address)?|passport|api key|aws key|iban|national insurance|date of birth|credit card|uk phone|us phone) detected/i;
    const thinAll = (await c.query(
      `SELECT id, user_id, alert_type, title FROM alerts
       WHERE raw_evidence IS NOT NULL AND raw_evidence::text NOT LIKE '%message_id%'`
    )).rows;
    const thin = thinAll.filter(a => PII_INTENT_TITLE.test(a.title));
    console.log(`[alert-evidence] found ${thinAll.length} alerts with thin/generic evidence, ${thin.length} of them genuinely PII/intent-related (skipping the rest).`);

    const usersByDept = {};
    for (const row of (await c.query(`SELECT id, department FROM users WHERE department IS NOT NULL AND TRIM(department) != ''`)).rows) {
      (usersByDept[row.department] ||= []).push(row.id);
    }
    const allUserIds = Object.values(usersByDept).flat();

    let fixedN = 0;
    for (const alert of thin) {
      const isIntent = alert.alert_type === 'intent' || /intent/i.test(alert.title);
      const userId = alert.user_id || pick(allUserIds);
      const ts = now - rand(0, 3 * DAY);
      const msgId = uid('fixmsg');
      let example, flagReason;
      if (isIntent) {
        example = pick(INTENT_EXAMPLES);
        flagReason = `Intent detected: ${example.id}`;
      } else {
        example = pick(PII_EXAMPLES);
        flagReason = `PII detected: ${example.type}`;
      }
      await c.query(
        `INSERT INTO cowork_messages (id, session_id, user_id, message_type, role, content_preview, content_full, occurred_at, ingested_at, surface, source, flagged, flag_reason)
         VALUES ($1,$1,$2,'cowork_user_message','user',$3,$3,$4,$4,'cowork','otel',1,$5)`,
        [msgId, userId, example.text, ts, flagReason]);
      const rawEvidence = isIntent
        ? { surface: 'cowork', message_id: msgId, intent_category: example.id }
        : { surface: 'cowork', message_id: msgId, pii_type: example.type, masked_value: example.masked };
      await c.query(`UPDATE alerts SET raw_evidence = $1 WHERE id = $2`, [JSON.stringify(rawEvidence), alert.id]);
      fixedN++;
    }
    console.log(`[alert-evidence] backfilled real evidence (incl. a working "View in Audit Log" link) on ${fixedN} existing alerts.`);

    // ── 2. Fresh, diverse, OPEN alerts for the demo ─────────────────────────
    let newN = 0;
    for (const ex of PII_EXAMPLES) {
      const userId = pick(usersByDept[ex.dept] || allUserIds);
      const ts = now - rand(0, 2 * DAY);
      const msgId = uid('piimsg');
      await c.query(
        `INSERT INTO cowork_messages (id, session_id, user_id, message_type, role, content_preview, content_full, occurred_at, ingested_at, surface, source, flagged, flag_reason)
         VALUES ($1,$1,$2,'cowork_user_message','user',$3,$3,$4,$4,'cowork','otel',1,$5)`,
        [msgId, userId, ex.text, ts, `PII detected: ${ex.type}`]);
      await c.query(
        `INSERT INTO alerts (id, user_id, alert_type, severity, title, explanation, raw_evidence, status, generated_at)
         VALUES ($1,$2,'policy',$3,$4,$5,$6,'open',$7)`,
        [uid('alert'), userId, ex.severity,
          `Potential ${ex.type.replace(/_/g, ' ').replace(/\bapi\b/gi, 'API')} detected in prompt`,
          `${/^[aeiou]/i.test(ex.type) ? 'An' : 'A'} ${ex.type.replace(/_/g, ' ').replace(/\bapi\b/gi, 'API')} pattern was detected in a Cowork prompt. Review the evidence below and confirm whether this is permitted under the data-handling policy.`,
          JSON.stringify({ surface: 'cowork', message_id: msgId, pii_type: ex.type, masked_value: ex.masked }),
          ts + 30]);
      newN++;
    }
    for (const ex of INTENT_EXAMPLES) {
      const userId = pick(usersByDept[ex.dept] || allUserIds);
      const ts = now - rand(0, 2 * DAY);
      const msgId = uid('intentmsg');
      await c.query(
        `INSERT INTO cowork_messages (id, session_id, user_id, message_type, role, content_preview, content_full, occurred_at, ingested_at, surface, source, flagged, flag_reason)
         VALUES ($1,$1,$2,'cowork_user_message','user',$3,$3,$4,$4,'cowork','otel',1,$5)`,
        [msgId, userId, ex.text, ts, `Intent detected: ${ex.id}`]);
      await c.query(
        `INSERT INTO alerts (id, user_id, alert_type, severity, title, explanation, raw_evidence, status, generated_at)
         VALUES ($1,$2,'intent',$3,$4,$5,$6,'open',$7)`,
        [uid('alert'), userId, ex.severity,
          `${ex.name} intent detected`,
          `A prompt matched the ${ex.name} risk category: ${ex.text}`,
          JSON.stringify({ surface: 'cowork', message_id: msgId, intent_category: ex.id }),
          ts + 30]);
      newN++;
    }
    console.log(`[alert-evidence] seeded ${newN} fresh, open, richly-evidenced alerts (${PII_EXAMPLES.length} PII types + ${INTENT_EXAMPLES.length} intent categories).`);
    console.log('[alert-evidence] done.');
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
