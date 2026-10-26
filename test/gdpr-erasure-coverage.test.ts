// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// GDPR-erasure drift lock. Two guarantees:
//  (1) ENUMERATION: every user-identity column in the Postgres schema must
//      have an explicit entry in COVERAGE below — a new user-keyed table
//      turns this test red instead of silently escaping erasure.
//  (2) SOURCE COVERAGE: every 'deleted'/'nulled' entry's schema table must
//      actually be referenced inside deleteUserData()'s source — an entry
//      can't claim handling that the function doesn't perform.
// Behavioural proof (rows actually gone, FKs satisfied) lives in
// test/queries-cowork-chat-gdpr-pg.test.ts on Postgres.
//
// SCOPE NOTE (this test is a COLUMN-level model, not a content model): a
// free-text column that MENTIONS a person (pulse_briefings.body — LLM prose
// naming the person; reports.content_md; alerts.explanation) is outside what
// this test can enumerate — there is no schema signal distinguishing "this
// text column sometimes contains a name" from any other text column. Those
// are covered by hand (pulse_briefings.scope_id below deletes the ROW that
// carries the body prose; reports/alerts are accepted risk, documented in
// docs/SECURITY.md) rather than by this drift lock.
//
// ROOT-OF-DISCOVERY CAVEAT: discoverPairs() walks the hand-maintained
// `pgSchema` aggregate (lib/db/schema.pg.ts's exported table map). A table
// that exists in the database but was never added to that aggregate escapes
// enumeration entirely — this lock only catches drift in tables the schema
// aggregate already knows about.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { pgSchema } from '@/lib/db/schema.pg';

// Broadened from an exact-name set to a heuristic — any column whose name
// contains a user/owner/author/actor/manager/voter token bounded by
// underscores (or start/end of string), or ends in "_by", is a CANDIDATE
// user-identity column. This surfaces new columns automatically instead of
// requiring every future user-keyed column to be manually added to a set
// first (the exact bug class this whole file exists to prevent). Real false
// positives it surfaces (an admin-domain "_by" audit field, or a column that
// merely CONTAINS "user" as a substring, e.g. "active_time_user_s") are
// excluded via NOT_USER_IDENTITY below, each with a traced reason — never by
// narrowing the regex back down to a name list.
const USER_IDENTITY_HEURISTIC = /(^|_)(user|owner|author|actor|manager|voter)(_|$)|_by$/;

// table.column -> why the heuristic match above is a false positive here.
// Every entry was traced to its actual writer (or confirmed unwritten) before
// being added.
const NOT_USER_IDENTITY: Record<string, string> = {
  // ── admin-domain "_by" columns: hold an admin session email/id, not a
  //    monitored-user (users.id) reference ──────────────────────────────
  'pulse_events.confirmed_by':        'admin session email (mirrors attributed_by on the same table), not a users id — currently unwritten by any code path (grep finds no writer)',
  'pulse_events.attributed_by':       'admin session email — app/api/pulse/capabilities/route.ts sets it from session.email, not a users id',
  'reports.manager_only':            'a 0/1 flag (the report holds a section only admins and managers may read), not a person — matched only by the "manager" token (security re-review R3, migration 0035)',
  'pulse_rubric_versions.changed_by': 'admin session email — app/api/pulse/admin/tiers/route.ts sets it from session.email!, not a users id',
  'pulse_audit_items.reviewed_by':    'admin session email — app/api/pulse/admin/audit/route.ts passes session.email! into lib/pulse/audit/cycle.ts recordReview(), not a users id',
  'reports.generated_by':             'admin display name/email string — app/api/ai/report/route.ts sets it from session.displayName || session.email, not a users id',
  'chargeback_periods.closed_by':     'admin session email/userId string — app/api/finance/chargeback/close/route.ts sets it from session.email ?? session.userId, not a users id',
  'agents.revoked_by':                'admin_users id column of the retired agent registry, which no code path writes any more; admin domain',
  'coaching_acks.acked_by':            'admin session email — app/api/pulse/coaching/ack/route.ts sets it from getAdminSession().email, not a users id',
  'otel_identity_aliases.created_by':   'admin session email — lib/otel/identity-conflicts.ts decideIdentityConflict() sets it from the deciding admin, not a monitored user',
  'otel_identity_conflicts.decided_by': 'admin session email — lib/otel/identity-conflicts.ts decideIdentityConflict() sets it from the deciding admin, not a monitored user',
  // ── pure substring false positives: "user"/"by" appears in the name but
  //    the column holds no identity at all ──────────────────────────────
  'admin_sessions.user_agent':          'browser User-Agent string — substring match on "user", not a user identity column',
  'code_metrics.active_time_user_s':    'engaged-time duration metric in seconds — substring match on "user", not a user identity column',
  'code_session_stats.user_msg_count':  'message count column — substring match on "user", not a user identity column',
  'cowork_sessions.user_selected_folders': 'JSON array of folder paths the user selected in-app — substring match on "user", not a user identity column',
  'use_case_skill_drafts.owner_questions_json': 'JSON array of clarifying questions for the skill draft\'s human owner to answer — substring match on "owner", not a user identity column (the table itself carries no user-identity columns at all; see its migration comment)',
};

type Status = 'deleted' | 'nulled' | 'db-cascade' | 'db-set-null' | 'allowlisted';

// table.column -> how erasure handles it. Every entry carries its reason.
const COVERAGE: Record<string, { status: Status; why: string }> = {
  // ── deleted directly by deleteUserData ─────────────────────────────────
  'pulse_skill_runs.user_id':            { status: 'deleted', why: 'preOps' },
  'pulse_classifications.user_id':       { status: 'deleted', why: 'preOps' },
  'pulse_events.user_id':                { status: 'deleted', why: 'preOps' },
  'pulse_team_assessments.assessed_by':  { status: 'deleted', why: 'preOps' },
  'pulse_baselines.set_by':              { status: 'deleted', why: 'preOps' },
  'pulse_metrics.scope_id':              { status: 'deleted', why: 'user-scope rows only (scope_type=user)' },
  'pulse_briefings.scope_id':            { status: 'deleted', why: 'user-scope LLM briefing prose (contains display name); org/dept rows survive' },
  'chat_messages.user_id':               { status: 'deleted', why: 'preOps' },
  'github_user_repo_stats.user_id':      { status: 'deleted', why: 'preOps' },
  'github_identity_map.user_id':         { status: 'deleted', why: 'preOps' },
  'cowork_messages.user_id':             { status: 'deleted', why: 'core' },
  'cowork_sessions.user_id':             { status: 'deleted', why: 'core' },
  'otel_events.user_id':                 { status: 'deleted', why: 'core' },
  'compliance_events.user_id':           { status: 'deleted', why: 'core' },
  'analytics_snapshots.user_id':         { status: 'deleted', why: 'core' },
  'alerts.user_id':                      { status: 'deleted', why: 'core' },
  'agents.user_id':                      { status: 'deleted', why: 'postOps' },
  // ── this effort adds (Tasks 2-3) ───────────────────────────────────────
  'cowork_session_stats.user_id':        { status: 'deleted', why: 'P0: NO ACTION FK blocked user delete' },
  'cowork_session_descriptions.user_id': { status: 'deleted', why: 'model-written description of a session (migration 0028)' },
  'use_case_session_judgements.user_id': { status: 'deleted', why: 'model-written reason about a session (migration 0032)' },
  'chat_assistant_meta.user_id':         { status: 'deleted', why: 'blocker-class: NO ACTION FK (mig 0004)' },
  'code_assistant_meta.user_id':         { status: 'deleted', why: 'P1' },
  'code_session_stats.user_id':          { status: 'deleted', why: 'P1' },
  'code_otel_metrics.user_id':           { status: 'deleted', why: 'P1' },
  'code_session_classifications.user_id':{ status: 'deleted', why: 'P1' },
  'code_metrics.scope_id':               { status: 'deleted', why: 'user-scope rows only, mirrors pulse_metrics' },
  'use_case_week_matches.user_id':       { status: 'deleted', why: 'user_id is in the PK — cannot null; junction rows go (weekly aggregates in use_case_activation_weeks survive; historical distinct-user recomputes shrink — accepted, erasure means erasure)' },
  'coaching_acks.user_id':               { status: 'deleted', why: 'Coaching acknowledgement rows are per-user; also FK ON DELETE CASCADE (belt-and-braces, deleted explicitly like the rest of this list)' },
  'otel_identity_conflicts.existing_user_id': { status: 'deleted', why: 'identity-conflict rows naming the person on either side are deleted (migration 083)' },
  'otel_identity_conflicts.new_user_id':      { status: 'deleted', why: 'identity-conflict rows naming the person on either side are deleted (migration 083)' },
  'otel_identity_aliases.user_id':            { status: 'deleted', why: 'merge aliases pointing at the person, plus the alias keyed by their own email' },
  'use_cases.owner_user_id':             { status: 'nulled', why: 'attribution field — mirrors pulse_skills.author_user_id' },
  'pulse_skills.author_user_id':         { status: 'nulled', why: 'existing behaviour' },
  'users.manager_id':                    { status: 'nulled', why: 'self-FK NO ACTION: erasing a manager must not fail' },
  // ── handled by the database itself ─────────────────────────────────────
  'cowork_skill_invocations.user_id':    { status: 'db-cascade', why: 'FK ON DELETE CASCADE (0000 snapshot)' },
  'cowork_mcp_invocations.user_id':      { status: 'db-cascade', why: 'FK ON DELETE CASCADE' },
  'pulse_user_prefs.user_id':            { status: 'db-cascade', why: 'FK ON DELETE CASCADE' },
  'skill_library_votes.voter_user_id':   { status: 'db-cascade', why: 'FK ON DELETE CASCADE' },
  'skill_library_entries.author_user_id':{ status: 'db-set-null', why: 'FK ON DELETE SET NULL' },
  'admin_users.linked_cowork_user_id':   { status: 'db-set-null', why: 'FK ON DELETE SET NULL' },
  // ── allowlisted, with reasons ──────────────────────────────────────────
  // NOTE: github_unmatched_authors.identity/github_identity_map.identity are
  // deliberately NOT listed here — 'identity' isn't a user-identity column
  // shape (it's an external git-author identity string, e.g. an email, not a
  // users.id reference), so discoverPairs() never surfaces it as a pair and
  // an entry here would be a permanently-stale one caught by the second test
  // below. The decision not to touch it is documented in queries.ts's preOps
  // comment instead ("identity-keyed, not user-keyed... deliberately not
  // touched here").
  'github_identity_map.created_by':      { status: 'allowlisted', why: 'admin_users id (audit provenance), not a monitored-user id' },
  'alerts.resolved_by':                  { status: 'allowlisted', why: 'admin_users id' },
  'admin_sessions.user_id':              { status: 'allowlisted', why: 'admin_users domain (cascade from admin_users)' },
  'password_reset_tokens.user_id':       { status: 'allowlisted', why: 'admin_users domain' },
  'totp_recovery_codes.user_id':         { status: 'allowlisted', why: 'admin_users domain' },
  'totp_consumed_steps.user_id':         { status: 'allowlisted', why: 'admin_users domain — TOTP replay-guard claim keyed by admin_users.id (mig 078), not a monitored-user id; cleared by disableTotp()/deleteAdminUser() rather than by deleteUserData()' },
  'access_audit_log.actor_id':           { status: 'allowlisted', why: 'immutable audit trail — legal-basis retention, never erased (audit DB, triggers reject DELETE)' },
  // ── discovered during a coverage sweep ──
  'enrollment_tokens.created_by':        { status: 'allowlisted', why: 'admin_users id of the retired agent enrolment flow, which no code path writes any more (it was always null in practice); not a monitored-user id' },
  'use_cases.created_by':                { status: 'allowlisted', why: 'admin_users id — every write path sets it from getAdminSession().userId (guided-form/extract/ideate/suggestion routes are all admin|manager-gated); distinct from use_cases.owner_user_id, which IS a monitored-user id and is already covered as nulled' },
};

// A handful of column-level (as opposed to whole-table) COVERAGE entries
// share a table with OTHER unrelated schema.<key> references in deleteUserData
// (e.g. schema.users appears constantly — seeding the target row, nulling
// manager_id, the final delete). For those, checking merely "schema.<key>
// appears somewhere in the function body" would pass even if the specific
// nulling/deleting statement were removed. Entries listed here additionally
// require the given literal substring to appear in the body too.
const EXTRA_BODY_CHECK: Record<string, string> = {
  'users.manager_id': 'manager_id',
};

function discoverPairs(): string[] {
  const pairs: string[] = [];
  for (const table of Object.values(pgSchema)) {
    // schema aggregate also exports relations/helpers — only walk real tables
    let name: string;
    try { name = getTableName(table as never); } catch { continue; }
    const cols = getTableColumns(table as never);
    for (const colName of Object.keys(cols)) {
      if (!USER_IDENTITY_HEURISTIC.test(colName)) continue;
      const pairKey = `${name}.${colName}`;
      if (pairKey in NOT_USER_IDENTITY) continue;
      pairs.push(pairKey);
    }
    // C1(b): generalised scope_id detection — ANY table carrying BOTH
    // scope_type and scope_id columns is treated as scope_id being a
    // user-identity column (when scope_type='user', deleteUserData's
    // established convention across pulse_metrics/code_metrics/
    // pulse_briefings). Table-name-agnostic so a future scope_type/scope_id
    // table is caught by this test automatically, instead of requiring a
    // hardcoded table name to be added here first — the exact bug class
    // that once let pulse_briefings escape erasure.
    if ('scope_type' in cols && 'scope_id' in cols) {
      pairs.push(`${name}.scope_id`);
    }
  }
  return pairs.sort();
}

describe('gdpr erasure coverage drift-lock', () => {
  const pairs = discoverPairs();

  it('every user-identity column has an explicit coverage entry', () => {
    const missing = pairs.filter(p => !(p in COVERAGE));
    expect(missing, `New/unmapped user-identity columns — add them to deleteUserData() (or allowlist WITH a reason): ${missing.join(', ')}`).toEqual([]);
  });

  it('no stale coverage entries for columns that no longer exist', () => {
    // access_audit_log lives in the separate audit schema — exempt from discovery.
    const known = new Set(pairs);
    const stale = Object.keys(COVERAGE).filter(k => !known.has(k) && !k.startsWith('access_audit_log.'));
    expect(stale).toEqual([]);
  });

  it("every 'deleted'/'nulled' entry is actually referenced in deleteUserData's source", () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/db/queries.ts'), 'utf8');
    const fnStart = src.indexOf('export async function deleteUserData');
    expect(fnStart).toBeGreaterThan(-1);
    // function body ends at the next top-level export after it
    const rest = src.slice(fnStart + 10);
    const fnEnd = rest.indexOf('\nexport ');
    const body = rest.slice(0, fnEnd === -1 ? undefined : fnEnd);

    // table name -> schema aggregate key (schema.<key>) for source matching
    const tableToSchemaKey: Record<string, string> = {};
    for (const [key, table] of Object.entries(pgSchema)) {
      try { tableToSchemaKey[getTableName(table as never)] = key; } catch { /* not a table */ }
    }

    const unhandled = Object.entries(COVERAGE)
      .filter(([, v]) => v.status === 'deleted' || v.status === 'nulled')
      .filter(([pairKey]) => {
        const tableName = pairKey.split('.')[0];
        const key = tableName === 'users' ? 'users' : tableToSchemaKey[tableName];
        if (!key) return true; // unhandled — no schema mapping found for this table

        // Word-boundary the match — a plain `.includes()` would let
        // `schema.coworkSessions` be satisfied by a body that only contains
        // `schema.coworkSessionStats` (a DIFFERENT table whose key happens to
        // start with the same prefix). Require the character right after the
        // key to be a non-identifier character (or end of string).
        const hit = new RegExp('schema\\.' + key + '(?![A-Za-z0-9_])').test(body);
        if (!hit) return true;

        // A handful of column-level entries additionally require their
        // literal column name in the body (see EXTRA_BODY_CHECK above) —
        // otherwise a table referenced elsewhere in the function for
        // unrelated reasons (schema.users is everywhere) would trivially
        // "pass" even if this specific op were deleted.
        const extra = EXTRA_BODY_CHECK[pairKey];
        if (extra && !body.includes(extra)) return true;

        return false;
      })
      .map(([pairKey]) => pairKey);
    expect(unhandled, `COVERAGE claims these are handled but deleteUserData never references them: ${unhandled.join(', ')}`).toEqual([]);
  });
});
