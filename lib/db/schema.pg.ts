// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The Postgres schema — the only database schema. Column types:
//   • JSON columns  -> jsonb
//   • money columns -> numeric  (spend_usd / cost_usd / total_cost_usd)
//   • other REAL    -> doublePrecision (ratios / scores)
//   • epoch-second integers -> bigint (future-proof past 2038)
//   • former AUTOINCREMENT PKs -> generatedByDefaultAsIdentity (explicit ids still
//     insertable during the data copy)
//   • 0/1 flags KEPT AS integer — a CONFIRMED policy (not a
//     provisional default): admin_users.totp_enabled/failed_login_count/
//     sso_enabled, cowork/chat/compliance `flagged`, pulse_classifications'
//     frontier/capability candidate flags, use_cases.strategic, etc. all stay
//     `integer`/`smallint` on Postgres, NOT `boolean`. Rationale: the app's
//     ~800 query-builder call sites read/write these as 0/1
//     (`= 1`, `? 1 : 0`, truthy-int checks) — converting to a real `boolean`
//     column would require auditing and rewriting every one of those sites
//     for a purely cosmetic type win. No column in this file should be
//     changed to `boolean()`; if a future task proposes one, it must repeat
//     that full call-site audit first.
//   • email uniqueness: only `admin_users.email` is `citext` (case-INSENSITIVE
//     equality + unique constraint). `users.email` is deliberately plain
//     `text` UNIQUE (case-SENSITIVE); making it citext would change how
//     existing matches behave (the OTel receiver matches users.email exactly).

import {
  pgTable, text, integer, bigint, doublePrecision, numeric, jsonb,
  index, uniqueIndex, foreignKey, primaryKey, unique, customType,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Postgres `citext` (case-insensitive text; contrib extension, shipped in the
// `postgres:16` image used by testcontainers) — gives `admin_users.email`
// case-insensitive EQUALITY and a case-insensitive UNIQUE constraint.
// drizzle-orm has no
// built-in `citext()` builder, so it's modelled via `customType`; the
// extension itself is created by lib/db/migrations-pg (`CREATE EXTENSION IF
// NOT EXISTS citext;`) before any table that uses this type.
const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

export const adminSessions = pgTable('admin_sessions', {
    id: text().primaryKey(),
    user_id: text().notNull(),
    expires_at: bigint({ mode: 'number' }).notNull(),
    created_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
    ip_address: text(),
    user_agent: text(),
    last_used_at: bigint({ mode: 'number' }),
}, (t) => [
    foreignKey({ columns: [t.user_id], foreignColumns: [adminUsers.id], name: 'admin_sessions_user_id_fk' }).onDelete('cascade'),
    index('idx_admin_sessions_expires').on(t.expires_at),
    index('idx_admin_sessions_user').on(t.user_id),
]);

export const adminUsers = pgTable('admin_users', {
    id: text().primaryKey(),
    email: citext('email').notNull(),
    password_hash: text().notNull(),
    display_name: text(),
    role: text().notNull().default('viewer'),
    created_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
    updated_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
    last_login_at: bigint({ mode: 'number' }),
    department: text(),
    totp_secret: text(),
    totp_enabled: integer().notNull().default(0),
    linked_cowork_user_id: text(),
    failed_login_count: integer().notNull().default(0),
    locked_until: integer(),
    sso_enabled: integer().notNull().default(0),
}, (t) => [
    foreignKey({ columns: [t.linked_cowork_user_id], foreignColumns: [users.id], name: 'admin_users_linked_cowork_user_id_fk' }).onDelete('set null'),
    unique('admin_users_email_uq').on(t.email),
]);

export const agents = pgTable('agents', {
    id: text().primaryKey(),
    display_name: text(),
    user_id: text(),
    hostname: text().notNull(),
    os_type: text().notNull(),
    agent_version: text(),
    token_hash: text().notNull(),
    status: text().notNull().default('active'),
    revoked_at: bigint({ mode: 'number' }),
    revoked_by: text(),
    last_seen_at: bigint({ mode: 'number' }),
    enrolled_at: bigint({ mode: 'number' }).notNull(),
    created_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
}, (t) => [
    foreignKey({ columns: [t.user_id], foreignColumns: [users.id], name: 'agents_user_id_fk' }),
    index('idx_agents_user_id').on(t.user_id),
    index('idx_agents_status').on(t.status),
    unique('agents_token_hash_uq').on(t.token_hash),
]);

export const alerts = pgTable('alerts', {
    id: text().primaryKey(),
    user_id: text(),
    alert_type: text().notNull(),
    severity: text().notNull(),
    title: text().notNull(),
    explanation: text().notNull(),
    raw_evidence: jsonb(),
    status: text().default('open'),
    generated_at: bigint({ mode: 'number' }).default(sql`extract(epoch from now())`),
    resolved_at: bigint({ mode: 'number' }),
    resolved_by: text(),
}, (t) => [
    foreignKey({ columns: [t.user_id], foreignColumns: [users.id], name: 'alerts_user_id_fk' }),
    index('idx_alerts_generated_at').on(t.generated_at),
    index('idx_alerts_user').on(t.user_id),
    index('idx_alerts_severity').on(t.severity),
    index('idx_alerts_status').on(t.status),
]);

export const analyticsSnapshots = pgTable('analytics_snapshots', {
    id: text().primaryKey(),
    user_id: text(),
    snapshot_date: text().notNull(),
    conversations: integer().default(0),
    messages_sent: integer().default(0),
    projects_created: bigint({ mode: 'number' }).default(0),
    files_uploaded: integer().default(0),
    artifacts_created: bigint({ mode: 'number' }).default(0),
    skills_used: bigint({ mode: 'number' }).default(0),
    connectors_used: bigint({ mode: 'number' }).default(0),
    code_commits: integer().default(0),
    code_prs: integer().default(0),
    code_lines: integer().default(0),
    surface_chat: integer().default(0),
    surface_code: integer().default(0),
    surface_cowork: integer().default(0),
}, (t) => [
    foreignKey({ columns: [t.user_id], foreignColumns: [users.id], name: 'analytics_snapshots_user_id_fk' }),
    index('idx_analytics_user_date').on(t.user_id, t.snapshot_date),
    unique('analytics_snapshots_user_id_snapshot_date_uq').on(t.user_id, t.snapshot_date),
]);

export const authEvents = pgTable('auth_events', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    agent_id: text(),
    event_type: text().notNull(),
    ip_address: text(),
    details: text(),
    created_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
}, (t) => [
    index('idx_auth_events_created').on(t.created_at),
    index('idx_auth_events_type').on(t.event_type),
]);

export const chargebackCostCentres = pgTable('chargeback_cost_centres', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    code: text(),
    name: text().notNull(),
    created_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
});

export const chargebackDeptMap = pgTable('chargeback_dept_map', {
    department: text().primaryKey(),
    cost_centre_id: integer().notNull(),
}, (t) => [
    foreignKey({ columns: [t.cost_centre_id], foreignColumns: [chargebackCostCentres.id], name: 'chargeback_dept_map_cost_centre_id_fk' }).onDelete('cascade'),
]);

export const chargebackPeriods = pgTable('chargeback_periods', {
    period: text().primaryKey(),
    status: text().notNull().default('open'),
    closed_at: bigint({ mode: 'number' }),
    closed_by: text(),
    snapshot_json: text(),
    estimated: integer().notNull().default(0),
});

export const chatMessages = pgTable('chat_messages', {
    id: text().primaryKey(),
    conversation_id: text(),
    user_id: text(),
    prompt_text: text().notNull(),
    prompt_length: integer().notNull(),
    attachments_count: integer().default(0),
    files_count: integer().default(0),
    flagged: integer().default(0),
    flag_reason: text(),
    occurred_at: bigint({ mode: 'number' }).notNull(),
    ingested_at: bigint({ mode: 'number' }).default(sql`extract(epoch from now())`),
    agent_id: text(),
    source: text().notNull().default('agent'),
}, (t) => [
    foreignKey({ columns: [t.user_id], foreignColumns: [users.id], name: 'chat_messages_user_id_fk' }),
    index('idx_chat_messages_ingested_at').on(t.ingested_at),
    index('idx_chat_messages_flagged').on(t.flagged),
    index('idx_chat_messages_conversation').on(t.conversation_id, t.occurred_at),
    index('idx_chat_messages_user').on(t.user_id, t.occurred_at),
    index('idx_chat_messages_source').on(t.source),
]);

export const codeAssistantMeta = pgTable('code_assistant_meta', {
    id: text().primaryKey(),
    user_id: text(),
    session_id: text().notNull(),
    model: text(),
    input_tokens: integer().notNull().default(0),
    output_tokens: integer().notNull().default(0),
    cache_creation_tokens: integer().notNull().default(0),
    cache_read_tokens: integer().notNull().default(0),
    stop_reason: text(),
    tool_use_count: integer().notNull().default(0),
    error_count: integer().notNull().default(0),
    cwd: text(),
    git_branch: text(),
    occurred_at: bigint({ mode: 'number' }).notNull(),
    ingested_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
    commit_count: integer().notNull().default(0),
    source: text().notNull().default('agent'),
    prompt_id: text(),
    query_source: text(),
    agent_name: text(),
    skill_name: text(),
    effort: text(),
}, (t) => [
    index('idx_cam_prompt_id').on(t.prompt_id),
    index('idx_cam_source').on(t.source),
    index('idx_cam_model').on(t.model),
    index('idx_cam_session').on(t.session_id),
    index('idx_cam_user_time').on(t.user_id, t.occurred_at),
    index('idx_cam_agent_name').on(t.agent_name, t.occurred_at).where(sql`agent_name IS NOT NULL`),
]);

export const chatAssistantMeta = pgTable('chat_assistant_meta', {
    id: text().primaryKey(),
    conversation_id: text(),
    user_id: text(),
    model: text(),
    artifacts_count: integer().notNull().default(0),
    generated_files_count: integer().notNull().default(0),
    occurred_at: bigint({ mode: 'number' }).notNull(),
    ingested_at: bigint({ mode: 'number' }).default(sql`extract(epoch from now())`),
}, (t) => [
    foreignKey({ columns: [t.user_id], foreignColumns: [users.id], name: 'chat_assistant_meta_user_id_fk' }),
    index('idx_chat_am_conversation').on(t.conversation_id, t.occurred_at),
    index('idx_chat_am_user').on(t.user_id, t.occurred_at),
]);

export const codeMetrics = pgTable('code_metrics', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    scope_type: text().notNull(),
    scope_id: text().notNull(),
    period_start: bigint({ mode: 'number' }).notNull(),
    period_end: bigint({ mode: 'number' }).notNull(),
    spend_usd: numeric(),
    input_tokens: integer().notNull().default(0),
    output_tokens: integer().notNull().default(0),
    cache_hit_ratio: doublePrecision(),
    autonomy_ratio: doublePrecision(),
    session_count: integer().notNull().default(0),
    repo_count: integer().notNull().default(0),
    skill_leverage: doublePrecision(),
    friction_index: doublePrecision(),
    computed_at: bigint({ mode: 'number' }).notNull(),
    commit_count: integer().notNull().default(0),
    // bigint, not integer: a corrupted/duplicated OTel active-time data point can
    // sum past the int4 ceiling (~2.1B) — see the production incident where
    // a bad client-side metric alone summed to ~6.1B "seconds" in a 7-day window.
    active_time_user_s: bigint({ mode: 'number' }).notNull().default(0),
    active_time_cli_s: bigint({ mode: 'number' }).notNull().default(0),
    lines_added: integer().notNull().default(0),
    lines_removed: integer().notNull().default(0),
    pr_count: integer().notNull().default(0),
    edit_accept_count: integer().notNull().default(0),
    edit_reject_count: integer().notNull().default(0),
    granularity: text().notNull().default('rolling'),
}, (t) => [
    uniqueIndex('idx_code_metrics_week').on(t.scope_type, t.scope_id, t.period_start).where(sql`granularity = 'week'`),
    index('idx_code_metrics_scope').on(t.scope_type, t.scope_id, t.period_end),
]);

export const codeOtelMetrics = pgTable('code_otel_metrics', {
    id: text().primaryKey(),
    user_id: text(),
    session_id: text(),
    metric_name: text().notNull(),
    value: doublePrecision().notNull().default(0),
    type: text(),
    model: text(),
    language: text(),
    occurred_at: bigint({ mode: 'number' }).notNull(),
    ingested_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
}, (t) => [
    index('idx_com_session').on(t.session_id),
    index('idx_com_metric').on(t.metric_name, t.occurred_at),
    index('idx_com_user_time').on(t.user_id, t.occurred_at),
]);

export const codeSessionClassifications = pgTable('code_session_classifications', {
    session_id: text().primaryKey(),
    user_id: text(),
    work_type: text().notNull(),
    tier: integer().notNull(),
    confidence: doublePrecision().notNull(),
    classifier_model: text().notNull(),
    status: text().notNull().default('classified'),
    error: text(),
    classified_at: bigint({ mode: 'number' }).notNull(),
    provisional: integer().notNull().default(0),
    attempts: integer().notNull().default(1),
    human_minutes_low: integer(),
    human_minutes_likely: integer(),
    human_minutes_high: integer(),
    human_minutes_attempts: integer().notNull().default(0),
}, (t) => [
    foreignKey({ columns: [t.session_id], foreignColumns: [codeSessionStats.session_id], name: 'code_session_classifications_session_id_fk' }),
    index('idx_csc_work_type').on(t.work_type),
    index('idx_csc_user').on(t.user_id, t.classified_at),
]);

export const codeSessionStats = pgTable('code_session_stats', {
    session_id: text().primaryKey(),
    user_id: text(),
    repo: text(),
    git_branch: text(),
    first_at: bigint({ mode: 'number' }).notNull(),
    last_at: bigint({ mode: 'number' }).notNull(),
    user_msg_count: integer().notNull().default(0),
    assistant_turns: integer().notNull().default(0),
    tool_use_count: integer().notNull().default(0),
    error_count: integer().notNull().default(0),
    input_tokens: integer().notNull().default(0),
    output_tokens: integer().notNull().default(0),
    cache_creation_tokens: integer().notNull().default(0),
    cache_read_tokens: integer().notNull().default(0),
    models_json: text(),
    skills_json: text(),
    mcp_json: text(),
    computed_at: bigint({ mode: 'number' }).notNull(),
    commit_count: integer().notNull().default(0),
    active_secs: integer(),
}, (t) => [
    index('idx_css_repo').on(t.repo, t.last_at),
    index('idx_css_user_time').on(t.user_id, t.last_at),
]);

export const complianceEvents = pgTable('compliance_events', {
    id: text().primaryKey(),
    user_id: text(),
    event_type: text().notNull(),
    surface: text().notNull(),
    content_preview: text(),
    metadata: jsonb(),
    flagged: integer().default(0),
    flag_reason: text(),
    occurred_at: bigint({ mode: 'number' }).notNull(),
    ingested_at: bigint({ mode: 'number' }).default(sql`extract(epoch from now())`),
}, (t) => [
    foreignKey({ columns: [t.user_id], foreignColumns: [users.id], name: 'compliance_events_user_id_fk' }),
    index('idx_compliance_events_ingested_at').on(t.ingested_at),
    index('idx_compliance_events_occurred_at').on(t.occurred_at),
    index('idx_compliance_events_flagged').on(t.flagged),
    index('idx_compliance_events_surface').on(t.surface),
    index('idx_compliance_events_occurred').on(t.occurred_at),
    index('idx_compliance_events_user').on(t.user_id),
]);

export const config = pgTable('config', {
    key: text().primaryKey(),
    value: text().notNull(),
    updated_at: bigint({ mode: 'number' }).default(sql`extract(epoch from now())`),
});

export const connectorTokens = pgTable('connector_tokens', {
    id: text().primaryKey(),
    name: text().notNull(),
    token_hash: text().notNull(),
    created_at: bigint({ mode: 'number' }).notNull(),
    last_used_at: bigint({ mode: 'number' }),
    revoked_at: bigint({ mode: 'number' }),
}, (t) => [
    unique('connector_tokens_token_hash_uq').on(t.token_hash),
]);

export const coworkMcpInvocations = pgTable('cowork_mcp_invocations', {
    id: text().primaryKey(),
    // PG-only monotonic insertion-order cursor for the use-case tracker's
    // exactly-once/never-skip incremental scan (this text-PK table has no
    // other monotonic-integer column).
    // BY DEFAULT so the ETL column-copy path is not rejected; UNIQUE index
    // below for MAX()/ordering correctness + scan performance.
    seq: bigint({ mode: 'number' }).generatedByDefaultAsIdentity(),
    user_id: text().notNull(),
    session_id: text().notNull(),
    mcp_server: text().notNull(),
    mcp_tool: text().notNull(),
    occurred_at: bigint({ mode: 'number' }).notNull(),
    ingested_at: bigint({ mode: 'number' }).default(sql`extract(epoch from now())`),
    prompt_id: text(),
    success: integer().notNull().default(1),
    duration_ms: integer(),
    source: text().notNull().default('agent'),
    surface: text().notNull().default('cowork'),
}, (t) => [
    foreignKey({ columns: [t.user_id], foreignColumns: [users.id], name: 'cowork_mcp_invocations_user_id_fk' }).onDelete('cascade'),
    uniqueIndex('idx_cowork_mcp_invocations_seq').on(t.seq),
    index('idx_cmi_surface').on(t.surface),
    uniqueIndex('idx_cowork_mcp_invocations_dedup').on(t.session_id, t.mcp_server, t.mcp_tool, t.occurred_at),
    index('idx_mcp_invocations_occurred').on(t.occurred_at),
    index('idx_mcp_invocations_session').on(t.session_id),
    index('idx_mcp_invocations_server').on(t.mcp_server),
    index('idx_mcp_invocations_user').on(t.user_id),
]);

export const coworkMessages = pgTable('cowork_messages', {
    id: text().primaryKey(),
    // PG-only monotonic insertion-order cursor for the use-case tracker's
    // exactly-once/never-skip incremental scan (this text-PK table has no
    // other monotonic-integer column).
    // BY DEFAULT so the ETL column-copy path is not rejected; UNIQUE index
    // below for MAX()/ordering correctness + scan performance.
    seq: bigint({ mode: 'number' }).generatedByDefaultAsIdentity(),
    session_id: text().notNull(),
    user_id: text(),
    message_type: text().notNull(),
    role: text(),
    content_preview: text(),
    content_full: text(),
    tool_name: text(),
    tool_input_preview: text(),
    tool_output_preview: text(),
    // File name of an output tool call (Write/SendUserFile/Artifact); PII-scrubbed,
    // never a path or content. Retention strip mode nulls it (migration 0028).
    output_name: text(),
    token_usage: jsonb(),
    model: text(),
    flagged: integer().default(0),
    flag_reason: text(),
    occurred_at: bigint({ mode: 'number' }).notNull(),
    ingested_at: bigint({ mode: 'number' }).default(sql`extract(epoch from now())`),
    agent_id: text(),
    surface: text().default('cowork'),
    prompt_id: text(),
    cost_usd: numeric(),
    tool_parameters: jsonb(),
    tool_success: integer(),
    tool_duration_ms: integer(),
    source: text().notNull().default('agent'),
    synced_resources: text(),
    // One-sentence justification from the PII confirmation check.
    // flag_reason records THAT a match was confirmed or dismissed; this records WHY.
    pii_verdict_reason: text(),
    // Claude subagent attribution (migration 0036): the subagent name on a model
    // call (OTel agent.name) or a subagent launch (the Agent tool's subagent_type),
    // and the model call's query_source. NULL = not a subagent, or before capture.
    agent_name: text(),
    query_source: text(),
    // The skill running when a Cowork model call was made (OTel skill.name, migration 0037).
    skill_name: text(),
}, (t) => [
    foreignKey({ columns: [t.user_id], foreignColumns: [users.id], name: 'cowork_messages_user_id_fk' }),
    uniqueIndex('idx_cowork_messages_seq').on(t.seq),
    index('idx_cowork_messages_source').on(t.source),
    index('idx_cowork_messages_prompt_id').on(t.prompt_id),
    index('idx_cowork_surface_occurred').on(t.surface, t.occurred_at),
    index('idx_cowork_messages_ingested_at').on(t.ingested_at),
    index('idx_cowork_messages_surface').on(t.surface),
    index('idx_cowork_messages_occurred_at').on(t.occurred_at),
    index('idx_cowork_messages_user').on(t.user_id, t.occurred_at),
    index('idx_cowork_messages_flagged').on(t.flagged),
    index('idx_cowork_messages_session').on(t.session_id, t.occurred_at),
    index('idx_cowork_messages_agent_name').on(t.agent_name, t.occurred_at).where(sql`agent_name IS NOT NULL`),
]);

// One cached model-written sentence per session for the frontier boxes
// (migration 0028). description NULL = failed attempt; occurred_at drives retention.
export const coworkSessionDescriptions = pgTable('cowork_session_descriptions', {
    session_id: text().primaryKey(),
    user_id: text().notNull(),
    description: text(),
    model: text(),
    attempts: integer().notNull().default(0),
    occurred_at: bigint({ mode: 'number' }).notNull(),
    generated_at: bigint({ mode: 'number' }).notNull(),
}, (t) => [
    index('idx_cowork_session_descriptions_user').on(t.user_id),
    index('idx_cowork_session_descriptions_occurred').on(t.occurred_at),
]);

// One row per judged Cowork/Code session: the live use cases it was an
// instance of (migration 0032). use_case_ids and
// skill_matched_ids are JSON arrays; reason is model-written (retention +
// erasure covered).
export const useCaseSessionJudgements = pgTable('use_case_session_judgements', {
    session_id: text().primaryKey(),
    surface: text().notNull(),
    user_id: text().notNull(),
    department: text(),
    use_case_ids: text().notNull().default('[]'),
    skill_matched_ids: text().notNull().default('[]'),
    reason: text(),
    candidate_key: text().notNull(),
    prompt_count: integer().notNull().default(0),
    first_event_at: bigint({ mode: 'number' }).notNull(),
    last_event_at: bigint({ mode: 'number' }).notNull(),
    model: text(),
    judged_at: bigint({ mode: 'number' }).notNull(),
}, (t) => [
    index('idx_use_case_session_judgements_user').on(t.user_id),
    index('idx_use_case_session_judgements_last_event').on(t.last_event_at),
]);

export const humanTimeChecks = pgTable('human_time_checks', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    surface: text().notNull(),
    session_id: text().notNull(),
    period: text().notNull(),
    human_minutes_likely: integer().notNull(),
    verdict: text(),
    corrected_minutes: integer(),
    created_at: bigint({ mode: 'number' }).notNull(),
    reviewed_at: bigint({ mode: 'number' }),
}, (t) => [
    unique('human_time_checks_uq').on(t.surface, t.session_id, t.period),
]);
export const coworkSessionStats = pgTable('cowork_session_stats', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    session_id: text().notNull(),
    user_id: text().notNull(),
    total_input_tokens: integer().notNull().default(0),
    total_output_tokens: integer().notNull().default(0),
    total_cache_read_tokens: integer().notNull().default(0),
    total_cache_creation_tokens: integer().notNull().default(0),
    total_cost_usd: numeric(),
    tool_call_count: integer().notNull().default(0),
    unique_tools: text(),
    models_used: text(),
    duration_secs: integer(),
    first_event_at: bigint({ mode: 'number' }),
    last_event_at: bigint({ mode: 'number' }),
    upload_count: integer().notNull().default(0),
    computed_at: bigint({ mode: 'number' }).notNull(),
    active_secs: integer(),
    produced_output: integer(),
    human_minutes_low: integer(),
    human_minutes_likely: integer(),
    human_minutes_high: integer(),
    human_minutes_attempts: integer().notNull().default(0),
}, (t) => [
    foreignKey({ columns: [t.user_id], foreignColumns: [users.id], name: 'cowork_session_stats_user_id_fk' }),
    foreignKey({ columns: [t.session_id], foreignColumns: [coworkSessions.id], name: 'cowork_session_stats_session_id_fk' }),
    index('idx_cowork_session_stats_session').on(t.session_id),
    index('idx_cowork_session_stats_user').on(t.user_id, t.last_event_at),
    unique('cowork_session_stats_session_id_uq').on(t.session_id),
]);

export const coworkSessions = pgTable('cowork_sessions', {
    id: text().primaryKey(),
    conversation_id: text().notNull(),
    org_id: text(),
    user_id: text(),
    session_name: text(),
    model: text(),
    initial_message: text(),
    user_selected_folders: jsonb(),
    tools_available: jsonb(),
    mcp_servers: jsonb(),
    git_diff_summary: text(),
    git_diff_full: text(),
    files_changed: bigint({ mode: 'number' }).default(0),
    started_at: bigint({ mode: 'number' }),
    ended_at: bigint({ mode: 'number' }),
    created_at: bigint({ mode: 'number' }).default(sql`extract(epoch from now())`),
    agent_id: text(),
    files_touched: text(),
    project_name: text(),
    source: text().notNull().default('agent'),
    files_uploaded: text(),
}, (t) => [
    foreignKey({ columns: [t.user_id], foreignColumns: [users.id], name: 'cowork_sessions_user_id_fk' }),
    index('idx_cowork_sessions_project').on(t.project_name),
    index('idx_cowork_sessions_user').on(t.user_id, t.started_at),
    index('idx_cowork_sessions_conversation').on(t.conversation_id),
]);

export const coworkSkillInvocations = pgTable('cowork_skill_invocations', {
    id: text().primaryKey(),
    // PG-only monotonic insertion-order cursor for the use-case tracker's
    // exactly-once/never-skip incremental scan (this text-PK table has no
    // other monotonic-integer column).
    // BY DEFAULT so the ETL column-copy path is not rejected; UNIQUE index
    // below for MAX()/ordering correctness + scan performance.
    seq: bigint({ mode: 'number' }).generatedByDefaultAsIdentity(),
    user_id: text().notNull(),
    session_id: text().notNull(),
    skill_name: text().notNull(),
    occurred_at: bigint({ mode: 'number' }).notNull(),
    ingested_at: bigint({ mode: 'number' }).default(sql`extract(epoch from now())`),
    invocation_type: text().notNull().default('user_typed'),
    prompt_id: text(),
    source: text().notNull().default('agent'),
    surface: text().notNull().default('cowork'),
}, (t) => [
    foreignKey({ columns: [t.user_id], foreignColumns: [users.id], name: 'cowork_skill_invocations_user_id_fk' }).onDelete('cascade'),
    uniqueIndex('idx_cowork_skill_invocations_seq').on(t.seq),
    index('idx_csi_surface').on(t.surface),
    index('idx_skill_invocations_type').on(t.invocation_type),
    index('idx_skill_invocations_occurred').on(t.occurred_at),
    index('idx_skill_invocations_session').on(t.session_id),
    index('idx_skill_invocations_skill').on(t.skill_name),
    index('idx_skill_invocations_user').on(t.user_id),
]);

export const enrollmentTokens = pgTable('enrollment_tokens', {
    id: text().primaryKey(),
    token_hash: text().notNull(),
    created_by: text(),
    expires_at: bigint({ mode: 'number' }).notNull(),
    max_uses: integer(),
    use_count: integer().notNull().default(0),
    created_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
    default_department: text(),
}, (t) => [
    index('idx_enrollment_tokens_expires_at').on(t.expires_at),
    unique('enrollment_tokens_token_hash_uq').on(t.token_hash),
]);

export const errorEvents = pgTable('error_events', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    occurred_at: bigint({ mode: 'number' }).notNull(),
    severity: text().notNull(),
    source: text().notNull(),
    message: text().notNull(),
    stack_trace: text(),
    context_json: text(),
}, (t) => [
    index('idx_error_events_source_severity').on(t.source, t.severity),
    index('idx_error_events_severity').on(t.severity),
    index('idx_error_events_occurred_at').on(t.occurred_at),
]);

export const githubRepoMap = pgTable('github_repo_map', {
    repo: text().primaryKey(),
    github_repo: text().notNull(),
    created_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
});

export const githubRepoStats = pgTable('github_repo_stats', {
    repo: text().notNull(),
    date: text().notNull(),
    commit_count: integer().notNull().default(0),
    prs_merged: integer().notNull().default(0),
    synced_at: bigint({ mode: 'number' }).notNull(),
}, (t) => [
    primaryKey({ columns: [t.repo, t.date] }),
    index('idx_grs_date').on(t.date),
]);

export const githubUserRepoStats = pgTable('github_user_repo_stats', {
    user_id: text().notNull(),
    repo: text().notNull(),
    date: text().notNull(),
    commit_count: integer().notNull().default(0),
    synced_at: bigint({ mode: 'number' }).notNull(),
}, (t) => [
    primaryKey({ columns: [t.user_id, t.repo, t.date] }),
    index('idx_gurs_repo_date').on(t.repo, t.date),
    index('idx_gurs_user_date').on(t.user_id, t.date),
]);

export const githubIdentityMap = pgTable('github_identity_map', {
    identity: text().primaryKey(),
    user_id: text().notNull(),
    created_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
    created_by: text(),
});

export const githubUnmatchedAuthors = pgTable('github_unmatched_authors', {
    identity: text().primaryKey(),
    commit_count: integer().notNull().default(0),
    last_synced: bigint({ mode: 'number' }).notNull(),
});

export const otelEvents = pgTable('otel_events', {
    id: text().primaryKey(),
    user_id: text(),
    session_id: text(),
    tool_name: text(),
    tool_input: jsonb(),
    token_usage: jsonb(),
    file_paths: jsonb(),
    duration_ms: integer(),
    occurred_at: bigint({ mode: 'number' }).notNull(),
    ingested_at: bigint({ mode: 'number' }).default(sql`extract(epoch from now())`),
    event_type: text(),
    source: text().default('otel'),
    surface: text(),
    agent_id: text(),
    prompt_id: text(),
    skill_name: text(),
    mcp_server: text(),
    mcp_tool: text(),
    cost_usd: numeric(),
}, (t) => [
    foreignKey({ columns: [t.user_id], foreignColumns: [users.id], name: 'otel_events_user_id_fk' }),
    index('idx_otel_events_prompt_id').on(t.prompt_id),
    index('idx_otel_events_surface').on(t.surface, t.occurred_at),
    index('idx_otel_events_source').on(t.source, t.occurred_at),
    index('idx_otel_events_occurred').on(t.occurred_at),
    index('idx_otel_events_session').on(t.session_id),
    index('idx_otel_events_user').on(t.user_id),
]);

export const passwordResetTokens = pgTable('password_reset_tokens', {
    id: text().primaryKey(),
    user_id: text().notNull(),
    token_hash: text().notNull(),
    expires_at: bigint({ mode: 'number' }).notNull(),
    used_at: bigint({ mode: 'number' }),
    created_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
}, (t) => [
    foreignKey({ columns: [t.user_id], foreignColumns: [adminUsers.id], name: 'password_reset_tokens_user_id_fk' }).onDelete('cascade'),
    index('idx_prt_user_id').on(t.user_id),
    index('idx_prt_token_hash').on(t.token_hash),
    unique('password_reset_tokens_token_hash_uq').on(t.token_hash),
]);

export const pulseBaselines = pgTable('pulse_baselines', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    team_id: text().notNull(),
    baseline_process_count: integer(),
    baseline_start_date: text(),
    baseline_end_date: text(),
    set_by: text().notNull(),
    set_at: bigint({ mode: 'number' }).notNull(),
}, (t) => [
    foreignKey({ columns: [t.set_by], foreignColumns: [users.id], name: 'pulse_baselines_set_by_fk' }),
    unique('pulse_baselines_team_id_uq').on(t.team_id),
]);

export const pulseBriefings = pgTable('pulse_briefings', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    scope_type: text().notNull(),
    scope_id: text().notNull(),
    period_start: bigint({ mode: 'number' }).notNull(),
    period_end: bigint({ mode: 'number' }).notNull(),
    body: text().notNull(),
    suggestion: text(),
    model: text().notNull(),
    generated_at: bigint({ mode: 'number' }).notNull(),
}, (t) => [
    index('idx_pulse_briefings_scope').on(t.scope_type, t.scope_id, t.generated_at),
]);

export const pulseClassifications = pgTable('pulse_classifications', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    cowork_message_id: text().notNull(),
    user_id: text().notNull(),
    tier: integer().notNull(),
    task_type: text().notNull(),
    frontier_push_candidate: integer().notNull().default(0),
    capability_creation_candidate: integer().notNull().default(0),
    classifier_confidence: doublePrecision().notNull(),
    classifier_model: text().notNull(),
    classifier_status: text().notNull().default('classified'),
    classifier_attempts: integer().notNull().default(1),
    classifier_error: text(),
    classified_at: bigint({ mode: 'number' }).notNull(),
}, (t) => [
    foreignKey({ columns: [t.user_id], foreignColumns: [users.id], name: 'pulse_classifications_user_id_fk' }),
    foreignKey({ columns: [t.cowork_message_id], foreignColumns: [coworkMessages.id], name: 'pulse_classifications_cowork_message_id_fk' }),
    index('idx_pulse_class_status').on(t.classifier_status),
    index('idx_pulse_class_tier').on(t.tier),
    index('idx_pulse_class_user_time').on(t.user_id, t.classified_at),
    unique('pulse_classifications_cowork_message_id_uq').on(t.cowork_message_id),
]);

export const pulseEvents = pgTable('pulse_events', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    user_id: text().notNull(),
    event_type: text().notNull(),
    status: text().notNull().default('confirmed'),
    title: text().notNull(),
    body: text(),
    cowork_message_id: text(),
    reviewer_id: text(),
    team_id: text(),
    tier: integer(),
    detected_at: bigint({ mode: 'number' }).notNull(),
    confirmed_at: bigint({ mode: 'number' }),
    confirmed_by: text(),
    // Capability value attribution — migration 063, all nullable.
    value_type: text(),
    value_amount: doublePrecision(),
    value_period: text(),
    value_basis: text(),
    attributed_by: text(),
    attributed_at: bigint({ mode: 'number' }),
}, (t) => [
    foreignKey({ columns: [t.cowork_message_id], foreignColumns: [coworkMessages.id], name: 'pulse_events_cowork_message_id_fk' }),
    foreignKey({ columns: [t.user_id], foreignColumns: [users.id], name: 'pulse_events_user_id_fk' }),
    index('idx_pulse_events_team').on(t.team_id, t.detected_at),
    index('idx_pulse_events_type').on(t.event_type, t.status),
    index('idx_pulse_events_user').on(t.user_id, t.detected_at),
]);

export const pulseMetrics = pgTable('pulse_metrics', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    scope_type: text().notNull(),
    scope_id: text().notNull(),
    period_start: bigint({ mode: 'number' }).notNull(),
    period_end: bigint({ mode: 'number' }).notNull(),
    oti: doublePrecision(),
    dds: doublePrecision(),
    psr: doublePrecision(),
    ors: doublePrecision(),
    tcs: doublePrecision(),
    event_count: integer().notNull().default(0),
    tier_1_count: integer().notNull().default(0),
    tier_2_count: integer().notNull().default(0),
    tier_3_count: integer().notNull().default(0),
    computed_at: bigint({ mode: 'number' }).notNull(),
    granularity: text().notNull().default('rolling'),
    ors_breadth: doublePrecision(),
    ors_overlap: doublePrecision(),
    ors_propagation: doublePrecision(),
    metric_version: integer().notNull().default(1),
    oti_early_read: integer().notNull().default(0),
    oti_active_days: integer(),
}, (t) => [
    uniqueIndex('idx_pulse_metrics_week').on(t.scope_type, t.scope_id, t.period_start).where(sql`granularity = 'week'`),
    index('idx_pulse_metrics_scope').on(t.scope_type, t.scope_id, t.period_end),
]);

export const pulseRubricVersions = pgTable('pulse_rubric_versions', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    changed_by: text().notNull(),
    changed_at: bigint({ mode: 'number' }).notNull(),
    rubric_json: text().notNull(),
    change_summary: text(),
}, (t) => [
    index('idx_rubric_versions_changed_at').on(t.changed_at),
]);

// Classifier accuracy audit — migration 062.
export const pulseAuditCycles = pgTable('pulse_audit_cycles', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    period: text().notNull(),
    surface: text().notNull().default('cowork'),
    sample_seed: bigint({ mode: 'number' }).notNull(),
    classifier_model: text(),
    rubric_version: integer(),
    stratum_weights: text(),
    status: text().notNull().default('open'),
    n_sampled: integer().notNull().default(0),
    n_reviewed: integer().notNull().default(0),
    agreement_pct: doublePrecision(),
    kappa: doublePrecision(),
    confusion_json: text(),
    created_at: bigint({ mode: 'number' }).notNull(),
    scored_at: bigint({ mode: 'number' }),
}, (t) => [
    index('idx_pulse_audit_cycles_period').on(t.surface, t.period),
]);

export const pulseAuditItems = pgTable('pulse_audit_items', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    cycle_id: integer().notNull(),
    classification_id: integer().notNull(),
    stratum: text().notNull(),
    model_tier: integer().notNull(),
    model_confidence: doublePrecision(),
    human_tier: integer(),
    human_task_type: text(),
    reviewed_by: text(),
    reviewed_at: bigint({ mode: 'number' }),
    agrees: integer(),
}, (t) => [
    index('idx_pulse_audit_items_cycle').on(t.cycle_id),
]);

export const pulseSkillRuns = pgTable('pulse_skill_runs', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    skill_id: integer().notNull(),
    user_id: text().notNull(),
    cowork_message_id: text().notNull(),
    ran_at: bigint({ mode: 'number' }).notNull(),
}, (t) => [
    foreignKey({ columns: [t.cowork_message_id], foreignColumns: [coworkMessages.id], name: 'pulse_skill_runs_cowork_message_id_fk' }),
    foreignKey({ columns: [t.user_id], foreignColumns: [users.id], name: 'pulse_skill_runs_user_id_fk' }),
    foreignKey({ columns: [t.skill_id], foreignColumns: [pulseSkills.id], name: 'pulse_skill_runs_skill_id_fk' }),
    index('idx_pulse_skill_runs_user').on(t.user_id),
    index('idx_pulse_skill_runs_skill').on(t.skill_id),
]);

export const pulseSkills = pgTable('pulse_skills', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    skill_name: text().notNull(),
    skill_version: text(),
    author_user_id: text(),
    team_id: text(),
    description: text(),
    trigger_text: text(),
    run_count: integer().notNull().default(0),
    first_seen_at: bigint({ mode: 'number' }).notNull(),
    last_seen_at: bigint({ mode: 'number' }).notNull(),
}, (t) => [
    foreignKey({ columns: [t.author_user_id], foreignColumns: [users.id], name: 'pulse_skills_author_user_id_fk' }),
    index('idx_pulse_skills_author').on(t.author_user_id),
    index('idx_pulse_skills_team').on(t.team_id),
    unique('pulse_skills_skill_name_skill_version_uq').on(t.skill_name, t.skill_version),
]);

export const pulseTeamAssessments = pgTable('pulse_team_assessments', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    team_id: text().notNull(),
    assessment_date: text().notNull(),
    item_1_shared_storage: integer().notNull().default(0),
    item_2_trigger_descriptions: integer().notNull().default(0),
    item_3_tier_3_reproduced: integer().notNull().default(0),
    item_4_walkthrough_passed: integer().notNull().default(0),
    // GENERATED ALWAYS AS (item_1_shared_storage + item_2_trigger_descriptions
    // + item_3_tier_3_reproduced + item_4_walkthrough_passed) STORED
    // Postgres generated columns are always STORED (no VIRTUAL option), so no
    // mode config here.
    checklist_score: integer().generatedAlwaysAs(
        sql`item_1_shared_storage + item_2_trigger_descriptions + item_3_tier_3_reproduced + item_4_walkthrough_passed`
    ),
    notes: text(),
    assessed_by: text().notNull(),
    assessed_at: bigint({ mode: 'number' }).notNull(),
}, (t) => [
    foreignKey({ columns: [t.assessed_by], foreignColumns: [users.id], name: 'pulse_team_assessments_assessed_by_fk' }),
    unique('pulse_team_assessments_team_id_assessment_date_uq').on(t.team_id, t.assessment_date),
]);

export const pulseUserPrefs = pgTable('pulse_user_prefs', {
    user_id: text().primaryKey(),
    target_dds: doublePrecision(),
    set_at: bigint({ mode: 'number' }).notNull(),
    pulse_start_at: bigint({ mode: 'number' }),
}, (t) => [
    foreignKey({ columns: [t.user_id], foreignColumns: [users.id], name: 'pulse_user_prefs_user_id_fk' }).onDelete('cascade'),
]);

export const reports = pgTable('reports', {
    id: text().primaryKey(),
    report_type: text().notNull(),
    period_start: text().notNull(),
    period_end: text().notNull(),
    generated_by: text(),
    content_md: text().notNull(),
    content_summary: text(),
    generated_at: bigint({ mode: 'number' }).default(sql`extract(epoch from now())`),
    manager_only: integer().notNull().default(0),
}, (t) => [
    index('idx_reports_type').on(t.report_type),
]);

export const skillLibraryEntries = pgTable('skill_library_entries', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    name: text().notNull(),
    type: text().notNull().default('skill'),
    surface: text().notNull().default('cowork'),
    description: text(),
    author_user_id: text(),
    is_published: integer().notNull().default(0),
    install_guide: text(),
    source_url: text(),
    department: text(),
    created_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
    updated_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
    source: text().notNull().default('org'),
}, (t) => [
    foreignKey({ columns: [t.author_user_id], foreignColumns: [users.id], name: 'skill_library_entries_author_user_id_fk' }).onDelete('set null'),
    index('idx_skill_library_entries_created').on(t.created_at),
    index('idx_skill_library_entries_author').on(t.author_user_id),
    index('idx_skill_library_entries_published').on(t.is_published),
    index('idx_skill_library_entries_type').on(t.type),
    index('idx_skill_library_entries_department').on(t.department),
    unique('skill_library_entries_name_uq').on(t.name),
]);

export const skillLibraryVotes = pgTable('skill_library_votes', {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    entry_id: integer().notNull(),
    voter_user_id: text().notNull(),
    voted_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
}, (t) => [
    foreignKey({ columns: [t.voter_user_id], foreignColumns: [users.id], name: 'skill_library_votes_voter_user_id_fk' }).onDelete('cascade'),
    foreignKey({ columns: [t.entry_id], foreignColumns: [skillLibraryEntries.id], name: 'skill_library_votes_entry_id_fk' }).onDelete('cascade'),
    index('idx_skill_library_votes_voter').on(t.voter_user_id),
    index('idx_skill_library_votes_entry').on(t.entry_id),
    unique('skill_library_votes_entry_id_voter_user_id_uq').on(t.entry_id, t.voter_user_id),
]);

export const totpRecoveryCodes = pgTable('totp_recovery_codes', {
    id: text().primaryKey(),
    user_id: text().notNull(),
    code_hash: text().notNull(),
    used_at: bigint({ mode: 'number' }),
}, (t) => [
    foreignKey({ columns: [t.user_id], foreignColumns: [adminUsers.id], name: 'totp_recovery_codes_user_id_fk' }).onDelete('cascade'),
]);

// TOTP replay guard state (migration 0019). Deliberately no foreign key to
// admin_users: this row is written on the authentication path, where an FK
// failure would lock a user out; disableTotp() and deleteAdminUser() clear it
// explicitly instead.
export const totpConsumedSteps = pgTable('totp_consumed_steps', {
    user_id: text().primaryKey(),
    step: bigint({ mode: 'number' }).notNull(),
    consumed_at: bigint({ mode: 'number' }).notNull(),
});

export const coachingAcks = pgTable('coaching_acks', {
    user_id: text().notNull(),
    use_case_id: text().notNull(),
    acked_by: text().notNull(),
    acked_at: bigint({ mode: 'number' }).notNull(),
}, (t) => [
    primaryKey({ columns: [t.user_id, t.use_case_id] }),
    foreignKey({ columns: [t.user_id], foreignColumns: [users.id], name: 'coaching_acks_user_id_fk' }).onDelete('cascade'),
    foreignKey({ columns: [t.use_case_id], foreignColumns: [useCases.id], name: 'coaching_acks_use_case_id_fk' }).onDelete('cascade'),
]);

export const useCaseActivationWeeks = pgTable('use_case_activation_weeks', {
    use_case_id: text().notNull(),
    week_start: bigint({ mode: 'number' }).notNull(),
    distinct_users: integer().notNull().default(0),
    session_count: integer().notNull().default(0),
    matched_messages: integer().notNull().default(0),
    latest_tier: integer(),
    last_seen_at: bigint({ mode: 'number' }),
    updated_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
    measured_duration_secs: integer(),
    engaged_secs: integer(),
    tool_error_count: integer(),
    edit_reject_count: integer(),
    edit_accept_count: integer(),
    flagged_count: integer(),
    cowork_tool_error_count: integer(),
}, (t) => [
    primaryKey({ columns: [t.use_case_id, t.week_start] }),
    foreignKey({ columns: [t.use_case_id], foreignColumns: [useCases.id], name: 'use_case_activation_weeks_use_case_id_fk' }).onDelete('cascade'),
]);

export const useCaseSuggestions = pgTable('use_case_suggestions', {
    id: text().primaryKey(),
    signal_key: text().notNull(),
    title: text().notNull(),
    description: text(),
    matching_rule: text().notNull(),
    evidence: text().notNull(),
    status: text().notNull().default('open'),
    generated_at: bigint({ mode: 'number' }).notNull(),
    updated_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
    department: text(),
    canvas_json: text(),
    /** Where a mined suggestion was found: 'cowork' | 'code'; NULL on older rows (all Cowork). */
    surface: text(),
    /** JSON array of the session ids the suggestion was based on. */
    cited_sessions: text(),
}, (t) => [
    index('idx_use_case_suggestions_status').on(t.status),
    unique('use_case_suggestions_signal_key_uq').on(t.signal_key),
    index('idx_use_case_suggestions_department').on(t.department),
]);

export const useCaseWeekMatches = pgTable('use_case_week_matches', {
    use_case_id: text().notNull(),
    week_start: bigint({ mode: 'number' }).notNull(),
    user_id: text().notNull(),
    session_id: text().notNull().default(''),
}, (t) => [
    primaryKey({ columns: [t.use_case_id, t.week_start, t.user_id, t.session_id] }),
    foreignKey({ columns: [t.use_case_id], foreignColumns: [useCases.id], name: 'use_case_week_matches_use_case_id_fk' }).onDelete('cascade'),
]);

export const jobRuns = pgTable('job_runs', {
    job_name: text().primaryKey(),
    last_started_at: bigint({ mode: 'number' }),
    last_succeeded_at: bigint({ mode: 'number' }),
    last_failed_at: bigint({ mode: 'number' }),
    last_error: text(),
    consecutive_failures: integer().notNull().default(0),
    last_duration_ms: integer(),
});

export const otelIngestedEvents = pgTable('otel_ingested_events', {
    event_key: text().primaryKey(),
    received_at: bigint({ mode: 'number' }).notNull(),
}, (t) => [
    index('idx_otel_ingested_events_received_at').on(t.received_at),
]);

export const otelIdentityConflicts = pgTable('otel_identity_conflicts', {
    id: text().primaryKey(),
    installation_id: text().notNull(),
    existing_user_id: text().notNull(),
    new_email: text().notNull(),
    new_user_id: text().notNull(),
    surface: text().notNull(),
    first_seen_at: bigint({ mode: 'number' }).notNull(),
    last_seen_at: bigint({ mode: 'number' }).notNull(),
    event_count: integer().notNull().default(0),
    status: text().notNull().default('open'),
    decided_by: text(),
    decided_at: bigint({ mode: 'number' }),
}, (t) => [
    uniqueIndex('otel_identity_conflicts_install_email_uq').on(t.installation_id, t.new_email),
    index('idx_otel_identity_conflicts_status').on(t.status),
]);

export const otelIdentityAliases = pgTable('otel_identity_aliases', {
    email: text().primaryKey(),
    user_id: text().notNull(),
    conflict_id: text(),
    created_by: text(),
    created_at: bigint({ mode: 'number' }).notNull(),
}, (t) => [
    index('idx_otel_identity_aliases_user').on(t.user_id),
]);

export const useCaseSkillDrafts = pgTable('use_case_skill_drafts', {
    use_case_id: text().primaryKey(),
    skill_name: text().notNull(),
    description: text().notNull(),
    body_md: text().notNull(),
    owner_questions_json: text().notNull(),
    citations_json: text().notNull(),
    corpus_stats_json: text().notNull(),
    thin: integer().notNull().default(0),
    model: text().notNull(),
    generated_at: bigint({ mode: 'number' }).notNull(),
    edited_at: bigint({ mode: 'number' }),
    downloaded_at: bigint({ mode: 'number' }),
    library_entry_id: integer(),
}, (t) => [
    foreignKey({ columns: [t.use_case_id], foreignColumns: [useCases.id], name: 'use_case_skill_drafts_use_case_id_fk' }).onDelete('cascade'),
    foreignKey({ columns: [t.library_entry_id], foreignColumns: [skillLibraryEntries.id], name: 'use_case_skill_drafts_library_entry_id_fk' }).onDelete('set null'),
    index('idx_use_case_skill_drafts_skill_name').on(t.skill_name),
]);

export const useCases = pgTable('use_cases', {
    id: text().primaryKey(),
    title: text().notNull(),
    description: text(),
    owner_user_id: text(),
    departments: text(),
    surfaces: text(),
    keywords: text(),
    skills: text(),
    connectors: text(),
    task_types: text(),
    origin: text().notNull().default('planned'),
    status: text().notNull().default('candidate'),
    capture_method: text().notNull().default('guided'),
    source_excerpt: text(),
    created_by: text(),
    activate_result: text(),
    last_activated_at: bigint({ mode: 'number' }),
    created_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
    updated_at: bigint({ mode: 'number' }).notNull().default(sql`extract(epoch from now())`),
    lifecycle: text().notNull().default('not_seen'),
    lifecycle_changed_at: bigint({ mode: 'number' }),
    strategic: integer().notNull().default(0),
    impact_summary: text(),
    impact_summary_at: bigint({ mode: 'number' }),
    pain_point: text(),
    value_hypothesis: text(),
    baseline_note: text(),
    kpi_note: text(),
}, (t) => [
    index('idx_use_cases_strategic').on(t.strategic),
    index('idx_use_cases_lifecycle').on(t.lifecycle),
    index('idx_use_cases_origin').on(t.origin),
    index('idx_use_cases_status').on(t.status),
]);

export const users = pgTable('users', {
    id: text().primaryKey(),
    email: text(),
    display_name: text(),
    department: text(),
    source: text().default('agent'),
    first_seen_at: bigint({ mode: 'number' }),
    last_seen_at: bigint({ mode: 'number' }),
    created_at: bigint({ mode: 'number' }).default(sql`extract(epoch from now())`),
    team_id: text(),
    manager_id: text().references((): AnyPgColumn => users.id),
    account_uuid: text(),
    deactivated_at: bigint({ mode: 'number' }),
    deactivation_reason: text(),
}, (t) => [
    index('idx_users_deactivated').on(t.deactivated_at),
    index('idx_users_department').on(t.department),
    index('idx_users_source').on(t.source),
    index('idx_users_email').on(t.email),
    unique('users_email_uq').on(t.email),
]);

export const pgSchema = {
  adminSessions,
  adminUsers,
  agents,
  alerts,
  analyticsSnapshots,
  authEvents,
  chargebackCostCentres,
  chargebackDeptMap,
  chargebackPeriods,
  chatMessages,
  chatAssistantMeta,
  coachingAcks,
  codeAssistantMeta,
  codeMetrics,
  codeOtelMetrics,
  codeSessionClassifications,
  codeSessionStats,
  complianceEvents,
  config,
  connectorTokens,
  coworkMcpInvocations,
  coworkMessages,
  coworkSessionDescriptions,
  useCaseSessionJudgements,
  coworkSessionStats,
  humanTimeChecks,
  coworkSessions,
  coworkSkillInvocations,
  enrollmentTokens,
  errorEvents,
  githubIdentityMap,
  githubRepoMap,
  githubRepoStats,
  githubUnmatchedAuthors,
  githubUserRepoStats,
  otelEvents,
  passwordResetTokens,
  pulseBaselines,
  pulseBriefings,
  pulseClassifications,
  pulseEvents,
  pulseMetrics,
  pulseRubricVersions,
  pulseAuditCycles,
  pulseAuditItems,
  pulseSkillRuns,
  pulseSkills,
  pulseTeamAssessments,
  pulseUserPrefs,
  reports,
  skillLibraryEntries,
  skillLibraryVotes,
  otelIdentityAliases,
  otelIngestedEvents,
  jobRuns,
  otelIdentityConflicts,
  totpConsumedSteps,
  totpRecoveryCodes,
  useCaseActivationWeeks,
  useCaseSkillDrafts,
  useCaseSuggestions,
  useCaseWeekMatches,
  useCases,
  users,
};
