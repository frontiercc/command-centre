// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0
// Some icon drawings in this file are from Lucide (ISC); see THIRD-PARTY-NOTICES.md.

'use client';

import { useEffect, useState, useCallback, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import Link from 'next/link';
import { flagSeverity, isFullyDismissed } from '@/lib/pii/flag-severity';
import { useCorePlatformGuard } from '@/components/shared/useCorePlatformGuard';
import { PageBody, Panel, PanelFoot, Notice, Empty, Tag, Dot, T, B, SEVERITY_COLOR } from '@/components/precision/ui';
import WhereMoneyWent, { SplitLine, spendMoney } from '@/components/finance/WhereMoneyWent';
import { hasBreakdown, type SpendSplit } from '@/lib/finance/where-money-went';

interface AuditEvent {
  id: string;
  user_id: string;
  department?: string | null;
  event_type: string;
  surface: string;
  content_preview: string | null;
  metadata: string | null;
  flagged: number;
  flag_reason: string | null;
  pii_verdict_reason?: string | null;
  occurred_at: number;
  ingested_at: number;
  session_id?: string;
  prompt_id?: string | null;
  _source?: string;
  session_enrichment?: string | null;
}

interface SessionEnrichment {
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  tool_call_count: number | null;
  unique_tools: string | null;
  models_used: string | null;
  duration_secs: number | null;
  files_uploaded: string | null;
  git_branch: string | null;
  cwd: string | null;
  total_commits: number | null;
  total_errors: number | null;
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  code_user_message: 'User prompt',
  cowork_user_message: 'User message',
  cowork_assistant_message: 'Assistant response',
  cowork_tool_result: 'Tool result',
  cowork_session_init: 'Session start',
  cowork_message: 'System event',
  cowork_git_diff: 'Git diff',
  cowork_skill_event: 'Skill invoked',
  cowork_mcp_event: 'Connector used',
  chat_prompt: 'User prompt',
  chat_completion: 'User prompt',
};

const RETENTION_MARKER = '[Content removed — retention policy]';

function cleanUserName(userId: string | null | undefined): string {
  if (!userId) return '—';
  if (userId.includes('@')) return userId.split('@')[0].replace(/([a-z])([A-Z])/g, '$1 $2');
  return userId;
}

function formatEventType(eventType: string): string {
  const label = EVENT_TYPE_LABELS[eventType];
  if (label) return label;
  // Fallback: strip surface prefix and humanise
  const text = eventType
    .replace(/^(cowork|code|chat)_/, '')
    .replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function timeOf(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-GB');
}

interface CoworkMessage {
  id: string;
  session_id: string;
  user_id: string | null;
  message_type: string;
  role: string | null;
  prompt_id: string | null;
  content_preview: string | null;
  content_full: string | null;
  tool_name: string | null;
  tool_input_preview: string | null;
  tool_output_preview: string | null;
  token_usage: string | null;
  model: string | null;
  flagged: number;
  flag_reason: string | null;
  synced_resources: string | null;
  occurred_at: number;
}

interface ChatThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  occurred_at: number;
  flagged: number;
  flag_reason: string | null;
  model?: string | null;
  artifacts_count?: number;
  generated_files_count?: number;
}

/* ── Small parts for the detail pane ──────────────────────────────── */

/** Conversation bubble. User: blue tint, assistant: white, tool and other: grey. */
function Bubble({ kind, header, children }: { kind: 'user' | 'assistant' | 'tool'; header: ReactNode; children: ReactNode }) {
  const cls = {
    user: 'self-end ml-8 border-[#C9D6FD] bg-[#F5F8FF]',
    assistant: 'self-start mr-8 border-[#EAEAEA] bg-white',
    tool: 'self-start mr-8 border-[#EAEAEA] bg-[#FAFAFA]',
  }[kind];
  return (
    <div className={`max-w-[85%] w-fit min-w-0 border rounded-[14px] px-3 py-2.5 flex flex-col gap-1 ${cls}`}>
      <span className="text-[12px] text-[#666666]">{header}</span>
      {children}
    </div>
  );
}

/** One-line metadata marker in a thread (tool activity, assistant reply placeholder). */
function MetaRow({ children, time, icon }: { children: ReactNode; time: number; icon?: string }) {
  return (
    <div className="rounded-[10px] px-3 py-1.5 text-[13px] bg-[#FAFAFA] border border-[#F2F2F2] flex items-center gap-2 text-[#8F8F8F]">
      {icon && <span className="text-[#B3B3B3] shrink-0" aria-hidden="true">{icon}</span>}
      <span className="min-w-0 truncate">{children}</span>
      <span className="ml-auto tabular-nums shrink-0">{timeOf(time)}</span>
    </div>
  );
}

function FlaggedMark() {
  return <span className="text-[#B42318] font-medium"> · Flagged</span>;
}

function FlagLine({ reason }: { reason: string }) {
  return <div className="mt-1 text-[13px] text-[#7A271A] bg-[#FFF5F4] border border-[#F3C0BB] rounded-[6px] px-2 py-1">{reason}</div>;
}

/** A bordered grey box: source notes, content preview, metadata. */
function NoteBox({ children }: { children: ReactNode }) {
  return <div className="border border-[#EAEAEA] bg-[#FAFAFA] rounded-[10px] px-3 py-2.5 text-[13px] text-[#666666]">{children}</div>;
}

function SectionHead({ title, count }: { title: string; count?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[14px] font-semibold text-[#0A0A0A]">{title}</span>
      {count !== undefined && <span className="text-[13px] text-[#8F8F8F] tabular-nums">{count}</span>}
    </div>
  );
}

function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return <span title={title} className="font-mono text-[12px] text-[#4D4D4D] bg-white border border-[#EAEAEA] rounded-[6px] px-1.5 py-px break-all">{children}</span>;
}

/** Icon per synced resource. */
function resourceIcon(mimeType: string | null): string {
  if (mimeType?.includes('presentation') || mimeType?.includes('spreadsheet')) return '📊';
  if (mimeType?.includes('document')) return '📄';
  if (mimeType?.includes('folder')) return '📁';
  return '📎';
}

function resourceKind(mimeType: string | null): string {
  if (mimeType?.includes('presentation')) return 'Slides';
  if (mimeType?.includes('spreadsheet')) return 'Sheet';
  if (mimeType?.includes('document')) return 'Doc';
  if (mimeType?.includes('folder')) return 'Folder';
  return 'File';
}

function ChatThread({ messages }: { messages: ChatThreadMessage[] }) {
  if (messages.length === 0) {
    return (
      <p className="m-0 text-[13px] text-[#8F8F8F] py-4">No messages in this conversation.</p>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {messages.map((msg) => {
        if (msg.role === 'assistant') {
          // Metadata marker only — assistant text is never stored or shown.
          const parts = ['Claude replied'];
          if (msg.model) parts.push(msg.model);
          if (msg.artifacts_count) parts.push(`${msg.artifacts_count} artifact${msg.artifacts_count !== 1 ? 's' : ''}`);
          if (msg.generated_files_count) parts.push(`${msg.generated_files_count} file${msg.generated_files_count !== 1 ? 's' : ''}`);
          return (
            <MetaRow key={msg.id} time={msg.occurred_at} icon="↩">{parts.join(' · ')}</MetaRow>
          );
        }

        return (
          <Bubble
            key={msg.id}
            kind="user"
            header={<>User · <span className="tabular-nums">{timeOf(msg.occurred_at)}</span>{msg.flagged ? <FlaggedMark /> : null}</>}
          >
            <div className="text-[14px] leading-[1.5] text-[#0A0A0A] whitespace-pre-wrap break-words">
              {msg.content === RETENTION_MARKER ? (
                <span className="text-[13px] text-[#8F8F8F]">Content removed under the retention policy</span>
              ) : (
                msg.content || <span className="text-[#8F8F8F]">No content captured</span>
              )}
            </div>
            {msg.flagged && msg.flag_reason ? <FlagLine reason={msg.flag_reason} /> : null}
          </Bubble>
        );
      })}
    </div>
  );
}

function CoworkThread({ messages }: { messages: CoworkMessage[] }) {
  if (messages.length === 0) {
    return (
      <p className="m-0 text-[13px] text-[#8F8F8F] py-4">No messages in this session.</p>
    );
  }

  const turns: { promptId: string | null; messages: CoworkMessage[] }[] = [];
  for (const msg of messages) {
    const last = turns[turns.length - 1];
    if (last && last.promptId === msg.prompt_id) {
      last.messages.push(msg);
    } else {
      turns.push({ promptId: msg.prompt_id, messages: [msg] });
    }
  }
  const multiTurn = turns.length > 1;

  return (
    <div className="flex flex-col gap-4">
      {turns.map((turn, ti) => (
        <div key={turn.promptId ?? ti} className="flex flex-col gap-2.5">
          {multiTurn && (
            <div className="flex items-center gap-2">
              <div className="h-px flex-1 bg-[#EAEAEA]" />
              <span className="text-[12px] text-[#8F8F8F] whitespace-nowrap tabular-nums">
                Turn {ti + 1} · {timeOf(turn.messages[0].occurred_at)}
              </span>
              <div className="h-px flex-1 bg-[#EAEAEA]" />
            </div>
          )}
          {turn.messages.map((msg) => {
            const isUser = msg.role === 'human' || msg.role === 'user' || msg.message_type === 'cowork_user_message' || msg.message_type === 'code_user_message';
            const isAssistant = msg.role === 'assistant' || msg.message_type === 'cowork_assistant_message';
            const isTool = msg.message_type === 'cowork_tool_result';
            const isGitDiff = msg.message_type === 'cowork_git_diff';
            const isToolActivity = msg.message_type === 'cowork_tool_metadata';

            // Render tool activity rows compactly — they're metadata, not content
            if (isToolActivity) {
              return (
                <MetaRow key={msg.id} time={msg.occurred_at} icon="⚙">
                  <span className="font-mono">{msg.content_preview || 'Tool activity'}</span>
                </MetaRow>
              );
            }

            const label = isUser ? 'User' : isAssistant ? 'Claude' : isTool ? `Tool: ${msg.tool_name || 'unknown'}` : isGitDiff ? 'Git diff' : msg.message_type;

            return (
              <Bubble
                key={msg.id}
                kind={isUser ? 'user' : isAssistant ? 'assistant' : 'tool'}
                header={<>{label} · <span className="tabular-nums">{timeOf(msg.occurred_at)}</span>{msg.flagged ? <FlaggedMark /> : null}</>}
              >
                {/* Content — show preview with expandable full text for long messages */}
                <div className={`text-[14px] leading-[1.5] whitespace-pre-wrap break-words ${isUser ? 'text-[#0A0A0A]' : 'text-[#333333]'}`}>
                  {msg.content_preview === RETENTION_MARKER ? (
                    <span className="text-[13px] text-[#8F8F8F]">Content removed under the retention policy</span>
                  ) : msg.content_full && msg.content_full.length > 300 ? (
                    <details>
                      <summary className="cursor-pointer">{msg.content_preview || msg.content_full.slice(0, 200)}…</summary>
                      <div className="mt-1">{msg.content_full}</div>
                    </details>
                  ) : (
                    msg.content_full || msg.content_preview || (
                      <span className="text-[#8F8F8F]">No content captured</span>
                    )
                  )}
                </div>

                {/* Tool details */}
                {isTool && msg.tool_input_preview && (
                  <details className="mt-1">
                    <summary className="text-[13px] text-[#245BF3] cursor-pointer">Input</summary>
                    <pre className="m-0 mt-1 text-[12px] font-mono text-[#4D4D4D] bg-white border border-[#EAEAEA] rounded-[6px] p-2 overflow-x-auto">{msg.tool_input_preview}</pre>
                  </details>
                )}
                {isTool && msg.tool_output_preview && (
                  <details>
                    <summary className="text-[13px] text-[#245BF3] cursor-pointer">Output</summary>
                    <pre className="m-0 mt-1 text-[12px] font-mono text-[#4D4D4D] bg-white border border-[#EAEAEA] rounded-[6px] p-2 overflow-x-auto">{msg.tool_output_preview}</pre>
                  </details>
                )}

                {/* Synced MCP resources (Google Drive docs, etc.) */}
                {isUser && msg.synced_resources && (() => {
                  let resources: Array<{ name: string; uri: string | null; mimeType: string | null }> = [];
                  try { resources = JSON.parse(msg.synced_resources); } catch { return null; }
                  if (!resources.length) return null;
                  return (
                    <div className="mt-1.5 pt-1.5 border-t border-[#C9D6FD] flex flex-wrap items-center gap-1.5">
                      <span className="text-[12px] text-[#666666] shrink-0"><span aria-hidden="true">📎</span> Synced:</span>
                      {resources.map((r, i) => {
                        const chip = (
                          <span className="inline-flex items-center gap-1.5 bg-white border border-[#EAEAEA] text-[13px] text-[#333333] px-1.5 py-px rounded-[6px] max-w-xs truncate">
                            <span aria-hidden="true">{resourceIcon(r.mimeType)}</span><Tag>{resourceKind(r.mimeType)}</Tag>{r.name}
                          </span>
                        );
                        return r.uri ? (
                          <a key={i} href={r.uri} target="_blank" rel="noopener noreferrer" className="hover:opacity-75">{chip}</a>
                        ) : <span key={i}>{chip}</span>;
                      })}
                    </div>
                  );
                })()}

                {/* Flag reason */}
                {msg.flagged && msg.flag_reason ? <FlagLine reason={msg.flag_reason} /> : null}

                {/* Token usage */}
                {msg.token_usage && (
                  <div className="text-[12px] text-[#8F8F8F]">
                    Tokens: {msg.token_usage}
                  </div>
                )}
              </Bubble>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SourceCell({ event }: { event: AuditEvent }) {
  if (event._source === 'otel') return <>OTel</>;
  if (event._source === 'local-agent') return <>Agent</>;
  return <>{event.surface === 'cowork_partial' ? 'OpenTelemetry' : 'Compliance API'}</>;
}

function StatusCell({ event }: { event: AuditEvent }) {
  if (!event.flagged) {
    return <span className="text-[#8F8F8F]"><Dot color="#D4D4D4">OK</Dot></span>;
  }
  if (isFullyDismissed(event.flag_reason)) {
    return (
      <span className="text-[#8F8F8F]" title="Pattern matched, but the confirmation check found it was not a genuine identifier">
        <Dot color="#D4D4D4">Dismissed</Dot>
      </span>
    );
  }
  const sev = flagSeverity(event.flag_reason);
  return (
    <span className="capitalize" style={{ color: SEVERITY_COLOR[sev] ?? SEVERITY_COLOR.low }}>
      <Dot color={SEVERITY_COLOR[sev] ?? SEVERITY_COLOR.low}>{sev}</Dot>
    </span>
  );
}

export default function AuditPage() {
  useCorePlatformGuard({ auditLog: true });
  const searchParams = useSearchParams();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  // Set when /api/events refuses the caller (anyone but admin or manager).
  // The guard above also sends them elsewhere; this keeps the page from
  // ever showing a crash while that happens.
  const [noAccess, setNoAccess] = useState(false);
  const [noDepartment, setNoDepartment] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<AuditEvent | null>(null);

  // Cowork slide-over state
  const [coworkMessages, setCoworkMessages] = useState<CoworkMessage[]>([]);
  const [coworkLoading, setCoworkLoading] = useState(false);
  // Where the money went for the open conversation and prompt (loaded on open).
  const [sessionSpend, setSessionSpend] = useState<{ conversation: SpendSplit; prompt: SpendSplit | null } | null>(null);

  // Chat conversation thread slide-over state
  const [chatThreadMessages, setChatThreadMessages] = useState<ChatThreadMessage[]>([]);
  const [chatThreadLoading, setChatThreadLoading] = useState(false);

  // Filters
  const [surface, setSurface] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  // Seeds once from ?q= (e.g. a "View in Audit Log" link from a PII alert) — the
  // URL isn't kept in sync afterwards, this is a one-time initial value only.
  const [searchQuery, setSearchQuery] = useState(() => searchParams.get('q') ?? '');
  const [searchDebounced, setSearchDebounced] = useState(searchQuery);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const PAGE_SIZE = 100;

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setSearchDebounced(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Filters — department
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [, setSessionDepartment] = useState<string | null>(null);

  // Load user list for the filter dropdown
  const [users, setUsers] = useState<Array<{ id: string; display_name: string | null; email: string; department?: string | null }>>([]);
  useEffect(() => {
    // Roles outside the directory get department names only (no id, name or
    // email); keep just the people the picker can show.
    fetch('/api/users?all=true').then(r => r.json())
      .then(d => setUsers(Array.isArray(d) ? d.filter(u => u && u.id && u.email) : []))
      .catch(() => {});
    fetch('/api/admin/session').then(r => r.json()).then(data => {
      setSessionDepartment(data?.user?.department ?? null);
    }).catch(() => {});
  }, []);

  // Derive sorted unique department list from loaded users
  const departments = useMemo(() => {
    const depts = users.map(u => u.department).filter((d): d is string => Boolean(d));
    return Array.from(new Set(depts)).sort();
  }, [users]);

  // The picker lists well over a hundred people, so it is sorted by the label
  // actually shown — display name where there is one, email otherwise — rather
  // than by whatever order the API returned. localeCompare so accented names
  // sort where a reader expects, and case never splits the list in two.
  const sortedUsers = useMemo(
    () => [...users].sort((a, b) =>
      (a.display_name || a.email).localeCompare(b.display_name || b.email, undefined, { sensitivity: 'base' })),
    [users],
  );

  const fetchEvents = useCallback((resetOffset = true) => {
    const currentOffset = resetOffset ? 0 : offset;
    if (resetOffset) setOffset(0);

    const params = new URLSearchParams();
    if (surface) params.set('surface', surface);
    if (sourceFilter) params.set('source', sourceFilter);
    if (userFilter) params.set('userId', userFilter);
    if (departmentFilter) params.set('department', departmentFilter);
    if (flaggedOnly) params.set('flagged', 'true');
    if (dateFrom) params.set('dateFrom', String(Math.floor(new Date(dateFrom).getTime() / 1000)));
    if (dateTo) params.set('dateTo', String(Math.floor(new Date(dateTo).getTime() / 1000)));
    if (searchDebounced) params.set('search', searchDebounced);
    params.set('limit', String(PAGE_SIZE + 1)); // fetch one extra to detect more
    params.set('offset', String(currentOffset));

    setLoading(true);
    fetch(`/api/events?${params}`)
      .then(async r => {
        if (r.status === 401 || r.status === 403) {
          const body = await r.json().catch(() => null);
          if (body?.error === 'no_department') setNoDepartment(true);
          setNoAccess(true);
          return [];
        }
        return r.json();
      })
      .then((data: unknown) => {
        const rows: AuditEvent[] = Array.isArray(data) ? data : [];
        const hasMoreRows = rows.length > PAGE_SIZE;
        const page = rows.slice(0, PAGE_SIZE);
        if (resetOffset) {
          setEvents(page);
        } else {
          setEvents(prev => [...prev, ...page]);
        }
        setHasMore(hasMoreRows);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [surface, sourceFilter, userFilter, departmentFilter, flaggedOnly, dateFrom, dateTo, searchDebounced, offset]);

  // Refetch on filter changes only; fetchEvents also changes with offset, which must not refetch page one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchEvents(true); }, [surface, sourceFilter, userFilter, departmentFilter, flaggedOnly, dateFrom, dateTo, searchDebounced]);

  // When a cowork/code/chat event is selected, fetch the full conversation thread
  const handleEventClick = useCallback((event: AuditEvent) => {
    setSelectedEvent(event);
    setCoworkMessages([]);
    setChatThreadMessages([]);
    setSessionSpend(null);

    const sessionId = event.session_id || (event.metadata ? JSON.parse(event.metadata)?.session_id : null);

    if ((event.surface === 'cowork' || event.surface === 'code') && sessionId) {
      const spendQs = new URLSearchParams({ sessionId });
      if (event.prompt_id) spendQs.set('promptId', event.prompt_id);
      fetch(`/api/audit/session-spend?${spendQs}`)
        .then(r => (r.ok ? r.json() : null))
        .then(d => { if (d?.conversation) setSessionSpend({ conversation: d.conversation, prompt: d.prompt ?? null }); })
        .catch(() => {});
      setCoworkLoading(true);
      fetch(`/api/cowork/messages?sessionId=${sessionId}`)
        .then(r => r.json())
        .then(data => {
          const msgs = data.messages || [];
          setCoworkMessages(msgs);
          // Sync selected event's flagged status with fresh DB data
          // (async AI triage may have updated it after the list was fetched)
          const thisMsg = msgs.find((m: CoworkMessage) => m.id === event.id);
          if (thisMsg && thisMsg.flagged !== event.flagged) {
            setSelectedEvent(prev => prev ? { ...prev, flagged: thisMsg.flagged, flag_reason: thisMsg.flag_reason } : prev);
            // Refresh the list so the table row status matches
            fetchEvents();
          }
        })
        .catch(console.error)
        .finally(() => setCoworkLoading(false));
    } else if (event.surface === 'chat') {
      // Chat's session_id IS the conversation_id (see app/api/events/route.ts's
      // getChatEventsForAudit: session_id = r.conversation_id); metadata carries
      // the same value under conversation_id as a fallback for older rows.
      const conversationId = sessionId || (event.metadata ? (() => {
        try { return JSON.parse(event.metadata!)?.conversation_id || null; } catch { return null; }
      })() : null);

      if (conversationId) {
        setChatThreadLoading(true);
        fetch(`/api/chat/thread?conversationId=${conversationId}`)
          .then(r => r.json())
          .then(data => setChatThreadMessages(data.messages || []))
          .catch(console.error)
          .finally(() => setChatThreadLoading(false));
      }
    }
  }, [fetchEvents]);

  const isSkillEvent = selectedEvent?.event_type === 'cowork_skill_event';
  const isMcpEvent = selectedEvent?.event_type === 'cowork_mcp_event';
  const isCoworkEvent = selectedEvent?.surface === 'cowork';
  const isCodeEvent = selectedEvent?.surface === 'code';
  const isChatEvent = selectedEvent?.surface === 'chat' && selectedEvent?.event_type === 'chat_prompt';
  let hasSessionId: string | null = selectedEvent?.session_id || null;
  if (!hasSessionId && selectedEvent?.metadata) {
    try { hasSessionId = JSON.parse(selectedEvent.metadata)?.session_id || null; } catch { /* ignore */ }
  }

  const filtersActive = Boolean(searchDebounced || surface || sourceFilter || userFilter || departmentFilter || flaggedOnly || dateFrom || dateTo);

  if (noAccess) return (
    <>
      <TopBar title="Audit Log" subtitle="Compliance event trail across Chat, Code, and Cowork" />
      <PageBody>
        {noDepartment ? (
          <Notice tone="info" title="Your account has no department yet.">
            Managers see the Audit Log for their own department. Ask an admin to set your department.
          </Notice>
        ) : (
          <Notice tone="info" title="You don't have access to the Audit Log.">
            It shows what people typed, so only admins and managers can open it.{' '}
            <Link href="/pulse/me" className={B.link}>Go to My Pulse</Link>
          </Notice>
        )}
      </PageBody>
    </>
  );

  return (
    <>
      <TopBar title="Audit Log" subtitle="Compliance event trail across Chat, Code, and Cowork" />
      <PageBody>
        {/* What each surface captures */}
        <Notice tone="info">
          <div className="flex flex-col gap-0.5 text-[13px]">
            <span><span className="font-semibold">Claude Code:</span> Prompts, models, cost and tool use.</span>
            <span><span className="font-semibold">Cowork:</span> Prompts, models, cost and tool use.</span>
            <span><span className="font-semibold">Chat:</span> Prompts, through the Compliance API (Enterprise plan).</span>
            <span>Claude&apos;s replies are never stored.</span>
          </div>
        </Notice>

        {/* Search and filters */}
        <div className="flex flex-wrap gap-2 items-center">
          <label className="flex-grow min-w-[240px] flex items-center gap-2 px-2.5 py-1.5 border border-[#DADADA] rounded-[10px] bg-white text-[#8F8F8F] focus-within:ring-2 focus-within:ring-[#245BF3]/30 focus-within:border-[#245BF3]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search by message ID, user or content"
              aria-label="Search events"
              className="flex-grow min-w-0 bg-transparent border-0 outline-none text-[14px] text-[#0A0A0A] placeholder:text-[#8F8F8F]"
            />
          </label>

          <select value={surface} onChange={e => setSurface(e.target.value)} className={B.select} aria-label="Surface">
            <option value="">All surfaces</option>
            <option value="chat">Chat</option>
            <option value="code">Code</option>
            <option value="cowork">Cowork</option>
          </select>

          <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} className={B.select} aria-label="Source">
            <option value="">All sources</option>
            <option value="otel">OpenTelemetry</option>
            <option value="compliance">Compliance API</option>
            <option value="cowork">Cowork</option>
            <option value="code">Code Sessions</option>
            <option value="chat">Chat</option>
          </select>

          <select value={userFilter} onChange={e => setUserFilter(e.target.value)} className={`${B.select} max-w-[220px]`} aria-label="User">
            <option value="">All users</option>
            {sortedUsers.map(u => (
              <option key={u.id} value={u.id}>{u.display_name || u.email}</option>
            ))}
          </select>

          <select value={departmentFilter} onChange={e => setDepartmentFilter(e.target.value)} className={B.select} aria-label="Department">
            <option value="">All departments</option>
            {departments.map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>

          <label className="flex items-center gap-1.5 text-[13px] text-[#4D4D4D]">
            <input
              type="checkbox"
              checked={flaggedOnly}
              onChange={e => setFlaggedOnly(e.target.checked)}
              className="rounded-[6px] border-[#DADADA] accent-[#245BF3]"
            />
            Flagged only
          </label>

          <input
            type="date"
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            className={`${B.input} !text-[13px] !py-1`}
            aria-label="From date"
          />
          <input
            type="date"
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            className={`${B.input} !text-[13px] !py-1`}
            aria-label="To date"
          />
          <button type="button" onClick={() => fetchEvents(true)} className={B.primary}>
            Refresh
          </button>
        </div>

        {loading ? (
          <LoadingSpinner />
        ) : events.length === 0 ? (
          // A search or filter that matches nothing is not an empty log.
          filtersActive ? (
            <Empty title="No events match your filters">
              Try a different search, or clear the filters.
            </Empty>
          ) : (
            <Empty
              title="No events found"
              action={<Link href="/settings" className="text-[13px] font-medium text-[#245BF3] hover:underline">Go to Settings</Link>}
            >
              No events ingested yet. Check your API key configuration in Settings.
            </Empty>
          )
        ) : (
          <>
            <span className="text-[13px] text-[#8F8F8F] tabular-nums -mb-2">
              {events.length} event{events.length !== 1 ? 's' : ''} shown{hasMore ? ', more available' : ''}
            </span>
            <Panel flush>
              <div className="overflow-x-auto">
                <table className={T.table}>
                  <thead>
                    <tr className={T.headRow}>
                      <th scope="col" className={T.th}>Time</th>
                      <th scope="col" className={T.th}>User</th>
                      <th scope="col" className={`${T.th} hidden md:table-cell`}>Department</th>
                      <th scope="col" className={T.th}>Surface</th>
                      <th scope="col" className={`${T.th} hidden md:table-cell`}>Source</th>
                      <th scope="col" className={T.th}>Event</th>
                      <th scope="col" className={`${T.th} hidden lg:table-cell`}>Preview</th>
                      <th scope="col" className={T.thRight}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map(event => {
                      const selected = selectedEvent?.id === event.id;
                      return (
                        <tr
                          key={event.id}
                          onClick={() => handleEventClick(event)}
                          className={`${T.row} cursor-pointer ${selected ? '!bg-[#F5F8FF]' : ''}`}
                        >
                          <td className={`${T.tdMute} whitespace-nowrap tabular-nums`}>
                            {new Date(event.occurred_at * 1000).toLocaleString('en-GB')}
                          </td>
                          <td className={`${T.td} whitespace-nowrap`}>
                            <button
                              type="button"
                              onClick={e => { e.stopPropagation(); handleEventClick(event); }}
                              className="font-medium text-[#0A0A0A] hover:underline text-left"
                            >
                              {cleanUserName(event.user_id)}
                            </button>
                          </td>
                          <td className={`${T.tdMute} hidden md:table-cell`}>{event.department ?? '—'}</td>
                          <td className={`${T.td} whitespace-nowrap`}>
                            <Tag>{event.surface}</Tag>
                            {event.surface === 'cowork_partial' && (
                              <span className="ml-1 text-[13px] text-[#8F8F8F]">Metadata only</span>
                            )}
                          </td>
                          <td className={`${T.td} hidden md:table-cell text-[13px] text-[#245BF3] whitespace-nowrap`}>
                            <SourceCell event={event} />
                          </td>
                          <td className={`${T.td} whitespace-nowrap`}>{formatEventType(event.event_type)}</td>
                          <td className={`${T.tdMute} hidden lg:table-cell max-w-[280px] truncate`}>
                            {event.content_preview === RETENTION_MARKER ? (
                              <span className="text-[#8F8F8F]">Content removed under the retention policy</span>
                            ) : (
                              event.content_preview || '—'
                            )}
                          </td>
                          <td className={`${T.tdRight} whitespace-nowrap`}>
                            <StatusCell event={event} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {hasMore && (
                <PanelFoot>
                  <div className="flex justify-center">
                    <button
                      type="button"
                      onClick={() => {
                        const next = offset + PAGE_SIZE;
                        setOffset(next);
                        fetchEvents(false);
                      }}
                      disabled={loading}
                      className={B.secondary}
                    >
                      {loading ? 'Loading...' : 'Load more'}
                    </button>
                  </div>
                </PanelFoot>
              )}
            </Panel>
          </>
        )}
      </PageBody>

      {/* Slide-over detail pane */}
      {selectedEvent && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <div className="fixed inset-0 bg-[#0A0A0A]/[0.18]" onClick={() => setSelectedEvent(null)} aria-hidden="true" />
          <aside
            aria-label="Event detail"
            className={`relative ${(isCoworkEvent || isCodeEvent || isChatEvent) && hasSessionId ? 'w-full sm:max-w-[600px]' : 'w-full sm:max-w-lg'} bg-white border-l border-[#EAEAEA] flex flex-col h-full`}
          >
            <div className="h-12 shrink-0 flex items-center gap-2.5 px-5 border-b border-[#EAEAEA]">
              <h2 className="m-0 text-[14px] font-semibold text-[#0A0A0A] truncate">
                {isChatEvent ? (hasSessionId ? 'Chat conversation' : 'Chat prompt') : isCodeEvent ? (hasSessionId ? 'Code session' : 'Code event') : isSkillEvent ? 'Skill invocation' : isMcpEvent ? 'Connector usage' : isCoworkEvent ? 'Cowork session' : 'Event detail'}
              </h2>
              {selectedEvent.flagged ? <Tag tone="bad">Flagged</Tag> : null}
              <button
                type="button"
                onClick={() => setSelectedEvent(null)}
                aria-label="Close"
                className="ml-auto w-8 h-8 rounded-[10px] inline-flex items-center justify-center text-[#666666] hover:bg-[#F2F2F2] hover:text-[#0A0A0A]"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="px-5 py-4 flex flex-col gap-3.5 overflow-y-auto">
              {/* Event metadata */}
              <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] sm:grid-cols-[96px_minmax(0,1fr)_80px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
                <dt className="text-[#8F8F8F]">User</dt>
                <dd className="m-0 font-medium text-[#0A0A0A] break-all">{selectedEvent.user_id}</dd>
                <dt className="text-[#8F8F8F]">Surface</dt>
                <dd className="m-0"><Tag>{selectedEvent.surface}</Tag></dd>
                <dt className="text-[#8F8F8F]">Time</dt>
                <dd className="m-0 tabular-nums">{new Date(selectedEvent.occurred_at * 1000).toLocaleString('en-GB')}</dd>
                <dt className="text-[#8F8F8F]">Event</dt>
                <dd className="m-0 break-all">{selectedEvent.event_type}</dd>
                <dt className="text-[#8F8F8F]">Event ID</dt>
                <dd className="m-0 font-mono text-[12px] text-[#4D4D4D]">{selectedEvent.id.slice(0, 12)}...</dd>
              </dl>

              {selectedEvent.flagged ? (
                <Notice tone="error">
                  <div className="flex flex-col gap-1">
                    <span className="text-[13px] font-semibold">Flag reason</span>
                    <span>{selectedEvent.flag_reason || 'Flagged by system'}</span>
                    {selectedEvent.pii_verdict_reason ? (
                      <span className="text-[13px] text-[#8F4A40]">Why: {selectedEvent.pii_verdict_reason}</span>
                    ) : null}
                  </div>
                </Notice>
              ) : null}

              {/* OTel session enrichment — cost, tokens, tools, uploads */}
              {(() => {
                if (!selectedEvent.session_enrichment) return null;
                let en: SessionEnrichment;
                try { en = JSON.parse(selectedEvent.session_enrichment); } catch { return null; }
                const files: string[] = (() => { try { return en.files_uploaded ? JSON.parse(en.files_uploaded) : []; } catch { return []; } })();
                const tools: string[] = (() => { try { return en.unique_tools ? JSON.parse(en.unique_tools) : []; } catch { return []; } })();
                const models: string[] = (() => { try { return en.models_used ? JSON.parse(en.models_used) : []; } catch { return []; } })();
                const totalTokens = (en.input_tokens || 0) + (en.output_tokens || 0);
                const facts: ReactNode[] = [];
                const liveCost = sessionSpend?.conversation.totalUsd ?? null;
                const cost = liveCost ?? en.cost_usd;
                if (cost != null) facts.push(<span key="cost" className="font-semibold text-[#0A0A0A]">Cost: ${cost.toFixed(4)}</span>);
                if (totalTokens > 0) facts.push(<span key="tok">{(totalTokens / 1000).toFixed(1)}k tokens</span>);
                if (en.tool_call_count != null && en.tool_call_count > 0) facts.push(<span key="tools">{en.tool_call_count} tool call{en.tool_call_count !== 1 ? 's' : ''}</span>);
                if (en.duration_secs != null && en.duration_secs > 0) facts.push(<span key="dur">{en.duration_secs}s duration</span>);
                if (en.total_commits != null && en.total_commits > 0) facts.push(<span key="commits" className="text-[#1A7F37] font-medium">{en.total_commits} commit{en.total_commits !== 1 ? 's' : ''}</span>);
                if (en.total_errors != null && en.total_errors > 0) facts.push(<span key="err" className="text-[#B42318]">{en.total_errors} error{en.total_errors !== 1 ? 's' : ''}</span>);
                return (
                  <div className="border border-[#EAEAEA] rounded-[10px] px-3 py-2.5 flex flex-col gap-1.5 text-[13px]">
                    <span className="font-semibold text-[#245BF3]">
                      {isCodeEvent ? 'Session stats' : 'Session stats (OTel)'}
                    </span>
                    {facts.length > 0 && (
                      <span className="flex flex-wrap gap-x-1.5 text-[#333333] tabular-nums">
                        {facts.map((f, i) => <span key={i}>{i > 0 && <span className="text-[#B3B3B3]">· </span>}{f}</span>)}
                      </span>
                    )}
                    {models.length > 0 && (
                      <span className="text-[#666666]">
                        Model{models.length > 1 ? 's' : ''}: {models.join(', ')}
                      </span>
                    )}
                    {en.git_branch && (
                      <span className="text-[#666666]">
                        Branch: <Mono>{en.git_branch}</Mono>
                      </span>
                    )}
                    {en.cwd && (
                      <span className="font-mono text-[12px] text-[#666666] truncate" title={en.cwd}>{en.cwd}</span>
                    )}
                    {tools.length > 0 && (
                      <span className="text-[#666666]">Tools: {tools.join(', ')}</span>
                    )}
                    {files.length > 0 && (
                      <span className="text-[#666666] flex flex-wrap items-center gap-1">
                        Files uploaded:
                        {files.map(f => <Mono key={f}>{f}</Mono>)}
                      </span>
                    )}
                    {sessionSpend && (sessionSpend.prompt || hasBreakdown(sessionSpend.conversation) || sessionSpend.conversation.byModel.length > 1) && (
                      <span className="flex flex-col gap-1.5 pt-1.5 mt-0.5 border-t border-[#F2F2F2]">
                        <span className="font-semibold text-[#0A0A0A]">Where the money went</span>
                        {sessionSpend.prompt && (
                          <span className="flex flex-col gap-0.5">
                            <span className="text-[#333333] tabular-nums">
                              This prompt: {sessionSpend.prompt.totalUsd === null ? 'not priced' : spendMoney(sessionSpend.prompt.totalUsd)}
                              <span className="text-[#8F8F8F]"> ({sessionSpend.prompt.calls} model call{sessionSpend.prompt.calls === 1 ? '' : 's'})</span>
                            </span>
                            <SplitLine s={sessionSpend.prompt} />
                          </span>
                        )}
                        <span className="text-[#333333]">This conversation</span>
                        <WhereMoneyWent s={sessionSpend.conversation} showModels />
                        {sessionSpend.conversation.unpricedModels.length > 0 && (
                          <span className="text-[13px] text-[#B54708]">Not priced, so left out: {sessionSpend.conversation.unpricedModels.join(', ')}</span>
                        )}
                      </span>
                    )}
                  </div>
                );
              })()}

              {/* Chat prompt detail — fallback single-event view when there's no
                  conversation_id to thread (legacy rows without session_id) */}
              {isChatEvent && !hasSessionId ? (
                <div className="flex flex-col gap-3">
                  <SectionHead title="Chat prompt" />
                  <Bubble
                    kind="user"
                    header={<>User · <span className="tabular-nums">{timeOf(selectedEvent.occurred_at)}</span>{selectedEvent.flagged ? <FlaggedMark /> : null}</>}
                  >
                    <div className="text-[14px] leading-[1.5] text-[#0A0A0A] whitespace-pre-wrap break-words">
                      {selectedEvent.content_preview || 'No content captured'}
                    </div>
                  </Bubble>

                  {selectedEvent.flagged && selectedEvent.flag_reason ? (
                    <Notice tone="error">
                      <div className="flex flex-col gap-1">
                        <span className="text-[13px] font-semibold">Flag detail</span>
                        <span>{selectedEvent.flag_reason}</span>
                      </div>
                    </Notice>
                  ) : null}

                  {selectedEvent.metadata && (() => {
                    try {
                      const meta = JSON.parse(selectedEvent.metadata!);
                      return (
                        <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
                          {meta.conversation_id && (
                            <>
                              <dt className="text-[#8F8F8F]">Conversation</dt>
                              <dd className="m-0 font-mono text-[12px] text-[#4D4D4D]">{meta.conversation_id.slice(0, 12)}...</dd>
                            </>
                          )}
                          {meta.prompt_length && (
                            <>
                              <dt className="text-[#8F8F8F]">Prompt length</dt>
                              <dd className="m-0 tabular-nums">{meta.prompt_length} chars</dd>
                            </>
                          )}
                        </dl>
                      );
                    } catch { return null; }
                  })()}

                  <NoteBox>
                    <span className="font-semibold text-[#333333]">Source:</span> Claude Desktop. Only user prompts are available. Responses are not stored.
                  </NoteBox>
                </div>
              ) : null}

              {/* Code event detail — single-event panel only when there's no session to thread */}
              {isCodeEvent && !hasSessionId ? (
                <div className="flex flex-col gap-3">
                  <SectionHead title={selectedEvent.event_type === 'code_user_message' ? 'Code prompt' : 'Code event'} />
                  <Bubble
                    kind={selectedEvent.event_type === 'code_user_message' ? 'user' : 'tool'}
                    header={<>{selectedEvent.event_type === 'code_user_message' ? 'User prompt' : selectedEvent.event_type} · <span className="tabular-nums">{timeOf(selectedEvent.occurred_at)}</span>{selectedEvent.flagged ? <FlaggedMark /> : null}</>}
                  >
                    <div className="text-[14px] leading-[1.5] text-[#0A0A0A] whitespace-pre-wrap break-words">
                      {selectedEvent.content_preview || 'No content captured'}
                    </div>
                  </Bubble>

                  {selectedEvent.metadata && (() => {
                    try {
                      const meta = JSON.parse(selectedEvent.metadata!);
                      return (
                        <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
                          {meta.session_id && (
                            <>
                              <dt className="text-[#8F8F8F]">Session</dt>
                              <dd className="m-0 font-mono text-[12px] text-[#4D4D4D]">{meta.session_id.slice(0, 12)}...</dd>
                            </>
                          )}
                          {meta.role && (
                            <>
                              <dt className="text-[#8F8F8F]">Role</dt>
                              <dd className="m-0">{meta.role}</dd>
                            </>
                          )}
                        </dl>
                      );
                    } catch { return null; }
                  })()}

                  <NoteBox>
                    <span className="font-semibold text-[#333333]">Source:</span> Claude Code session file (~/.claude/projects). User prompts and tool summaries are captured. Full assistant responses are not stored.
                  </NoteBox>
                </div>
              ) : null}

              {/* Skill invocation detail */}
              {isSkillEvent && (() => {
                let meta: { skill_name?: string; invocation_type?: string; session_id?: string } = {};
                try { meta = selectedEvent.metadata ? JSON.parse(selectedEvent.metadata) : {}; } catch { /* ignore */ }
                return (
                  <div className="border border-[#EAEAEA] rounded-[10px] px-3 py-2.5 flex flex-col gap-1.5">
                    <span className="text-[13px] font-semibold text-[#0A0A0A]">Skill invoked</span>
                    <span className="font-mono text-[14px] text-[#0A0A0A] break-all">{meta.skill_name || selectedEvent.content_preview || '—'}</span>
                    {meta.invocation_type && (
                      <span>
                        <Tag tone={meta.invocation_type === 'agent_chained' ? 'neutral' : 'measured'}>
                          {meta.invocation_type === 'agent_chained' ? 'Agent chained' : 'User typed'}
                        </Tag>
                      </span>
                    )}
                  </div>
                );
              })()}

              {/* MCP connector detail */}
              {isMcpEvent && (() => {
                let meta: { mcp_server?: string; mcp_tool?: string; success?: boolean; session_id?: string } = {};
                try { meta = selectedEvent.metadata ? JSON.parse(selectedEvent.metadata) : {}; } catch { /* ignore */ }
                return (
                  <div className="border border-[#EAEAEA] rounded-[10px] px-3 py-2.5 flex flex-col gap-1.5">
                    <span className="text-[13px] font-semibold text-[#0A0A0A]">Connector used</span>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[14px] text-[#0A0A0A]">{meta.mcp_server || '—'}</span>
                      {meta.mcp_tool && (
                        <>
                          <span className="text-[#B3B3B3]" aria-hidden="true">→</span>
                          <span className="font-mono text-[14px] text-[#333333]">{meta.mcp_tool}</span>
                        </>
                      )}
                      {meta.success !== undefined && (
                        <Tag tone={meta.success ? 'neutral' : 'bad'}>
                          {meta.success ? 'Success' : 'Failed'}
                        </Tag>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Cowork / Code conversation thread */}
              {(isCoworkEvent || isCodeEvent) && hasSessionId ? (
                <div className="flex flex-col gap-2.5">
                  <SectionHead
                    title="Conversation"
                    count={`${coworkMessages.length} message${coworkMessages.length !== 1 ? 's' : ''}`}
                  />
                  {coworkLoading ? (
                    <LoadingSpinner />
                  ) : (
                    <CoworkThread messages={[...coworkMessages].reverse()} />
                  )}
                </div>
              ) : isChatEvent && hasSessionId ? (
                <div className="flex flex-col gap-2.5">
                  <SectionHead
                    title="Conversation"
                    count={`${chatThreadMessages.length} message${chatThreadMessages.length !== 1 ? 's' : ''}`}
                  />
                  {chatThreadLoading ? (
                    <LoadingSpinner />
                  ) : (
                    <>
                      <ChatThread messages={chatThreadMessages} />
                      <NoteBox>
                        <span className="font-semibold text-[#333333]">Source:</span> {selectedEvent._source === 'local-agent' ? 'Claude Desktop (Local Agent)' : 'Compliance API'}. Only user prompts are stored as text. Assistant turns show model + artifact/file counts only.
                      </NoteBox>
                    </>
                  )}
                </div>
              ) : isCoworkEvent ? (
                <NoteBox>
                  This Cowork event does not have an associated session ID. Conversation content is unavailable.
                </NoteBox>
              ) : !isCodeEvent && !isChatEvent ? (
                /* Standard event detail for compliance/OTel events */
                <div className="flex flex-col gap-3">
                  {selectedEvent.content_preview && (
                    <div className="flex flex-col gap-1">
                      <SectionHead title="Content preview" />
                      <div className="border border-[#EAEAEA] bg-[#FAFAFA] rounded-[10px] p-3 text-[14px] text-[#333333] whitespace-pre-wrap break-words">
                        {selectedEvent.content_preview}
                      </div>
                    </div>
                  )}
                  {selectedEvent.metadata && (
                    <div className="flex flex-col gap-1">
                      <SectionHead title="Metadata" />
                      <pre className="m-0 border border-[#EAEAEA] bg-[#FAFAFA] rounded-[10px] p-3 text-[13px] text-[#4D4D4D] font-mono whitespace-pre-wrap break-all">
                        {(() => { try { return JSON.stringify(JSON.parse(selectedEvent.metadata!), null, 2); } catch { return selectedEvent.metadata; } })()}
                      </pre>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
