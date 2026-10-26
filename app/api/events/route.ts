// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. The three
// audit-projection helpers below are dynamic multi-JOIN, multi-filter reads
// (one with a derived-table subquery) — kept as raw `sql` templates through
// the local rawAll() facade (mirrors lib/db/queries.ts's getDepartmentBreakdown
// precedent for "aliased LEFT JOIN derived tables, clearer as raw SQL").
// Every `${value}` interpolation is a bound parameter (drizzle-orm's
// sql tag), never string concatenation. The free-text search uses
// ILIKE via sql.raw() (Postgres LIKE is case-sensitive). Aggregates from the
// `cam` derived table (SUM(...) AS total_commits/total_errors) and
// cowork_session_stats.total_cost_usd (numeric() on pg) are Number()-coerced,
// since Postgres returns them as strings.
import { NextRequest, NextResponse } from 'next/server';
import { sql, type SQL } from 'drizzle-orm';
import { getComplianceEvents, getComplianceEventById } from '@/lib/db/queries';
import { getTypedClient } from '@/lib/db/client';
import { getAdminSession, canAccessAuditLog } from '@/lib/auth/admin-auth';
import { lacksDepartment, noDepartmentResponse } from '@/lib/auth/content-access';
import { logAccess } from '@/lib/audit/log';
import { getCodeModelRates, priceModelsJson } from '@/lib/pulse/code/rates';

// ─── Raw-execution facade (mirrors lib/db/queries.ts's rawAll) ────────────────
interface RawFacade {
  execute?: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute!(query);
  return res.rows as T[];
}

/** Case-insensitive LIKE: ILIKE, since Postgres LIKE is case-sensitive. */
function likeKeyword(): SQL {
  return sql.raw('ILIKE');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CoworkEventRow {
  id: string;
  session_id: string;
  user_id: string | null;
  message_type: string;
  role: string | null;
  content_preview: string | null;
  flagged: number;
  flag_reason: string | null;
  occurred_at: number;
  ingested_at: number;
  surface: string | null;
  source: string | null;
}

interface ChatEventRow {
  id: string;
  conversation_id: string | null;
  user_id: string | null;
  prompt_text: string;
  prompt_length: number;
  flagged: number;
  flag_reason: string | null;
  occurred_at: number;
  ingested_at: number;
  agent_id: string | null;
  source: string;
}

/**
 * Get cowork messages projected into the same shape as compliance events,
 * so the audit log can show them inline.
 */
async function getCoworkEventsForAudit(filters: {
  userId?: string;
  department?: string;
  flaggedOnly?: boolean;
  dateFrom?: number;
  dateTo?: number;
  limit?: number;
  offset?: number;
  surface?: string;
  source?: string;
  search?: string;
}): Promise<Array<{
  id: string;
  user_id: string;
  department: string | null;
  event_type: string;
  surface: string;
  content_preview: string | null;
  metadata: string | null;
  flagged: number;
  flag_reason: string | null;
  occurred_at: number;
  ingested_at: number;
  session_id: string;
  _source: string;
}>> {
  try {
    const client = await getTypedClient();
    const conditions: SQL[] = [];

    if (filters.userId) conditions.push(sql`cm.user_id = ${filters.userId}`);
    if (filters.department) conditions.push(sql`COALESCE(au.department, u.department) = ${filters.department}`);
    if (filters.flaggedOnly) conditions.push(sql`cm.flagged = 1`);
    if (filters.dateFrom) conditions.push(sql`cm.occurred_at >= ${filters.dateFrom}`);
    if (filters.dateTo) conditions.push(sql`cm.occurred_at <= ${filters.dateTo}`);
    if (filters.surface) conditions.push(sql`cm.surface = ${filters.surface}`);
    if (filters.source) conditions.push(sql`cm.source = ${filters.source}`);
    if (filters.search) {
      // UUID-shaped = exact ID match, otherwise content/user search
      if (UUID_RE.test(filters.search)) {
        conditions.push(sql`cm.id = ${filters.search}`);
      } else {
        const like = `%${filters.search}%`;
        const kw = likeKeyword();
        conditions.push(sql`(cm.content_preview ${kw} ${like} OR cm.content_full ${kw} ${like} OR cm.user_id ${kw} ${like})`);
      }
    }
    // Exclude noise: deprecated tool summaries, session-init system events, and OTel operational metadata
    conditions.push(sql`cm.message_type NOT IN ('cowork_tool_summary', 'cowork_message', 'cowork_session_init', 'cowork_tool_metadata', 'cowork_api_request', 'cowork_api_error')`);

    const where = sql`WHERE ${sql.join(conditions, sql` AND `)}`;
    const limit = filters.limit || 100;
    const offset = filters.offset || 0;

    const rows = await rawAll<CoworkEventRow & {
      content_full: string | null; user_display_name: string | null; user_department: string | null;
      total_cost_usd: number | string | null; total_input_tokens: number | null; total_output_tokens: number | null;
      tool_call_count: number | null; unique_tools: string | null; models_used: string | null;
      duration_secs: number | null; files_uploaded: string | null;
      pii_verdict_reason: string | null;
      prompt_id: string | null;
      git_branch: string | null; cwd: string | null; total_commits: number | string | null; total_errors: number | string | null;
      code_input_tokens: number | null; code_output_tokens: number | null;
      code_tool_use_count: number | null; code_models_json: string | null; code_active_secs: number | null;
    }>(client, sql`
       SELECT cm.id, cm.session_id, cm.user_id, cm.message_type, cm.role, cm.content_preview, cm.content_full, cm.flagged, cm.flag_reason, cm.pii_verdict_reason, cm.occurred_at, cm.ingested_at, cm.surface, cm.source, cm.prompt_id,
              COALESCE(au.display_name, u.display_name) as user_display_name, COALESCE(au.department, u.department) as user_department,
              css.total_cost_usd, css.total_input_tokens, css.total_output_tokens, css.tool_call_count, css.unique_tools, css.models_used, css.duration_secs,
              cs.files_uploaded,
              cam.git_branch, cam.cwd, cam.total_commits, cam.total_errors,
              cds.input_tokens AS code_input_tokens, cds.output_tokens AS code_output_tokens,
              cds.tool_use_count AS code_tool_use_count, cds.models_json AS code_models_json, cds.active_secs AS code_active_secs
       FROM cowork_messages cm
       LEFT JOIN users u ON cm.user_id = u.id
       LEFT JOIN admin_users au ON au.linked_cowork_user_id = cm.user_id
       LEFT JOIN cowork_session_stats css ON css.session_id = cm.session_id
       LEFT JOIN cowork_sessions cs ON cs.id = cm.session_id
       LEFT JOIN (
         SELECT session_id,
                MAX(git_branch) AS git_branch,
                MAX(cwd) AS cwd,
                SUM(COALESCE(commit_count, 0)) AS total_commits,
                SUM(COALESCE(error_count, 0)) AS total_errors
         FROM code_assistant_meta
         GROUP BY session_id
       ) cam ON cam.session_id = cm.session_id
       LEFT JOIN code_session_stats cds ON cds.session_id = cm.session_id
       ${where}
       ORDER BY cm.occurred_at DESC LIMIT ${limit} OFFSET ${offset}
    `);

    // Code sessions don't write cowork_session_stats (css above is always
    // null for them), so cost/tokens/tool-count/duration/model come from
    // code_session_stats instead — resolved once per request, not per row.
    const codeRates = await getCodeModelRates();

    return rows.map(r => ({
      id: r.id,
      user_id: r.user_display_name || r.user_id || 'unknown',
      department: r.user_department ?? null,
      // Normalise legacy misnamed events: cowork_user_message on code surface → code_user_message
      event_type: (r.surface === 'code' && r.message_type === 'cowork_user_message') ? 'code_user_message' : r.message_type,
      surface: r.surface || 'cowork',
      content_preview: r.content_full || r.content_preview,
      metadata: JSON.stringify({ role: r.role, session_id: r.session_id }),
      flagged: r.flagged,
      flag_reason: r.flag_reason,
      pii_verdict_reason: r.pii_verdict_reason ?? null,
      occurred_at: r.occurred_at,
      ingested_at: r.ingested_at,
      session_id: r.session_id,
      prompt_id: r.prompt_id ?? null,
      _source: sourceBadge(r.source),
      session_enrichment: (() => {
        const isCode = r.surface === 'code';
        const { costUsd: codeCostUsd, models: codeModels } = isCode
          ? priceModelsJson(r.code_models_json, codeRates)
          : { costUsd: null, models: [] as string[] };
        const costUsd = isCode
          ? codeCostUsd
          // total_cost_usd is numeric() on pg -> a STRING (Postgres returns bigint and numeric as strings).
          : (r.total_cost_usd !== null && r.total_cost_usd !== undefined ? Number(r.total_cost_usd) : null);
        const inputTokens = isCode ? r.code_input_tokens : r.total_input_tokens;
        const outputTokens = isCode ? r.code_output_tokens : r.total_output_tokens;
        const toolCallCount = isCode ? r.code_tool_use_count : r.tool_call_count;
        const durationSecs = isCode ? r.code_active_secs : r.duration_secs;
        const modelsUsed = isCode ? (codeModels.length > 0 ? JSON.stringify(codeModels) : null) : r.models_used;
        if (costUsd == null && toolCallCount == null && !r.files_uploaded && !r.git_branch && inputTokens == null) {
          return null;
        }
        return JSON.stringify({
          cost_usd: costUsd,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          tool_call_count: toolCallCount,
          // Code doesn't capture individual tool names (only a count) — never
          // fabricate a "Tools:" list for it.
          unique_tools: isCode ? null : r.unique_tools,
          models_used: modelsUsed,
          duration_secs: durationSecs,
          files_uploaded: r.files_uploaded,
          git_branch: r.git_branch,
          cwd: r.cwd,
          // SUM(...) aggregates from the `cam` derived table come back as
          // STRINGS on pg; Number()-coerce, then collapse a falsy zero to
          // null (`|| null`).
          total_commits: (r.total_commits !== null && r.total_commits !== undefined ? Number(r.total_commits) : 0) || null,
          total_errors: (r.total_errors !== null && r.total_errors !== undefined ? Number(r.total_errors) : 0) || null,
        });
      })(),
    }));
  } catch {
    return [];
  }
}

/**
 * Source badge for EVERY audit row: where the row actually came from, read
 * from its own `source` column: the app stamps the door each row arrived
 * through, so the display reads the stamp and never assumes it from the
 * surface (Compliance-synced chat connectors, for example, are not OTel).
 * The OTel receivers write 'otel', the Compliance API sync writes
 * 'compliance', the retired local agent (and older seeds) wrote 'agent'.
 * Anything unrecognised renders as the agent badge, never as one of the two
 * live capture paths.
 */
function sourceBadge(source: string | null | undefined): 'compliance' | 'otel' | 'local-agent' {
  if (source === 'compliance') return 'compliance';
  if (source === 'otel') return 'otel';
  return 'local-agent';
}

/**
 * Get skill and MCP connector invocations projected into audit event shape.
 * These live in cowork_skill_invocations / cowork_mcp_invocations — separate from cowork_messages.
 */
async function getSkillConnectorEventsForAudit(filters: {
  userId?: string;
  department?: string;
  dateFrom?: number;
  dateTo?: number;
  limit?: number;
  search?: string;
  flaggedOnly?: boolean;
  surface?: string;
  /** Filter on the rows' own `source` column — 'compliance' rows came from
   *  the Compliance API chat sync, everything else from OTel. */
  source?: 'compliance' | 'otel';
}): Promise<Array<{
  id: string;
  user_id: string;
  department: string | null;
  event_type: string;
  surface: string;
  content_preview: string | null;
  metadata: string | null;
  flagged: number;
  flag_reason: string | null;
  occurred_at: number;
  ingested_at: number;
  session_id: string;
  _source: string;
}>> {
  if (filters.flaggedOnly) return [];
  try {
    const client = await getTypedClient();
    const limit = filters.limit || 200;
    const results: Awaited<ReturnType<typeof getSkillConnectorEventsForAudit>> = [];

    // — Skills ————————————————————————————————————————————————————————
    const skillConds: SQL[] = [];
    if (filters.userId) skillConds.push(sql`csi.user_id = ${filters.userId}`);
    if (filters.department) skillConds.push(sql`COALESCE(au.department, u.department) = ${filters.department}`);
    if (filters.dateFrom) skillConds.push(sql`csi.occurred_at >= ${filters.dateFrom}`);
    if (filters.dateTo) skillConds.push(sql`csi.occurred_at <= ${filters.dateTo}`);
    if (filters.search) skillConds.push(sql`csi.skill_name ${likeKeyword()} ${`%${filters.search}%`}`);
    if (filters.surface) skillConds.push(sql`csi.surface = ${filters.surface}`);
    if (filters.source === 'compliance') skillConds.push(sql`csi.source = 'compliance'`);
    if (filters.source === 'otel') skillConds.push(sql`COALESCE(csi.source, '') <> 'compliance'`);
    const skillWhere = skillConds.length ? sql`WHERE ${sql.join(skillConds, sql` AND `)}` : sql``;

    const skillRows = await rawAll<{
      id: string; user_id: string; session_id: string; skill_name: string;
      invocation_type: string; source: string; surface: string; occurred_at: number;
      user_display_name: string | null; user_department: string | null;
    }>(client, sql`
      SELECT csi.id, csi.user_id, csi.session_id, csi.skill_name, csi.invocation_type, csi.source, csi.surface, csi.occurred_at,
             COALESCE(au.display_name, u.display_name) AS user_display_name,
             COALESCE(au.department, u.department) AS user_department
       FROM cowork_skill_invocations csi
       LEFT JOIN users u ON csi.user_id = u.id
       LEFT JOIN admin_users au ON au.linked_cowork_user_id = csi.user_id
       ${skillWhere}
       ORDER BY csi.occurred_at DESC LIMIT ${limit}
    `);

    for (const r of skillRows) {
      results.push({
        id: r.id,
        user_id: r.user_display_name || r.user_id || 'unknown',
        department: r.user_department ?? null,
        event_type: 'cowork_skill_event',
        surface: r.surface,
        content_preview: r.skill_name,
        metadata: JSON.stringify({ skill_name: r.skill_name, invocation_type: r.invocation_type, session_id: r.session_id }),
        flagged: 0,
        flag_reason: null,
        occurred_at: r.occurred_at,
        ingested_at: r.occurred_at,
        session_id: r.session_id || '',
        _source: sourceBadge(r.source),
      });
    }

    // — MCP connectors ————————————————————————————————————————————————
    const mcpConds: SQL[] = [sql`cmi.mcp_server NOT IN ('workspace', 'cowork', 'Claude_in_Chrome')`];
    if (filters.userId) mcpConds.push(sql`cmi.user_id = ${filters.userId}`);
    if (filters.department) mcpConds.push(sql`COALESCE(au.department, u.department) = ${filters.department}`);
    if (filters.dateFrom) mcpConds.push(sql`cmi.occurred_at >= ${filters.dateFrom}`);
    if (filters.dateTo) mcpConds.push(sql`cmi.occurred_at <= ${filters.dateTo}`);
    if (filters.search) {
      const like = `%${filters.search}%`;
      const kw = likeKeyword();
      mcpConds.push(sql`(cmi.mcp_server ${kw} ${like} OR cmi.mcp_tool ${kw} ${like})`);
    }
    if (filters.surface) mcpConds.push(sql`cmi.surface = ${filters.surface}`);
    if (filters.source === 'compliance') mcpConds.push(sql`cmi.source = 'compliance'`);
    if (filters.source === 'otel') mcpConds.push(sql`COALESCE(cmi.source, '') <> 'compliance'`);
    const mcpWhere = sql`WHERE ${sql.join(mcpConds, sql` AND `)}`;

    const mcpRows = await rawAll<{
      id: string; user_id: string; session_id: string; mcp_server: string; mcp_tool: string;
      success: number; source: string; surface: string; occurred_at: number;
      user_display_name: string | null; user_department: string | null;
    }>(client, sql`
      SELECT cmi.id, cmi.user_id, cmi.session_id, cmi.mcp_server, cmi.mcp_tool, cmi.success, cmi.source, cmi.surface, cmi.occurred_at,
             COALESCE(au.display_name, u.display_name) AS user_display_name,
             COALESCE(au.department, u.department) AS user_department
       FROM cowork_mcp_invocations cmi
       LEFT JOIN users u ON cmi.user_id = u.id
       LEFT JOIN admin_users au ON au.linked_cowork_user_id = cmi.user_id
       ${mcpWhere}
       ORDER BY cmi.occurred_at DESC LIMIT ${limit}
    `);

    for (const r of mcpRows) {
      results.push({
        id: r.id,
        user_id: r.user_display_name || r.user_id || 'unknown',
        department: r.user_department ?? null,
        event_type: 'cowork_mcp_event',
        surface: r.surface,
        content_preview: `${r.mcp_server}: ${r.mcp_tool}`,
        metadata: JSON.stringify({ mcp_server: r.mcp_server, mcp_tool: r.mcp_tool, success: Boolean(r.success), session_id: r.session_id }),
        flagged: 0,
        flag_reason: null,
        occurred_at: r.occurred_at,
        ingested_at: r.occurred_at,
        session_id: r.session_id || '',
        _source: sourceBadge(r.source),
      });
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Get chat messages projected into audit event shape.
 */
async function getChatEventsForAudit(filters: {
  userId?: string;
  department?: string;
  flaggedOnly?: boolean;
  dateFrom?: number;
  dateTo?: number;
  limit?: number;
  offset?: number;
  search?: string;
  source?: 'agent' | 'compliance';
}): Promise<Array<{
  id: string;
  user_id: string;
  department: string | null;
  event_type: string;
  surface: string;
  content_preview: string | null;
  metadata: string | null;
  flagged: number;
  flag_reason: string | null;
  occurred_at: number;
  ingested_at: number;
  session_id: string;
  _source: string;
}>> {
  try {
    const client = await getTypedClient();
    const conditions: SQL[] = [];

    if (filters.userId) conditions.push(sql`cm.user_id = ${filters.userId}`);
    if (filters.department) conditions.push(sql`u.department = ${filters.department}`);
    if (filters.flaggedOnly) conditions.push(sql`cm.flagged = 1`);
    if (filters.dateFrom) conditions.push(sql`cm.occurred_at >= ${filters.dateFrom}`);
    if (filters.dateTo) conditions.push(sql`cm.occurred_at <= ${filters.dateTo}`);
    // Provenance filter: explicit `source` column (CT9) — written by each
    // ingest path, not inferred from agent_id (which mislabelled synthetic
    // seed rows with a NULL agent_id as Compliance API).
    if (filters.source) conditions.push(sql`cm.source = ${filters.source}`);
    if (filters.search) {
      if (UUID_RE.test(filters.search)) {
        conditions.push(sql`cm.id = ${filters.search}`);
      } else {
        const like = `%${filters.search}%`;
        const kw = likeKeyword();
        conditions.push(sql`(cm.prompt_text ${kw} ${like} OR cm.user_id ${kw} ${like})`);
      }
    }

    const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
    const limit = filters.limit || 100;
    const offset = filters.offset || 0;

    const rows = await rawAll<ChatEventRow & { user_display_name: string | null; user_department: string | null }>(client, sql`
       SELECT cm.*, u.display_name as user_display_name, u.department as user_department
       FROM chat_messages cm
       LEFT JOIN users u ON cm.user_id = u.id
       ${where}
       ORDER BY cm.occurred_at DESC LIMIT ${limit} OFFSET ${offset}
    `);

    return rows.map(r => ({
      id: r.id,
      user_id: r.user_display_name || r.user_id || 'unknown',
      department: r.user_department ?? null,
      event_type: 'chat_prompt',
      surface: 'chat',
      content_preview: r.prompt_text.length > 120 ? r.prompt_text.slice(0, 120) + '...' : r.prompt_text,
      metadata: JSON.stringify({ conversation_id: r.conversation_id, prompt_length: r.prompt_length }),
      flagged: r.flagged,
      flag_reason: r.flag_reason,
      occurred_at: r.occurred_at,
      ingested_at: r.ingested_at,
      session_id: r.conversation_id || '',
      _source: sourceBadge(r.source),
    }));
  } catch {
    return [];
  }
}

// Disable Next.js route caching — all API routes read live data from the database
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    await logAccess({ actorId: 'unauthenticated', actorEmail: 'unknown', actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'events', action: 'READ', outcome: 'denied' });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // The Audit Log shows people's prompt text: admin and manager only.
  if (!canAccessAuditLog(session.role)) {
    await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'events', action: 'READ', outcome: 'denied' });
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // A manager sees their own department only, so one with no department sees nothing.
  if (lacksDepartment(session)) {
    await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'events', action: 'READ', outcome: 'denied', detail: 'no_department' });
    return noDepartmentResponse();
  }
  await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'events', action: 'READ', outcome: 'success', detail: request.nextUrl.search || undefined });
  const params = request.nextUrl.searchParams;

  const id = params.get('id');
  if (id) {
    const event = await getComplianceEventById(id);
    if (!event) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(event);
  }

  const source = params.get('source'); // 'compliance' | 'otel' | 'cowork' | undefined (all)
  const surface = params.get('surface') || undefined;
  const userId = params.get('userId') || undefined;
  // Admins see all departments; a manager is locked to their own department
  const department = session.role === 'admin'
    ? (params.get('department') || undefined)
    : session.department!;
  const flaggedOnly = params.get('flagged') === 'true';
  const dateFrom = params.get('dateFrom') ? parseInt(params.get('dateFrom')!) : undefined;
  const dateTo = params.get('dateTo') ? parseInt(params.get('dateTo')!) : undefined;
  const search = params.get('search') || undefined;
  const limit = parseInt(params.get('limit') || '100');
  const offset = parseInt(params.get('offset') || '0');

  if (source === 'otel') {
    // OpenTelemetry: all cowork_messages ingested via OTel + skill/connector invocations
    const messages = await getCoworkEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit, offset, source: 'otel' });
    const skillsConnectors = await getSkillConnectorEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit, source: 'otel' });
    const merged = [...messages, ...skillsConnectors]
      .sort((a, b) => b.occurred_at - a.occurred_at)
      .slice(0, limit);
    return NextResponse.json(merged);
  }

  if (source === 'agent') {
    // Local agent: cowork_messages with source='agent' + legacy-agent chat events (agent_id stamped)
    const messages = await getCoworkEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit, offset, source: 'agent' });
    const chatEvents = await getChatEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit, offset, source: 'agent' });
    const merged = [...messages, ...chatEvents]
      .sort((a, b) => b.occurred_at - a.occurred_at)
      .slice(0, limit);
    return NextResponse.json(merged);
  }

  if (source === 'compliance') {
    // Compliance API: chat events synced server-side (agent_id NULL), plus
    // the chat connector invocations the same sync writes (source='compliance').
    const events = await getChatEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit, offset, source: 'compliance' });
    const connectors = await getSkillConnectorEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit, source: 'compliance' });
    const merged = [...events, ...connectors]
      .sort((a, b) => b.occurred_at - a.occurred_at)
      .slice(0, limit);
    return NextResponse.json(merged);
  }

  if (source === 'cowork') {
    const messages = await getCoworkEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit, offset, surface: 'cowork' });
    const skillsConnectors = await getSkillConnectorEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit });
    const merged = [...messages, ...skillsConnectors]
      .sort((a, b) => b.occurred_at - a.occurred_at)
      .slice(0, limit);
    return NextResponse.json(merged);
  }

  if (source === 'code') {
    const messages = await getCoworkEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit, offset, surface: 'code' });
    const skillsConnectors = await getSkillConnectorEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit, surface: 'code' });
    const merged = [...messages, ...skillsConnectors]
      .sort((a, b) => b.occurred_at - a.occurred_at)
      .slice(0, limit);
    return NextResponse.json(merged);
  }

  if (source === 'chat') {
    const events = await getChatEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit, offset });
    return NextResponse.json(events);
  }

  // Default: merge compliance + cowork + chat events, sorted by time
  if (surface === 'cowork') {
    const messages = await getCoworkEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit, offset, surface: 'cowork' });
    const skillsConnectors = await getSkillConnectorEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit, surface: 'cowork' });
    const merged = [...messages, ...skillsConnectors]
      .sort((a, b) => b.occurred_at - a.occurred_at)
      .slice(0, limit);
    return NextResponse.json(merged);
  }

  if (surface === 'code') {
    const messages = await getCoworkEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit, offset, surface: 'code' });
    const skillsConnectors = await getSkillConnectorEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit, surface: 'code' });
    const merged = [...messages, ...skillsConnectors]
      .sort((a, b) => b.occurred_at - a.occurred_at)
      .slice(0, limit);
    return NextResponse.json(merged);
  }

  if (surface === 'chat') {
    const events = await getChatEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit, offset });
    return NextResponse.json(events);
  }

  const complianceEvents = await getComplianceEvents({ surface, userId, department, flaggedOnly, dateFrom, dateTo, search, limit, offset });

  // Also include cowork + chat + skill/connector events when showing all surfaces
  if (!surface) {
    const coworkEvents = await getCoworkEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit, offset });
    const chatEvents = await getChatEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit, offset });
    const skillsConnectors = await getSkillConnectorEventsForAudit({ userId, department, flaggedOnly, dateFrom, dateTo, search, limit });
    const merged = [...complianceEvents, ...coworkEvents, ...chatEvents, ...skillsConnectors]
      .sort((a, b) => b.occurred_at - a.occurred_at)
      .slice(0, limit);
    return NextResponse.json(merged);
  }

  return NextResponse.json(complianceEvents);
}
