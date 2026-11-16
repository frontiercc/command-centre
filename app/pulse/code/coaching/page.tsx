// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Developer Pulse, Team coaching (admin and manager): a coaching plan for one team, from
// GET /api/pulse/code/coaching. Admins pick any team; a manager sees their own department.
// Marking an action done saves the figure it is meant to move, so the page can say later
// whether that figure moved, against the organisation's own movement over the same time.
'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { PageBody, Toolbar, Notice, B, cx, Muted } from '@/components/precision/ui';
import { Frame, Track, linkCls } from '@/components/pulse/WorkPulseOverview';
import { tierNamesOr } from '@/lib/pulse/tier-names';
import CoachingDone from '@/components/pulse/CoachingDone';
import { BEYOND_QUICK } from '@/lib/pulse/code/coaching-words';
import type { CoachingPlan, PlanAction } from '@/lib/pulse/code/team-coaching';

interface Data { teams: string[]; department: string | null; plan: CoachingPlan | null; checkAfterDays: number; /** Off hides What it freed. */ humanTimeOn?: boolean }

const pct = (v: number | null) => (v === null ? 'not measured' : `${Math.round(v * 100)}%`);

export default function TeamCoachingPage() {
  // useSearchParams needs a Suspense boundary above it in an app-router page.
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <TeamCoaching />
    </Suspense>
  );
}

function TeamCoaching() {
  // Decisions links here naming a team, so the plan opens on the team that was asked for.
  const asked = useSearchParams().get('department') ?? '';
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [department, setDepartment] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback((dept: string) => {
    setLoading(true);
    setError(null);
    fetch(`/api/pulse/code/coaching${dept ? `?department=${encodeURIComponent(dept)}` : ''}`)
      .then(async r => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || "Couldn't load this page. Try again.");
        return body as Data;
      })
      .then(d => { setData(d); setDepartment(d.department ?? ''); })
      .catch(e => { setData(null); setError(e.message); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(asked); }, [load, asked]);

  const act = async (a: PlanAction, mode: 'done' | 'undo') => {
    if (!data?.department) return;
    setBusy(a.key);
    await fetch('/api/pulse/code/coaching/actions', {
      method: mode === 'done' ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ department: data.department, key: a.key, note: mode === 'done' ? note || null : null }),
    }).catch(() => {});
    setBusy(null);
    setNoteFor(null);
    setNote('');
    load(data.department);
  };

  const plan = data?.plan ?? null;
  const tiers = plan ? tierNamesOr(plan.tierNames) : null;

  return (
    <>
      <TopBar title="Team Coaching" subtitle="What one team could do next, and whether what they did worked" />
      <PageBody className="dash-compact">
        {(data?.teams.length ?? 0) > 1 && (
          <Toolbar
            left={
              <select
                aria-label="Team"
                value={department}
                onChange={e => { setDepartment(e.target.value); load(e.target.value); }}
                className={cx(B.select, 'min-w-[240px] text-[14px]')}
              >
                {data!.teams.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            }
          />
        )}

        {loading && <LoadingSpinner />}
        {error && <Notice tone="warn" title="Not available.">{error}</Notice>}

        {!loading && !error && !plan && (
          <Notice tone="info" title="No coaching yet.">
            No classified coding sessions for this team in the last 30 days, so there is nothing to coach from.
          </Notice>
        )}

        {!loading && plan && (
          <>
            <Frame
              title={`Where ${plan.department} is`}
              judged
              period="Last 30 days against the 30 before"
              answer={<>
                <b>{plan.sessions.toLocaleString('en-GB')} sessions</b> from {plan.people} {plan.people === 1 ? 'person' : 'people'} in the last 30 days.
              </>}
              note={tiers
                ? `Multi-step work is a session the classifier judged "${tiers.t2}" or "${tiers.t3}": it carried out a task across several actions, rather than answering one question. A session it judged "${tiers.t1}" does not count. Those names are set on Admin → Developer Pulse → Tiers.`
                : undefined}
            >
              {plan.where.map((t, i) => <p key={i} className="m-0 py-0.5 text-[13px] leading-5 text-[#333333]">{t}</p>)}
              {plan.figures.deepShare !== null && plan.org.deepShare !== null && (
                <div className="mt-2 pt-2 border-t border-[#EAEAEA]">
                  {([[`This team, ${BEYOND_QUICK}`, plan.figures.deepShare], ['The organisation', plan.org.deepShare]] as const).map(([l, v]) => (
                    <div key={String(l)} className="grid grid-cols-[minmax(0,130px)_minmax(0,1fr)_48px] gap-2.5 items-center py-[3px] text-[13px]">
                      <span className="text-[#333333] leading-4">{l}</span>
                      <Track value={v as number} />
                      <span className="text-right tabular-nums">{pct(v as number)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Frame>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <Frame
                title="What to work on"
                judged
                period="Last 30 days"
                answer={plan.workOn.length > 0 ? <>{plan.workOn[0]}</> : <>No kinds of work stand out.</>}
                note={plan.figures.work.some(w => w.target !== null)
                  ? 'The share each kind of work takes, against what an admin intended on Admin → Developer Pulse.'
                  : 'The share each kind of work takes.'}
              >
                {plan.workOn.slice(1).map((t, i) => <p key={i} className="m-0 pb-1 text-[13px] leading-5 text-[#333333]">{t}</p>)}
                {plan.figures.work.slice(0, 6).map(w => (
                  <div key={w.workType} className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_96px] gap-2.5 items-center py-[3px] text-[13px]">
                    <span className="text-[#333333] leading-4">{w.label}</span>
                    <Track value={w.share} floor={w.target === null ? null : w.target / 100} />
                    <span className="text-right tabular-nums whitespace-nowrap">
                      {pct(w.share)}{w.target !== null ? <span className="text-[#8F8F8F]"> of {w.target}%</span> : null}
                    </span>
                  </div>
                ))}
              </Frame>

              <Frame
                title="Who to learn from"
                judged
                period="Last 30 days"
                answer={plan.learnFrom.length === 0
                  ? <>Nobody in this team is handing over much yet. The people to learn from are in other teams.</>
                  : <><b>{plan.learnFrom[0].name}</b> hands over the most, on {pct(plan.learnFrom[0].deepShare)} of their sessions.</>}
                note="Named because this page is for admins and managers only."
              >
                {plan.learnFrom.map(c => (
                  <div key={c.name} className="flex items-baseline gap-2.5 py-1.5 border-b border-[#F2F2F2] last:border-b-0 text-[13px]">
                    <span className="min-w-0 truncate text-[#0A0A0A]">{c.name}</span>
                    <span className="text-[#777777] whitespace-nowrap">{c.sessions} {c.sessions === 1 ? 'session' : 'sessions'}</span>
                    <span className="ml-auto tabular-nums text-[#333333]">{pct(c.deepShare)}</span>
                  </div>
                ))}
              </Frame>
            </div>

            {plan.figures.freed ? (
              <Frame
                title="What it freed"
                tag="AI estimate"
                period="Last 30 days"
                answer={<>
                  By hand, the team&rsquo;s {plan.figures.freed.sessions} estimated sessions would have taken about{' '}
                  <b>{Math.round(plan.figures.freed.byHandHours).toLocaleString('en-GB')} hours</b>, against{' '}
                  <b>{Math.round(plan.figures.freed.aiHours).toLocaleString('en-GB')} hours</b> with the assistant
                  {plan.figures.freed.topKind ? <>, most of it on {plan.figures.freed.topKind.toLowerCase()}</> : null}.
                </>}
                note="Claude's estimate per session, against measured active time. Only sessions carrying both are counted."
              >
                {[['With the assistant', plan.figures.freed.aiHours, false] as const, ['By hand (estimate)', plan.figures.freed.byHandHours, true] as const].map(([l, h, est]) => (
                  <div key={l} className="grid grid-cols-[minmax(0,150px)_minmax(0,1fr)_64px] gap-2.5 items-center py-[3px] text-[13px]">
                    <span className="text-[#333333]">{l}</span>
                    <Track value={h / Math.max(plan.figures.freed!.byHandHours, 1)} striped={est} />
                    <span className="text-right tabular-nums">{est ? '≈' : ''}{Math.round(h).toLocaleString('en-GB')} h</span>
                  </div>
                ))}
              </Frame>
            ) : (data?.humanTimeOn ?? true) ? <Frame title="What it freed" tag="AI estimate" period="Last 30 days"><Muted>No sessions with a by-hand estimate in the last 30 days yet.</Muted></Frame> : null}

            <Frame
              title="What to try"
              period={`Checked again ${plan.actions.some(a => a.done) ? 'from' : 'after'} ${data?.checkAfterDays ?? 30} days`}
              answer={plan.actions.length === 0
                ? <>Nothing to suggest: this team is within reach of everything the figures look at.</>
                : <><b>{plan.actions.length} {plan.actions.length === 1 ? 'thing' : 'things'}</b> worth trying, each tied to the figure it should move.</>}
              note="Marking one done records the figure as it stands today, for the team and the organisation, so the page can tell you later whether it moved."
            >
              {plan.actions.map(a => (
                <div key={a.key} className="py-2 border-b border-[#F2F2F2] last:border-b-0">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="m-0 text-[13px] leading-5 text-[#0A0A0A]">{a.text}</p>
                      {a.because && <p className="m-0 mt-0.5 text-[12px] text-[#777777]">{a.because}</p>}
                    </div>
                    <span className="shrink-0 flex gap-1.5">
                      {a.done ? (
                        <button type="button" disabled={busy === a.key} onClick={() => act(a, 'undo')} className={linkCls}>Undo</button>
                      ) : noteFor === a.key ? (
                        <button type="button" disabled={busy === a.key} onClick={() => act(a, 'done')} className={`${B.secondary} !py-0.5 !px-2 !text-[12px]`}>Save</button>
                      ) : (
                        <button type="button" onClick={() => { setNoteFor(a.key); setNote(''); }} className={`${B.secondary} !py-0.5 !px-2 !text-[12px]`}>Mark done</button>
                      )}
                    </span>
                  </div>
                  {noteFor === a.key && !a.done && (
                    <input
                      autoFocus
                      value={note}
                      onChange={e => setNote(e.target.value)}
                      placeholder="What did the team do? (optional)"
                      maxLength={500}
                      className="mt-1.5 w-full border border-[#DADADA] rounded-[8px] px-2 py-1 text-[13px]"
                    />
                  )}
                  <CoachingDone a={a} />
                </div>
              ))}
            </Frame>

            {plan.pastActions.length > 0 ? (
              <Frame
                title="Done before"
                period={`${plan.pastActions.length} ${plan.pastActions.length === 1 ? 'action' : 'actions'}`}
                answer={<>These are no longer suggested: the figure that raised them has moved.</>}
              >
                {plan.pastActions.map(a => (
                  <div key={a.key} className="py-2 border-b border-[#F2F2F2] last:border-b-0">
                    <p className="m-0 text-[13px] leading-5 text-[#333333]">{a.text}</p>
                    <CoachingDone a={a} />
                  </div>
                ))}
              </Frame>
            ) : <Frame title="Done before"><Muted>Nothing done before yet. Actions you mark done move here once their figure has moved.</Muted></Frame>}
          </>
        )}
      </PageBody>
    </>
  );
}
