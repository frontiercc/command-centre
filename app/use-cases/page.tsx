// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { formatSuggestionEvidenceLine } from '@/lib/usecases/suggestion-format';
import DeptProcessBoxes from '@/components/usecases/DeptProcessBoxes';
import ProcessCanvasCard from '@/components/usecases/ProcessCanvasCard';
import type { ProcessCanvas } from '@/lib/usecases/suggestion-store';
import { groupDeptBoxes } from '@/lib/usecases/dept-boxes';
import { PageBody, Toolbar, Panel, PanelFoot, SubHead, T, Tag, Pill, B, Notice, Empty, cx } from '@/components/precision/ui';

interface UseCase {
  id: string;
  title: string;
  description: string | null;
  ownerUserId: string | null;
  departments: string[];
  surfaces: string[];
  origin: 'planned' | 'emergent' | 'ideated';
  status: 'candidate' | 'confirmed' | 'archived';
  lifecycle: 'not_seen' | 'piloting' | 'adopted' | 'at_risk';
  lastActivatedAt: number | null;
  strategic: number;
}

interface SuggestionDraft {
  id: string;
  title: string;
  description: string | null;
  matchingRule: { skills: string[]; connectors: string[]; taskTypes: string[]; departments: string[] };
  evidence: { distinctUsers: number; sessionCount: number; departments: string[] };
  department: string | null;
  canvas: ProcessCanvas | null;
  surface?: 'cowork' | 'code' | null;
}

const STATUS_ORDER: UseCase['status'][] = ['confirmed', 'candidate', 'archived'];

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
  info: 'bg-[#EAF0FE] text-[#1A44C7] border-[#EAF0FE]',
  warn: 'bg-[#FFF1E0] text-[#8A5300] border-[#FFF1E0]',
  neutral: 'bg-[#F2F2F2] text-[#4D4D4D] border-[#F2F2F2]',
};
const LIFECYCLE_DOT: Record<LifecycleTone, string> = {
  good: '#1A7F37', info: '#245BF3', warn: '#DC8A00', neutral: '#A3A3A3',
};

const LIFECYCLE_FACETS: Array<UseCase['lifecycle']> = ['adopted', 'piloting', 'at_risk', 'not_seen'];

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
  const [expandedAcrossId, setExpandedAcrossId] = useState<string | null>(null);

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

  // After confirming/dismissing one canvas, advance to the department's next
  // open one rather than closing — a box saying "5 process opportunities" must
  // let the reader walk all five.
  const nextSiblingId = (id: string): string | null => {
    const current = suggestions?.find(s => s.id === id);
    if (!current?.department) return null;
    const siblings = deptBoxes.find(b => b.suggestions.some(s => s.id === id))?.suggestions ?? [current];
    const idx = siblings.findIndex(s => s.id === id);
    return siblings[idx + 1]?.id ?? siblings[idx - 1]?.id ?? null;
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

  // One box per department; Cowork and Claude Code suggestions are lists inside it.
  const { deptBoxes, orgSuggestions } = useMemo(() => {
    return {
      deptBoxes: groupDeptBoxes(visibleSuggestions),
      orgSuggestions: visibleSuggestions.filter(s => !s.department),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestions]);

  const openSuggestion = suggestions?.find(s => s.id === openSuggestionId) ?? null;

  const filtered = useMemo(() => {
    let rows = useCases ?? [];
    if (!showArchived) rows = rows.filter(uc => uc.status !== 'archived');
    if (lifecycleFilter.size > 0) rows = rows.filter(uc => lifecycleFilter.has(uc.lifecycle));
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
            An admin can enable it under Admin → System.
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

        {(deptBoxes.length > 0 || orgSuggestions.length > 0) && (
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
            {deptBoxes.length > 0 && (
              <div className="p-4">
                <SubHead>By department, process opportunities</SubHead>
                <DeptProcessBoxes boxes={deptBoxes} onOpen={setOpenSuggestionId} />
              </div>
            )}

            {orgSuggestions.length > 0 && (
              <div className={deptBoxes.length > 0 ? 'border-t border-[#F2F2F2]' : ''}>
                {deptBoxes.length > 0 && (
                  <div className="px-4 pt-3 pb-1"><SubHead>Across departments</SubHead></div>
                )}
                {/* Cards, three to a row, like the dashboard recommendations (no priority edge). */}
                <ul className="m-0 px-4 pb-4 pt-2 list-none grid items-start gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
                  {orgSuggestions.map(s => {
                    const expanded = expandedAcrossId === s.id;
                    return (
                      <li key={s.id} className="bg-[#F8F9FB] rounded-[12px] px-4 py-3 flex flex-col gap-1.5">
                        {/* Three lines of description until the card is opened. */}
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => setExpandedAcrossId(expanded ? null : s.id)}
                          className="flex-1 flex flex-col gap-1.5 text-left"
                        >
                          <span className="text-[14px] font-semibold text-[#0A0A0A] leading-5">{s.title}</span>
                          {s.description && (
                            <span className={cx('text-[13px] leading-5 text-[#4D4D4D]', !expanded && 'line-clamp-3')}>{s.description}</span>
                          )}
                        </button>
                        <span className="text-[13px] text-[#05073F] tabular-nums">{formatSuggestionEvidenceLine(s)}</span>
                        <div className="flex items-center gap-2 pt-1">
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
                      </li>
                    );
                  })}
                </ul>
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
              <table className={cx(T.table, 'table-fixed min-w-[640px]')}>
                <thead>
                  <tr className={T.headRow}>
                    <th scope="col" className={T.th}>Use case</th>
                    <th scope="col" className={cx(T.th, 'w-[120px]')}>Lifecycle</th>
                    <th scope="col" className={cx(T.th, 'w-[240px]')}>Departments</th>
                  </tr>
                </thead>
                <tbody>
                  {group.items.map(uc => {
                    const pill = LIFECYCLE_PILL[uc.lifecycle];
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
                        <td className={T.td}>{pill ? <Pill tone={pill.tone}>{pill.label}</Pill> : <span className="text-[#8F8F8F]">—</span>}</td>
                        <td className={cx(T.tdMute, 'text-[13px] truncate')} title={uc.departments.join(', ')}>
                          {uc.departments.length > 0 ? uc.departments.join(', ') : '—'}
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
        const siblings = openSuggestion.department
          ? (deptBoxes.find(b => b.suggestions.some(s => s.id === openSuggestion.id))?.suggestions ?? [openSuggestion])
          : [openSuggestion];
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
