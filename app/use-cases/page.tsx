// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { type SuggestionProducts } from '@/lib/usecases/suggestion-format';
import ProcessCanvasCard from '@/components/usecases/ProcessCanvasCard';
import type { ProcessCanvas } from '@/lib/usecases/suggestion-store';
import { surfaceLabels, surfaceOf } from '@/lib/usecases/dept-boxes';
import { useConnectedProducts } from '@/components/shared/VendorSwitch';
import { PageBody, Toolbar, Panel, PanelFoot, T, Tag, Pill, B, Notice, Empty, Bar, cx } from '@/components/precision/ui';

interface UseCase {
  id: string;
  title: string;
  description: string | null;
  ownerUserId: string | null;
  departments: string[];
  surfaces: string[];
  origin: 'planned' | 'emergent' | 'ideated';
  status: 'candidate' | 'confirmed' | 'archived';
  /** Null for an archived use case: it is no longer tracked. */
  lifecycle: 'not_seen' | 'piloting' | 'adopted' | 'at_risk' | null;
  lastActivatedAt: number | null;
  strategic: number;
  /** Sessions per vendor, last 13 completed weeks; openai null when ChatGPT and Codex are hidden. */
  platformSessions?: { claude: number; openai: number | null };
  /** The same sessions per product, which the register column shows. */
  productSessions?: ProductSessions;
  /** Sessions this week, by the same rules: not yet in the 13 weeks, but the lifecycle counts them. */
  sessionsThisWeek?: number;
  /** ChatGPT and Codex are hidden and this use case had work there, which the stage counts. */
  hiddenActivity?: boolean;
}

interface ProductSessions { cowork: number; code: number; chatgpt: number | null; codex: number | null }

interface SuggestionDraft {
  id: string;
  title: string;
  description: string | null;
  matchingRule: { skills: string[]; connectors: string[]; taskTypes: string[]; departments: string[] };
  evidence: { distinctUsers: number; sessionCount: number; departments: string[] };
  department: string | null;
  canvas: ProcessCanvas | null;
  /** When it was drafted (epoch seconds). */
  generatedAt: number;
  surface?: 'cowork' | 'code' | null;
  /** Sessions by product; null while ChatGPT and Codex are hidden or on older rows. */
  products?: SuggestionProducts | null;
}

const STATUS_ORDER: UseCase['status'][] = ['confirmed', 'candidate', 'archived'];

/** The suggestions list's filter: every suggestion, the cross-department ones, or one department. */
const ALL = '__all';
const ACROSS = '__across';
/** Rows the suggestions list shows before Show all. */
const SUGGESTIONS_SHOWN = 5;

/** The measured people and sessions behind a suggestion: its canvas when it has one, else its evidence. */
function suggestionPeople(s: SuggestionDraft): number { return s.canvas?.people ?? s.evidence.distinctUsers; }
function suggestionSessions(s: SuggestionDraft): number { return s.canvas?.sessions ?? s.evidence.sessionCount; }

const STATUS_LABEL: Record<UseCase['status'], string> = {
  confirmed: 'Confirmed',
  candidate: 'Candidate',
  archived: 'Archived',
};

type LifecycleTone = 'good' | 'info' | 'warn' | 'neutral';

const LIFECYCLE_PILL: Record<string, { label: string; tone: LifecycleTone }> = {
  adopted: { label: 'Adopted', tone: 'good' },
  piloting: { label: 'Piloting', tone: 'info' },
  at_risk: { label: 'At risk', tone: 'warn' },
  not_seen: { label: 'Not seen', tone: 'neutral' },
};

/** Same colours as the kit's Pill, for the lifecycle filter toggles. */
const LIFECYCLE_CHIP_ON: Record<LifecycleTone, string> = {
  good: 'bg-[#E7F6EC] text-[#146C2E] border-[#E7F6EC]',
  info: 'bg-[#E4EFF3] text-[#185A71] border-[#E4EFF3]',
  warn: 'bg-[#FFF1E0] text-[#8A5300] border-[#FFF1E0]',
  neutral: 'bg-[#F2F2F2] text-[#4D4D4D] border-[#F2F2F2]',
};
const LIFECYCLE_DOT: Record<LifecycleTone, string> = {
  good: '#1A7F37', info: '#1F6F8B', warn: '#DC8A00', neutral: '#A3A3A3',
};

const LIFECYCLE_FACETS: Array<NonNullable<UseCase['lifecycle']>> = ['adopted', 'piloting', 'at_risk', 'not_seen'];

/**
 * "Claude Cowork 40", "Claude Code 21", "Codex 13", one per line: a use
 * case's matched sessions in the last 13 weeks, by product, listing only products with
 * sessions. ChatGPT and Codex count only once OpenAI is connected and shown;
 * a use case with no sessions reads 0. One with none in the 13 weeks but some
 * this week, which the lifecycle counts, says so, so "Piloting" never sits
 * beside a bare 0.
 */
function PlatformCell({ p, showOpenAi, thisWeek, hidden }: { p?: ProductSessions; showOpenAi: boolean; thisWeek?: number; hidden?: boolean }) {
  if (!p) return <span className="text-[#8F8F8F]">not measured</span>;
  const all: Array<[string, number | null]> = [
    ['Claude Cowork', p.cowork],
    ['Claude Code', p.code],
    ['ChatGPT', showOpenAi ? p.chatgpt : null],
    ['Codex', showOpenAi ? p.codex : null],
  ];
  const parts = all.filter((x): x is [string, number] => x[1] !== null && x[1] > 0).map(([label, n]) => `${label} ${n}`);
  if (parts.length === 0) {
    if (thisWeek && thisWeek > 0) return <span className="whitespace-nowrap text-[#333333]">0 · {thisWeek} this week</span>;
    if (hidden) return <span className="whitespace-nowrap text-[#333333]">0 · used in hidden products</span>;
    return <span className="text-[#8F8F8F]">0</span>;
  }
  // One product per line, so the column stays narrow however many products did the work.
  return <span className="flex flex-col text-[#333333]">{parts.map(t => <span key={t} className="whitespace-nowrap">{t}</span>)}</span>;
}

export default function UseCasesRegisterPage() {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [useCases, setUseCases] = useState<UseCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);

  const [showArchived, setShowArchived] = useState(false);
  const [lifecycleFilter, setLifecycleFilter] = useState<Set<string>>(new Set());
  const [mineOnly, setMineOnly] = useState(false);
  const [linkedUserId, setLinkedUserId] = useState<string | null>(null);

  const [suggestions, setSuggestions] = useState<SuggestionDraft[] | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [openSuggestionId, setOpenSuggestionId] = useState<string | null>(null);
  const [suggestFilter, setSuggestFilter] = useState<string>(ALL);
  const [showAllSuggestions, setShowAllSuggestions] = useState(false);

  // Admin gate — mirrors app/pulse/users/page.tsx
  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(data => {
        if (!data.authenticated) { router.replace('/'); return; }
        const role = data.user?.role ?? '';
        if (role !== 'admin' && role !== 'manager') { router.replace('/'); return; }
        setChecked(true);
      })
      .catch(() => router.replace('/'));
  }, [router]);

  const loadList = () => {
    fetch('/api/use-cases')
      .then(r => {
        if (r.status === 404) { setNotEnabled(true); throw new Error('not enabled'); }
        if (!r.ok) throw new Error("Couldn't load this page. Try again.");
        setLinkedUserId(r.headers.get('X-Linked-User-Id'));
        return r.json();
      })
      .then(setUseCases)
      .catch(e => { if (e.message !== 'not enabled') setError(e.message); });
  };

  const loadSuggestions = () => {
    fetch('/api/use-cases/suggestions')
      .then(r => {
        if (!r.ok) throw new Error("Couldn't load this page. Try again.");
        return r.json();
      })
      .then((data: SuggestionDraft[]) => setSuggestions(data))
      .catch(() => setSuggestions([]));
  };

  useEffect(() => {
    if (!checked) return;
    loadList();
    loadSuggestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked]);

  const toggleLifecycle = (lc: string) => {
    setLifecycleFilter(prev => {
      const next = new Set(prev);
      if (next.has(lc)) next.delete(lc); else next.add(lc);
      return next;
    });
  };

  const patchSuggestion = async (
    id: string,
    action: 'add' | 'dismiss',
  ): Promise<boolean> => {
    setActingId(id);
    try {
      const res = await fetch(`/api/use-cases/suggestions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `Failed to ${action}`);
      loadList();
      loadSuggestions();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} suggestion`);
      return false;
    } finally {
      setActingId(null);
    }
  };

  const handleAddSuggestion = (s: SuggestionDraft) => patchSuggestion(s.id, 'add');
  const handleDismissSuggestion = (s: SuggestionDraft) => patchSuggestion(s.id, 'dismiss');

  // After confirming or dismissing one suggestion, move to the next in the list as shown rather
  // than closing, so the reader can walk every suggestion in the filter.
  const nextSiblingId = (id: string): string | null => {
    const idx = rankedSuggestions.findIndex(s => s.id === id);
    if (idx < 0) return null;
    return rankedSuggestions[idx + 1]?.id ?? rankedSuggestions[idx - 1]?.id ?? null;
  };
  const handleConfirmCanvas = async () => {
    if (!openSuggestionId) return;
    const next = nextSiblingId(openSuggestionId);
    if (await patchSuggestion(openSuggestionId, 'add')) setOpenSuggestionId(next);
  };
  const handleDismissCanvas = async () => {
    if (!openSuggestionId) return;
    const next = nextSiblingId(openSuggestionId);
    if (await patchSuggestion(openSuggestionId, 'dismiss')) setOpenSuggestionId(next);
  };

  const handleRefreshSuggestions = async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/use-cases/suggestions/refresh', { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Failed to refresh suggestions');
      loadSuggestions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh suggestions');
    } finally {
      setRefreshing(false);
    }
  };

  const visibleSuggestions = suggestions ?? [];
  const connected = useConnectedProducts();

  const labels = surfaceLabels(connected);

  // One list, ranked by the people behind each suggestion, then its sessions; ties keep the
  // store's order (newest first). The chips filter it to the cross-department ones or one department.
  const { rankedSuggestions, chips } = useMemo(() => {
    const ranked = visibleSuggestions
      .map((s, i) => ({ s, i }))
      .sort((a, b) =>
        suggestionPeople(b.s) - suggestionPeople(a.s)
        || suggestionSessions(b.s) - suggestionSessions(a.s)
        || a.i - b.i)
      .map(x => x.s);
    const byDept = new Map<string, number>();
    for (const s of visibleSuggestions) if (s.department) byDept.set(s.department, (byDept.get(s.department) ?? 0) + 1);
    const across = visibleSuggestions.filter(s => !s.department).length;
    const chipList: Array<{ key: string; label: string; count: number }> = [
      { key: ALL, label: 'All', count: visibleSuggestions.length },
      ...(across > 0 ? [{ key: ACROSS, label: 'Across departments', count: across }] : []),
      ...[...byDept.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, n]) => ({ key: d, label: d, count: n })),
    ];
    const filteredList = suggestFilter === ALL ? ranked
      : suggestFilter === ACROSS ? ranked.filter(s => !s.department)
        : ranked.filter(s => s.department === suggestFilter);
    return { rankedSuggestions: filteredList, chips: chipList };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestions, suggestFilter]);

  const shownSuggestions = showAllSuggestions ? rankedSuggestions : rankedSuggestions.slice(0, SUGGESTIONS_SHOWN);
  const topPeople = Math.max(1, ...rankedSuggestions.map(suggestionPeople));

  /** Where a suggestion was found: its department (or the departments it spans) and the products. */
  const whereLine = (s: SuggestionDraft): string => {
    const where = s.department
      ?? ['Across departments', ...(s.evidence.departments.length > 0 ? [s.evidence.departments.join(', ')] : [])].join(' · ');
    // Product names only: the sessions are counted once, beside the bar.
    const names = s.products
      ? ([['Claude Cowork', s.products.cowork], ['Claude Code', s.products.code], ['ChatGPT', s.products.chatgpt], ['Codex', s.products.codex]] as const)
          .filter(([, n]) => n > 0).map(([name]) => name)
      : [];
    const products = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '';
    return `${where} · ${products || labels[surfaceOf(s)]}`;
  };

  const openSuggestion = suggestions?.find(s => s.id === openSuggestionId) ?? null;

  const filtered = useMemo(() => {
    let rows = useCases ?? [];
    if (!showArchived) rows = rows.filter(uc => uc.status !== 'archived');
    if (lifecycleFilter.size > 0) rows = rows.filter(uc => uc.lifecycle !== null && lifecycleFilter.has(uc.lifecycle));
    if (mineOnly) rows = rows.filter(uc => linkedUserId != null && uc.ownerUserId === linkedUserId);
    return rows;
  }, [useCases, showArchived, lifecycleFilter, mineOnly, linkedUserId]);

  if (!checked) {
    return (
      <>
        <TopBar title="Use Cases" subtitle="Overview of AI use cases across the org" />
        <LoadingSpinner />
      </>
    );
  }

  if (notEnabled) {
    return (
      <>
        <TopBar title="Use Cases" subtitle="Overview of AI use cases across the org" />
        <PageBody>
          <Empty title="Use Cases is not enabled on this instance">
            An admin can enable it under Admin → Use Cases.
          </Empty>
        </PageBody>
      </>
    );
  }

  const grouped = STATUS_ORDER
    .map(status => ({ status, items: filtered.filter(uc => uc.status === status) }))
    .filter(g => showArchived || g.status !== 'archived')
    .filter(g => g.items.length > 0);

  return (
    <>
      <TopBar title="Use Cases" subtitle="Overview of AI use cases across the org" />
      <PageBody>
        <Toolbar left={useCases ? <span className="tabular-nums">{filtered.length} use case{filtered.length === 1 ? '' : 's'}</span> : undefined}>
          <Link href="/use-cases/import" className={B.secondary}>Import transcript</Link>
          <Link href="/use-cases/ideate" className={B.secondary}>Ideate</Link>
          <Link href="/use-cases/new" className={B.primary}>Add use case</Link>
        </Toolbar>

        {error && <Notice tone="error">{error}</Notice>}

        {visibleSuggestions.length > 0 && (
          <Panel
            title="Suggested use cases"
            badge={<Tag tone="judged">AI-suggested</Tag>}
            subtitle="Drawn from your organisation's own activity"
            right={
              <button type="button" onClick={handleRefreshSuggestions} disabled={refreshing} className={B.link}>
                {refreshing ? 'Refreshing…' : 'Refresh suggestions'}
              </button>
            }
            flush
          >
            <div className="px-4 pt-3 pb-1 flex flex-wrap gap-1.5">
              {chips.map(c => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => { setSuggestFilter(c.key); setShowAllSuggestions(false); }}
                  aria-pressed={suggestFilter === c.key}
                  className={cx(
                    'text-[12px] font-medium px-2 py-0.5 rounded-full border tabular-nums',
                    suggestFilter === c.key
                      ? 'bg-[#E4EFF3] text-[#185A71] border-[#E4EFF3]'
                      : 'bg-white text-[#4D4D4D] border-[#EAEAEA] hover:border-[#DADADA]',
                  )}
                >
                  {/* "All" is the total of the filters after it, so it carries no count of its own. */}
                  {c.key === ALL ? c.label : `${c.label} ${c.count}`}
                </button>
              ))}
            </div>
            <ul className="m-0 p-0 list-none">
              {shownSuggestions.map(s => {
                const people = suggestionPeople(s);
                const sessions = suggestionSessions(s);
                return (
                  <li key={s.id} className="px-4 py-2.5 border-t border-[#F2F2F2] first:border-t-0 flex flex-col gap-1.5">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-semibold text-[#0A0A0A] leading-5">{s.title}</div>
                        <div className="text-[13px] text-[#8F8F8F]">{whereLine(s)}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button type="button" onClick={() => setOpenSuggestionId(s.id)} className={B.secondary}>Review</button>
                        <button
                          type="button"
                          onClick={() => handleAddSuggestion(s)}
                          disabled={actingId === s.id}
                          className={B.secondary}
                        >
                          {actingId === s.id ? 'Working…' : 'Add'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDismissSuggestion(s)}
                          disabled={actingId === s.id}
                          className="w-7 h-7 shrink-0 rounded-[10px] text-[16px] leading-none text-[#8F8F8F] hover:bg-[#EAEAEA] hover:text-[#0A0A0A] disabled:opacity-50"
                          aria-label="Dismiss suggestion"
                        >
                          &times;
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex-1"><Bar pct={(people / topPeople) * 100} /></div>
                      <span className="text-[13px] text-[#8F8F8F] tabular-nums whitespace-nowrap">
                        {people} {people === 1 ? 'person' : 'people'} · {sessions} {sessions === 1 ? 'session' : 'sessions'}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
            {rankedSuggestions.length > SUGGESTIONS_SHOWN && (
              <div className="px-4 py-2.5 border-t border-[#F2F2F2] text-[13px] text-[#8F8F8F] tabular-nums">
                Showing {shownSuggestions.length} of {rankedSuggestions.length} ·{' '}
                <button type="button" onClick={() => setShowAllSuggestions(v => !v)} className={B.link}>
                  {showAllSuggestions ? 'Show fewer' : 'Show all'}
                </button>
              </div>
            )}
            <PanelFoot>
              Claude&apos;s read of your telemetry: review before adding. Counts are measured; the grouping and wording are Claude&apos;s.
            </PanelFoot>
          </Panel>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] text-[#666666] mr-1">Lifecycle</span>
          {LIFECYCLE_FACETS.map(lc => {
            const pill = LIFECYCLE_PILL[lc];
            const active = lifecycleFilter.has(lc);
            return (
              <button
                key={lc}
                type="button"
                aria-pressed={active}
                onClick={() => toggleLifecycle(lc)}
                className={cx('inline-flex items-center gap-1.5 text-[13px] px-2.5 py-0.5 rounded-full border',
                  active ? cx(LIFECYCLE_CHIP_ON[pill.tone], 'font-medium') : 'bg-white border-[#EAEAEA] text-[#4D4D4D] hover:border-[#DADADA]')}
              >
                {!active && <span className="w-1.5 h-1.5 rounded-full" style={{ background: LIFECYCLE_DOT[pill.tone] }} aria-hidden="true" />}
                {pill.label}
              </button>
            );
          })}

          <label className="ml-3 flex items-center gap-1.5 text-[13px] text-[#333333] cursor-pointer">
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} className="accent-[#0A0A0A]" />
            Show archived
          </label>

          <label className="flex items-center gap-1.5 text-[13px] text-[#333333] cursor-pointer">
            <input type="checkbox" checked={mineOnly} onChange={e => setMineOnly(e.target.checked)} className="accent-[#0A0A0A]" />
            My use cases
          </label>
        </div>

        {!useCases && !error && <LoadingSpinner />}

        {useCases && filtered.length === 0 && (
          <Empty
            title="No use cases match these filters"
            action={useCases.length === 0 ? <Link href="/use-cases/new" className={B.primary}>Add use case</Link> : undefined}
          >
            {useCases.length === 0
              ? "Start the register with a planned use case, or capture one you've noticed emerging in the org."
              : 'Try clearing the lifecycle filter, "My use cases", or "Show archived".'}
          </Empty>
        )}

        {grouped.map(group => (
          <Panel
            key={group.status}
            title={STATUS_LABEL[group.status]}
            subtitle={<span className="tabular-nums">{group.items.length}</span>}
            flush
          >
            <div className="overflow-x-auto">
              <table className={cx(T.table, 'table-fixed min-w-[810px]')}>
                <thead>
                  <tr className={T.headRow}>
                    <th scope="col" className={T.th}>Use case</th>
                    <th scope="col" className={cx(T.th, 'w-[170px]')} title="Matched sessions in the last 13 completed weeks, by vendor">Sessions, 13 weeks</th>
                    <th scope="col" className={cx(T.th, 'w-[120px]')}>Lifecycle</th>
                    <th scope="col" className={cx(T.th, 'w-[240px]')}>Departments</th>
                  </tr>
                </thead>
                <tbody>
                  {group.items.map(uc => {
                    const pill = uc.lifecycle ? LIFECYCLE_PILL[uc.lifecycle] : undefined;
                    const href = `/use-cases/${encodeURIComponent(uc.id)}`;
                    return (
                      <tr
                        key={uc.id}
                        className={cx(T.row, 'cursor-pointer')}
                        onClick={e => { if (!(e.target as HTMLElement).closest('a')) router.push(href); }}
                      >
                        <td className={cx(T.td, 'min-w-[260px]')}>
                          <div className="flex items-center gap-1.5 min-w-0">
                            {uc.strategic === 1 && (
                              <span
                                className="text-[#DC8A00] shrink-0"
                                title="Strategic bet: appears on the Use Case Governance rollup"
                                aria-label="Strategic bet"
                              >
                                ★
                              </span>
                            )}
                            <Link href={href} className="font-semibold text-[#0A0A0A] hover:underline truncate">{uc.title}</Link>
                          </div>
                          {uc.description && (
                            <p className="m-0 mt-0.5 text-[#666666] truncate" title={uc.description}>{uc.description}</p>
                          )}
                        </td>
                        <td className={cx(T.td, 'text-[13px] tabular-nums')}><PlatformCell p={uc.productSessions} showOpenAi={!!connected?.openai} thisWeek={uc.sessionsThisWeek} hidden={uc.hiddenActivity} /></td>
                        <td className={T.td}>
                          {pill ? <Pill tone={pill.tone}>{pill.label}</Pill>
                            : uc.status === 'archived' ? <span className="text-[13px] text-[#8F8F8F]" title="Archived use cases are no longer tracked">Not tracked</span>
                            : <span className="text-[#8F8F8F]">Not set</span>}
                        </td>
                        <td className={cx(T.tdMute, 'text-[13px] truncate')} title={uc.departments.join(', ')}>
                          {uc.departments.length > 0 ? uc.departments.join(', ') : 'none'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        ))}
      </PageBody>

      {openSuggestion && (() => {
        const siblings = rankedSuggestions.some(s => s.id === openSuggestion.id) ? rankedSuggestions : [openSuggestion];
        const idx = siblings.findIndex(s => s.id === openSuggestion.id);
        return (
          <ProcessCanvasCard
            suggestion={openSuggestion}
            busy={actingId === openSuggestion.id}
            onConfirm={handleConfirmCanvas}
            onDismiss={handleDismissCanvas}
            onClose={() => setOpenSuggestionId(null)}
            position={siblings.length > 1 ? { index: idx + 1, total: siblings.length } : undefined}
            onPrev={idx > 0 ? () => setOpenSuggestionId(siblings[idx - 1].id) : undefined}
            onNext={idx < siblings.length - 1 ? () => setOpenSuggestionId(siblings[idx + 1].id) : undefined}
          />
        );
      })()}
    </>
  );
}
