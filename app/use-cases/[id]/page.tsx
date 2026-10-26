// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import Sparkline from '@/components/pulse/Sparkline';
import SpreadPanel, { type SpreadData } from '@/components/usecases/SpreadPanel';
import ImpactPanel, { type UseCaseImpact, type ImpactSummary } from '@/components/usecases/ImpactPanel';
import SkillDraftPanel, { type SkillDraftView } from '@/components/usecases/SkillDraftPanel';
import { buildActivateEvidenceLine, tierDepthLabel, humaniseMatchedSignals } from '@/lib/usecases/activate-evidence-format';
import { PageBody, Toolbar, Panel, PanelFoot, SubHead, T, Tag, Pill, B, Notice, Empty, Muted, cx } from '@/components/precision/ui';

interface WeekActivity {
  weekStart: number;
  distinctUsers: number;
  sessionCount: number;
  matchedMessages: number;
  latestTier: number | null;
  lastSeenAt: number | null;
}

interface UseCase {
  id: string;
  title: string;
  description: string | null;
  ownerUserId: string | null;
  departments: string[];
  surfaces: string[];
  keywords: string[];
  skills: string[];
  connectors: string[];
  taskTypes: string[];
  origin: 'planned' | 'emergent' | 'ideated';
  status: 'candidate' | 'confirmed' | 'archived';
  lifecycle: 'not_seen' | 'piloting' | 'adopted' | 'at_risk';
  captureMethod: string;
  sourceExcerpt: string | null;
  lastActivatedAt: number | null;
  activateResult: unknown | null;
  weeks: WeekActivity[];
  painPoint: string | null;
  valueHypothesis: string | null;
  baselineNote: string | null;
  kpiNote: string | null;
  strategic: number;
  spread?: SpreadData;
  impact: UseCaseImpact;
  impactSummary: ImpactSummary;
  liveEvidence: ActivateEvidence | null;
  skillDraft?: SkillDraftView | null;
}

interface ActivateEvidence {
  seen: boolean;
  distinctUsers: number;
  sessionCount: number;
  matchedMessages: number;
  latestTier: number | null;
  lastSeenAt: number | null;
  windowDays: number;
  signals: string[];
}

interface UserOption {
  id: string;
  display_name?: string | null;
  email?: string | null;
}

const ORIGIN_LABEL: Record<UseCase['origin'], string> = {
  planned: 'Planned',
  emergent: 'Emergent',
  ideated: 'Ideated',
};

const STATUS_LABEL: Record<UseCase['status'], string> = {
  confirmed: 'Confirmed',
  candidate: 'Candidate',
  archived: 'Archived',
};

const LIFECYCLE_PILL: Record<string, { label: string; tone: 'good' | 'info' | 'warn' | 'neutral' }> = {
  adopted: { label: 'Adopted', tone: 'good' },
  piloting: { label: 'Piloting', tone: 'info' },
  at_risk: { label: 'At risk', tone: 'warn' },
  not_seen: { label: 'Not seen', tone: 'neutral' },
};

function toList(input: string): string[] {
  return input
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function userLabel(u: UserOption): string {
  return u.display_name || u.email || u.id;
}

const inputCls = cx(B.input, 'w-full');
const labelCls = 'block text-[13px] font-medium text-[#4D4D4D] mb-1';

export default function UseCaseDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = decodeURIComponent(String(params?.id ?? ''));

  const [checked, setChecked] = useState(false);
  const [uc, setUc] = useState<UseCase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);

  const [editingRule, setEditingRule] = useState(false);
  const [keywords, setKeywords] = useState('');
  const [skills, setSkills] = useState('');
  const [connectors, setConnectors] = useState('');
  const [savingRule, setSavingRule] = useState(false);

  const [editingCanvas, setEditingCanvas] = useState(false);
  const [painPoint, setPainPoint] = useState('');
  const [valueHypothesis, setValueHypothesis] = useState('');
  const [baselineNote, setBaselineNote] = useState('');
  const [kpiNote, setKpiNote] = useState('');
  const [savingCanvas, setSavingCanvas] = useState(false);

  const [users, setUsers] = useState<UserOption[]>([]);
  const [savingOwner, setSavingOwner] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [savingStrategic, setSavingStrategic] = useState(false);
  const [confirming, setConfirming] = useState(false);

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

  const load = useCallback(() => {
    if (!id) return;
    fetch(`/api/use-cases/${encodeURIComponent(id)}`)
      .then(r => {
        if (r.status === 404) { setNotEnabled(true); throw new Error('not enabled'); }
        if (!r.ok) throw new Error("Couldn't load this page. Try again.");
        return r.json();
      })
      .then((data: UseCase) => {
        setUc(data);
        setKeywords(data.keywords.join(', '));
        setSkills(data.skills.join(', '));
        setConnectors(data.connectors.join(', '));
        setPainPoint(data.painPoint ?? '');
        setValueHypothesis(data.valueHypothesis ?? '');
        setBaselineNote(data.baselineNote ?? '');
        setKpiNote(data.kpiNote ?? '');
      })
      .catch(e => { if (e.message !== 'not enabled') setError(e.message); });
  }, [id]);

  useEffect(() => {
    if (checked) load();
  }, [checked, load]);

  // Lazy 7-day refresh of the AI-written impact summary — fire once in the
  // background when a stale summary exists, no user action required.
  useEffect(() => {
    if (!uc?.impactSummary?.text || uc.impactSummary.generatedAt == null) return;
    const nowS = Math.floor(Date.now() / 1000);
    if (uc.impactSummary.generatedAt >= nowS - 7 * 86400) return;
    let cancelled = false;
    fetch(`/api/use-cases/${encodeURIComponent(uc.id)}/impact-summary`, { method: 'POST' })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (cancelled || !data) return;
        setUc(prev => (prev ? { ...prev, impactSummary: { text: data.summary, generatedAt: data.generatedAt } } : prev));
      })
      .catch(() => { /* background refresh — swallow, panel keeps the existing summary */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the use case id, not the whole uc object
  }, [uc?.id]);

  // Note: /api/use-cases/[id] returns 404 both when the use case is missing
  // AND when useCasesEnabled is false — indistinguishable from this endpoint
  // alone. If the use case genuinely doesn't exist while the feature IS
  // enabled, this card's "enable it under Admin → System" copy is slightly
  // misleading but harmless; the register page is the far more common
  // not-enabled entry point and gives the accurate read there.

  useEffect(() => {
    if (!checked) return;
    fetch('/api/users')
      .then(r => (r.ok ? r.json() : []))
      .then(setUsers)
      .catch(() => setUsers([]));
  }, [checked]);

  const handleSaveRule = async () => {
    if (!uc) return;
    setSavingRule(true);
    try {
      const res = await fetch(`/api/use-cases/${encodeURIComponent(uc.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keywords: toList(keywords),
          skills: toList(skills),
          connectors: toList(connectors),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      setEditingRule(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSavingRule(false);
    }
  };

  const handleSaveCanvas = async () => {
    if (!uc) return;
    setSavingCanvas(true);
    try {
      const res = await fetch(`/api/use-cases/${encodeURIComponent(uc.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          painPoint: painPoint.trim() || null,
          valueHypothesis: valueHypothesis.trim() || null,
          baselineNote: baselineNote.trim() || null,
          kpiNote: kpiNote.trim() || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Save failed');
      setEditingCanvas(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSavingCanvas(false);
    }
  };

  const handleOwnerChange = async (ownerUserId: string) => {
    if (!uc) return;
    setSavingOwner(true);
    try {
      const res = await fetch(`/api/use-cases/${encodeURIComponent(uc.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerUserId: ownerUserId || null }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Failed to set owner');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set owner');
    } finally {
      setSavingOwner(false);
    }
  };

  const handleToggleStrategic = async () => {
    if (!uc) return;
    const next = uc.strategic !== 1;
    // The Governance rollup only shows CONFIRMED strategic bets — a star on a
    // candidate would silently appear nowhere. Offer to confirm in the same
    // action.
    const body: Record<string, unknown> = { strategic: next };
    if (next && uc.status === 'candidate') {
      const alsoConfirm = window.confirm(
        `Strategic bets appear on the Governance page once the use case is confirmed. "${uc.title}" is still a candidate.\n\nConfirm it now as well?`
      );
      if (alsoConfirm) body.status = 'confirmed';
    }
    setSavingStrategic(true);
    try {
      const res = await fetch(`/api/use-cases/${encodeURIComponent(uc.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Failed to update strategic bet');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update strategic bet');
    } finally {
      setSavingStrategic(false);
    }
  };

  const handleConfirmUseCase = async () => {
    if (!uc || uc.status !== 'candidate') return;
    setConfirming(true);
    try {
      const res = await fetch(`/api/use-cases/${encodeURIComponent(uc.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'confirmed' }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Failed to confirm use case');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm use case');
    } finally {
      setConfirming(false);
    }
  };

  const handleToggleArchive = async () => {
    if (!uc) return;
    const archiving_ = uc.status !== 'archived';
    const confirmMsg = archiving_
      ? `Archive "${uc.title}"? It will be hidden from the register by default.`
      : `Un-archive "${uc.title}"? It will return to Confirmed.`;
    if (!window.confirm(confirmMsg)) return;

    setArchiving(true);
    try {
      const res = await fetch(`/api/use-cases/${encodeURIComponent(uc.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: archiving_ ? 'archived' : 'confirmed' }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Failed to update status');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
    } finally {
      setArchiving(false);
    }
  };

  if (!checked || (!uc && !error && !notEnabled)) {
    return (
      <>
        <TopBar title="Use Case" />
        <LoadingSpinner />
      </>
    );
  }

  if (notEnabled) {
    return (
      <>
        <TopBar title="Use Case" />
        <PageBody>
          <Empty title="Use Cases is not enabled on this instance">
            An admin can enable it under Admin → System.
          </Empty>
        </PageBody>
      </>
    );
  }

  if (error && !uc) {
    return (
      <>
        <TopBar title="Use Case" />
        <PageBody>
          <Notice tone="error">{error}</Notice>
          <Link href="/use-cases" className={cx(B.link, 'self-start')}>Back to register</Link>
        </PageBody>
      </>
    );
  }

  if (!uc) return null;

  const lifecyclePill = LIFECYCLE_PILL[uc.lifecycle];
  const weeks = uc.weeks ?? [];
  const sparklineData = weeks.map(w => w.matchedMessages + w.sessionCount);
  // Fall back to the stored snapshot only for an old cached client response
  // that predates the liveEvidence field — a freshly-fetched uc always has it.
  const evidence = uc.liveEvidence ?? (uc.activateResult as ActivateEvidence | null);

  return (
    <>
      <TopBar title={uc.title} subtitle="Use case detail" />
      <PageBody>
        <Toolbar
          left={
            <span className="flex flex-wrap items-center gap-2">
              <Link href="/use-cases" className="text-[#245BF3] hover:underline">Back to register</Link>
              <span className="text-[#D4D4D4]" aria-hidden="true">·</span>
              <Tag>{ORIGIN_LABEL[uc.origin]}</Tag>
              <Pill tone={uc.status === 'confirmed' ? 'good' : 'neutral'}>{STATUS_LABEL[uc.status]}</Pill>
              {lifecyclePill && <Pill tone={lifecyclePill.tone}>{lifecyclePill.label}</Pill>}
            </span>
          }
        >
          {uc.status === 'candidate' && (
            <button type="button" onClick={handleConfirmUseCase} disabled={confirming} className={B.primary}>
              {confirming ? 'Saving...' : 'Confirm use case'}
            </button>
          )}
          <button type="button" onClick={handleToggleArchive} disabled={archiving} className={B.secondary}>
            {archiving ? 'Saving...' : uc.status === 'archived' ? 'Un-archive' : 'Archive'}
          </button>
        </Toolbar>

        {error && <Notice tone="error">{error}</Notice>}

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4 items-start">
          <div className="flex flex-col gap-4 min-w-0">
            <Panel title="About">
              <div className="flex flex-col gap-3">
                {uc.description ? (
                  <p className="m-0 text-[14px] leading-6 text-[#333333]">{uc.description}</p>
                ) : (
                  <Muted>No description.</Muted>
                )}
                {(uc.departments.length > 0 || uc.surfaces.length > 0) && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {uc.departments.map(d => (
                      <span key={d} className="text-[13px] text-[#4D4D4D] bg-[#F2F2F2] rounded-[6px] px-1.5 py-0.5">{d}</span>
                    ))}
                    {uc.surfaces.map(s => <Tag key={s}>{s}</Tag>)}
                  </div>
                )}
                {uc.sourceExcerpt && (
                  <div className="pt-3 border-t border-[#F2F2F2]">
                    <SubHead>Source excerpt</SubHead>
                    <p className="m-0 text-[13px] text-[#666666] italic">&ldquo;{uc.sourceExcerpt}&rdquo;</p>
                  </div>
                )}
              </div>
            </Panel>

            <ImpactPanel impact={uc.impact} summary={uc.impactSummary} useCaseId={uc.id} canRegenerate={true} />

            <Panel title="Weekly activity" right={<Tag tone="measured">Measured</Tag>} flush={weeks.length > 0}>
              {weeks.length === 0 ? (
                <Muted>No tracked weeks yet. Tracking is automatic, and weekly activity appears once matching work is seen.</Muted>
              ) : (
                <>
                  <div className="px-4 pt-3 pb-2">
                    <Sparkline data={sparklineData} partialLast label="Weekly matched activity" />
                  </div>
                  <div className="overflow-x-auto border-t border-[#F2F2F2]">
                    <table className={T.table}>
                      <thead>
                        <tr className={T.headRow}>
                          <th scope="col" className={T.th}>Week commencing</th>
                          <th scope="col" className={T.thRight}>Users</th>
                          <th scope="col" className={T.thRight}>Sessions</th>
                          <th scope="col" className={T.thRight}>Messages</th>
                        </tr>
                      </thead>
                      <tbody>
                        {weeks.map(w => (
                          <tr key={w.weekStart} className={T.row}>
                            <td className={cx(T.tdMute, 'tabular-nums')}>{new Date(w.weekStart * 1000).toISOString().slice(0, 10)}</td>
                            <td className={T.tdRight}>{w.distinctUsers}</td>
                            <td className={T.tdRight}>{w.sessionCount}</td>
                            <td className={T.tdRight}>{w.matchedMessages}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </Panel>

            {uc.status === 'confirmed' && uc.skillDraft && (
              <SkillDraftPanel
                key={uc.id}
                view={uc.skillDraft}
                useCaseId={uc.id}
                onChanged={v => setUc(prev => (prev ? { ...prev, skillDraft: v } : prev))}
              />
            )}

            {uc.spread !== undefined && (
              <SpreadPanel spread={uc.spread} />
            )}
          </div>

          <div className="flex flex-col gap-4 min-w-0">
            <Panel title="Ownership">
              <div className="flex flex-col gap-3">
                <div>
                  <label htmlFor="uc-owner" className={labelCls}>Owner</label>
                  <select
                    id="uc-owner"
                    value={uc.ownerUserId ?? ''}
                    onChange={e => handleOwnerChange(e.target.value)}
                    disabled={savingOwner}
                    className={inputCls}
                  >
                    <option value="">Unassigned</option>
                    {users.map(u => (
                      <option key={u.id} value={u.id}>{userLabel(u)}</option>
                    ))}
                  </select>
                </div>
                <div className="pt-3 border-t border-[#F2F2F2]">
                  <button
                    type="button"
                    onClick={handleToggleStrategic}
                    disabled={savingStrategic}
                    aria-pressed={uc.strategic === 1}
                    className={cx(B.secondary, uc.strategic === 1 && '!border-[#F5D9A8] !bg-[#FFFAF0] !text-[#8A5300]')}
                  >
                    <span aria-hidden="true" className={uc.strategic === 1 ? 'text-[#DC8A00]' : 'text-[#8F8F8F]'}>{uc.strategic === 1 ? '★' : '☆'}</span>
                    {savingStrategic ? 'Saving...' : uc.strategic === 1 ? 'Strategic bet' : 'Mark as strategic bet'}
                  </button>
                  <p className="m-0 mt-1.5 text-[13px] text-[#8F8F8F]">
                    Board-visible strategic bet: appears on the Use Case Governance rollup once the use case is confirmed.
                  </p>
                </div>
              </div>
            </Panel>

            <Panel
              title="Activity"
              subtitle="Sessions judged to be this work, last 30 days"
              right={<Tag tone="judged" title="Claude reads each finished session and judges which use cases it is doing">AI-judged</Tag>}
              flush
            >
              <div className="p-4 flex flex-col gap-3">
                {evidence && evidence.seen && (() => {
                  const activateEvidenceLine = buildActivateEvidenceLine(evidence);
                  return (
                    <Notice
                      tone="success"
                      title={
                        <>
                          Seen: {evidence.distinctUsers} user{evidence.distinctUsers === 1 ? '' : 's'} · {evidence.sessionCount} session{evidence.sessionCount === 1 ? '' : 's'}
                          {evidence.latestTier != null && <> · {tierDepthLabel(evidence.latestTier)}</>}
                        </>
                      }
                    >
                      {activateEvidenceLine && <span className="block mt-1 text-[13px]">{activateEvidenceLine}</span>}
                      {evidence.signals.length > 0 && (
                        <span className="block mt-1 text-[13px]">Matched by: {humaniseMatchedSignals(evidence.signals)}</span>
                      )}
                    </Notice>
                  );
                })()}

                {evidence && !evidence.seen && (
                  <Notice tone="warn" title="Not seen yet.">
                    <span className="block mt-1 text-[13px]">
                      No session in the last {evidence.windowDays} days was judged to be this work. Finished sessions are read every hour, and a newly confirmed use case is checked against the last 13 weeks, so this fills in on its own.
                    </span>
                  </Notice>
                )}

                {!evidence && <Muted>Not measured yet.</Muted>}
              </div>
              <PanelFoot>Claude reads each finished session and judges which use cases it is doing. Tools and the clues below inform that judgement; on their own they never count.</PanelFoot>
            </Panel>

            <Panel
              id="matching-rule-card"
              title="Clues"
              subtitle="Phrases, skills and connectors that help recognise this work"
              right={!editingRule ? (
                <button type="button" onClick={() => setEditingRule(true)} className={B.link}>Edit</button>
              ) : undefined}
            >
              {!editingRule ? (
                <div className="flex flex-col gap-2.5">
                  <RuleRow label="Phrases" values={uc.keywords} />
                  <RuleRow label="Skills" values={uc.skills} />
                  <RuleRow label="Connectors" values={uc.connectors} />
                  {uc.taskTypes.length > 0 && <RuleRow label="Task types" values={uc.taskTypes} />}
                  {!uc.description?.trim() && (
                    <p className="m-0 text-[13px] text-[#B54708]">Add a description of the work: it is what sessions are judged against.</p>
                  )}
                  <p className="m-0 text-[13px] text-[#8F8F8F]">Optional. They help the judge; a session never counts just because one appears.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div>
                    <label htmlFor="uc-rule-keywords" className={labelCls}>Phrases people use for this work</label>
                    <input id="uc-rule-keywords" value={keywords} onChange={e => setKeywords(e.target.value)} className={inputCls} placeholder="contract, NDA" />
                  </div>
                  <div>
                    <label htmlFor="uc-rule-skills" className={labelCls}>Skills</label>
                    <input id="uc-rule-skills" value={skills} onChange={e => setSkills(e.target.value)} className={inputCls} placeholder="contract-review" />
                  </div>
                  <div>
                    <label htmlFor="uc-rule-connectors" className={labelCls}>Connectors</label>
                    <input id="uc-rule-connectors" value={connectors} onChange={e => setConnectors(e.target.value)} className={inputCls} placeholder="docusign" />
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={handleSaveRule} disabled={savingRule} className={B.primary}>
                      {savingRule ? 'Saving...' : 'Save clues'}
                    </button>
                    <button type="button" onClick={() => setEditingRule(false)} className={B.secondary}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </Panel>

            {(uc.painPoint || uc.valueHypothesis || uc.baselineNote || uc.kpiNote || uc.captureMethod === 'process_mined') && (
              <Panel
                title="Canvas"
                right={!editingCanvas ? (
                  <button type="button" onClick={() => setEditingCanvas(true)} className={B.link}>Edit</button>
                ) : undefined}
              >
                {!editingCanvas ? (
                  <div className="flex flex-col gap-3">
                    <CanvasRow label="Pain point" value={uc.painPoint} />
                    <CanvasRow label="Value hypothesis" value={uc.valueHypothesis} />
                    <CanvasRow label="Baseline today" value={uc.baselineNote} />
                    <CanvasRow label="Measure of success" value={uc.kpiNote} />
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <div>
                      <label htmlFor="uc-canvas-pain" className={labelCls}>Pain point</label>
                      <input id="uc-canvas-pain" value={painPoint} onChange={e => setPainPoint(e.target.value)} className={inputCls} placeholder="What's the pain point?" />
                    </div>
                    <div>
                      <label htmlFor="uc-canvas-value" className={labelCls}>Value hypothesis</label>
                      <input id="uc-canvas-value" value={valueHypothesis} onChange={e => setValueHypothesis(e.target.value)} className={inputCls} placeholder="What's it worth if transformed?" />
                    </div>
                    <div>
                      <label htmlFor="uc-canvas-baseline" className={labelCls}>Baseline today</label>
                      <input id="uc-canvas-baseline" value={baselineNote} onChange={e => setBaselineNote(e.target.value)} className={inputCls} placeholder="e.g. hours per pack, done by hand" />
                    </div>
                    <div>
                      <label htmlFor="uc-canvas-kpi" className={labelCls}>Measure of success</label>
                      <input id="uc-canvas-kpi" value={kpiNote} onChange={e => setKpiNote(e.target.value)} className={inputCls} placeholder="How will you know it worked?" />
                    </div>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={handleSaveCanvas} disabled={savingCanvas} className={B.primary}>
                        {savingCanvas ? 'Saving...' : 'Save canvas'}
                      </button>
                      <button type="button" onClick={() => setEditingCanvas(false)} className={B.secondary}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </Panel>
            )}
          </div>
        </div>
      </PageBody>
    </>
  );
}

function CanvasRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="m-0 mb-0.5 text-[13px] font-medium text-[#666666]">{label}</p>
      <p className={value ? 'm-0 text-[14px] text-[#333333]' : 'm-0 text-[14px] text-[#B3B3B3]'}>{value || 'Not set'}</p>
    </div>
  );
}

function RuleRow({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-[#8F8F8F] w-20 shrink-0">{label}</span>
        <span className="text-[13px] text-[#B3B3B3]">—</span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2">
      <span className="text-[13px] text-[#8F8F8F] w-20 shrink-0 pt-0.5">{label}</span>
      <div className="flex items-center gap-1 flex-wrap min-w-0">
        {values.map(v => <Tag key={v}>{v}</Tag>)}
      </div>
    </div>
  );
}
