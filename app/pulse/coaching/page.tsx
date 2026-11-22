// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Work Pulse, Team coaching (admin and manager): a coaching plan for one team, from
// GET /api/pulse/coaching. Admins pick any team; a manager sees their own department.
// Marking an action done saves the figure it is meant to move, so the page can say later
// whether that figure moved, against the organisation's own movement over the same time.
// The plan reads every platform Work Pulse covers (Claude Cowork, Claude in Office/Google, Claude
// Chat and ChatGPT); there is no switch, so one team has one plan and one record.
'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { PageBody, Toolbar, Notice, B, cx, Muted } from '@/components/precision/ui';
import { Frame, Track, linkCls } from '@/components/pulse/WorkPulseOverview';
import CoachingDone from '@/components/pulse/CoachingDone';
import { tierNamesOr } from '@/lib/pulse/tier-names';
import { MEANINGFUL_WORK } from '@/lib/pulse/cowork/coaching-words';
import type { CoworkCoachingPlan, CoworkMetric } from '@/lib/pulse/cowork/team-coaching';
import type { PlanAction } from '@/lib/pulse/coaching-core';
import type { ProducedSession } from '@/lib/pulse/cowork/coaching-figures';
import { PRODUCT_FAMILY, PRODUCT_LABEL, type WorkProduct } from '@/lib/pulse/cowork/products';

interface Data {
  teams: string[];
  department: string | null;
  plan: CoworkCoachingPlan | null;
  checkAfterDays: number;
  /** Admin → Work Pulse "Human time": off hides What it freed. */
  humanTimeOn?: boolean;
  /** Whether ChatGPT is connected and shown, so the page names what its figures cover. */
  openaiPresent: boolean;
}

const pct = (v: number | null) => (v === null ? 'not measured' : `${Math.round(v * 100)}%`);

/** At most this many produced sessions show before "Show all". */
const PRODUCED_SHOWN = 10;

/** Where a session happened, as the panels name the platforms. */
function whereWords(s: ProducedSession): string {
  const app = s.product as WorkProduct | null;
  if (app && app in PRODUCT_LABEL && PRODUCT_FAMILY[app] !== 'cowork') {
    return `Claude in ${PRODUCT_LABEL[app]}`;
  }
  return s.platform === 'claude_chat' ? 'Claude Chat' : s.platform === 'chatgpt' ? 'ChatGPT' : 'Claude Cowork';
}

/** What came out when the platform gave no name for it. */
function unnamed(s: ProducedSession): string {
  return s.platform === 'claude_chat' ? 'An artifact or a file, name not recorded' : 'A file, name not recorded';
}

/** The sessions that produced something, newest first, with the names of what came out. */
function ProducedList({ items }: { items: ProducedSession[] }) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, PRODUCED_SHOWN);
  return (
    <div className="mt-2 pt-2 border-t border-[#F2F2F2]">
      <div className="text-[12px] font-semibold text-[#333333] mb-0.5">What was produced, newest first</div>
      {shown.map((s, i) => (
        <div key={i} className="py-1.5 border-b border-[#F2F2F2] last:border-b-0">
          <div className="text-[13px] leading-5 text-[#0A0A0A] break-words">
            {s.outputs ?? <span className="text-[#777777]">{unnamed(s)}</span>}
          </div>
          <div className="text-[12px] leading-5 text-[#777777]">
            {s.at ? new Date(s.at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'Date not recorded'}
            {' · '}{s.name}{' · '}{s.kind ? `${s.kind.charAt(0).toUpperCase()}${s.kind.slice(1)}` : 'Kind of work not judged'}{' · '}{whereWords(s)}
          </div>
        </div>
      ))}
      {items.length > PRODUCED_SHOWN && (
        <button type="button" onClick={() => setAll(!all)} className={cx(linkCls, 'mt-1.5')}>
          {all ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

export default function WorkTeamCoachingPage() {
  // useSearchParams needs a Suspense boundary above it in an app-router page.
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <TeamCoaching />
    </Suspense>
  );
}

function TeamCoaching() {
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
    fetch(`/api/pulse/coaching${dept ? `?department=${encodeURIComponent(dept)}` : ''}`)
      .then(async r => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || "Couldn't load this page. Try again.");
        return body as Data;
      })
      .then(d => { setData(d); setDepartment(d.department ?? ''); })
      .catch(e => { setData(null); setError(e.message); })
      .finally(() => setLoading(false));
  }, []);

  // A link from elsewhere can name the team, so the plan opens on the team that was asked for.
  useEffect(() => { load(asked); }, [load, asked]);

  const act = async (a: PlanAction<CoworkMetric>, mode: 'done' | 'undo') => {
    if (!data?.department) return;
    setBusy(a.key);
    await fetch('/api/pulse/coaching/actions', {
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
  // Every platform: Claude alone until ChatGPT is connected and shown.
  const chatgptShown = data?.openaiPresent ?? false;
  const who = chatgptShown ? 'AI' : 'Claude';

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
            Nothing this team handed over in the last 30 days has been judged yet, so there is nothing to coach from.
          </Notice>
        )}

        {!loading && plan && (
          <>
            <Frame
              title={`Where ${plan.department} is`}
              judged
              period="Last 30 days against the 30 before"
              answer={<>
                <b>{plan.prompts.toLocaleString('en-GB')} {plan.prompts === 1 ? 'piece of work' : 'pieces of work'}</b> from {plan.people.toLocaleString('en-GB')} {plan.people === 1 ? 'person' : 'people'} in the last 30 days.
              </>}
              note={tiers
                ? `${MEANINGFUL_WORK.charAt(0).toUpperCase()}${MEANINGFUL_WORK.slice(1)} means Claude judged it "${tiers.t2}" or "${tiers.t3}": a whole piece of work handed over, rather than a question answered. Work it judged "${tiers.t1}" does not count.`
                : undefined}
            >
              {plan.where.map((t, i) => <p key={i} className="m-0 py-0.5 text-[13px] leading-5 text-[#333333]">{t}</p>)}
              {plan.figures.deepShare !== null && (
                <div className="mt-2 pt-2 border-t border-[#EAEAEA]">
                  {([['This team', plan.figures.deepShare], ['The organisation', plan.org.deepShare]] as const)
                    .filter(([, v]) => v !== null)
                    .map(([l, v]) => (
                      <div key={String(l)} className="grid grid-cols-[minmax(0,130px)_minmax(0,1fr)_48px] gap-2.5 items-center py-[3px] text-[13px]">
                        <span className="text-[#333333] leading-4">{l}</span>
                        <Track value={v as number} floor={plan.depthFloor > 0 ? plan.depthFloor / 100 : null} />
                        <span className="text-right tabular-nums">{pct(v as number)}</span>
                      </div>
                    ))}
                  {plan.depthFloor > 0 && (
                    <p className="m-0 mt-1 text-[12px] text-[#8F8F8F]">The marker is the {plan.depthFloor}% floor an admin set for a department.</p>
                  )}
                </div>
              )}
            </Frame>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <Frame
                title="What to work on"
                judged
                period="Last 30 days"
                answer={plan.workOn.length > 0 ? <>{plan.workOn[0]}</> : <>No kinds of work stand out.</>}
                note="The kinds of work the team handed over, commonest first."
              >
                {plan.workOn.slice(1).map((t, i) => <p key={i} className="m-0 pb-1 text-[13px] leading-5 text-[#333333]">{t}</p>)}
                {plan.figures.work.slice(0, 6).map(w => (
                  <div key={w.taskType} className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_56px] gap-2.5 items-center py-[3px] text-[13px]">
                    <span className="text-[#333333] leading-4">{w.label}</span>
                    <Track value={w.share} />
                    <span className="text-right tabular-nums whitespace-nowrap">{pct(w.share)}</span>
                  </div>
                ))}
              </Frame>

              <Frame
                title="Who to learn from"
                judged
                period="Last 30 days"
                answer={plan.learnFrom.length === 0
                  ? <>Nobody in this team is handing over much yet. The people to learn from are in other teams.</>
                  : <><b>{plan.learnFrom[0].name}</b> gets the most out of it, on {pct(plan.learnFrom[0].deepShare)} of their work.</>}
              >
                {plan.learnFrom.map(c => (
                  <div key={c.name} className="flex items-baseline gap-2.5 py-1.5 border-b border-[#F2F2F2] last:border-b-0 text-[13px]">
                    <span className="min-w-0 truncate text-[#0A0A0A]">{c.name}</span>
                    <span className="text-[#777777] whitespace-nowrap">{c.prompts.toLocaleString('en-GB')} {c.prompts === 1 ? 'piece' : 'pieces'}</span>
                    <span className="ml-auto tabular-nums text-[#333333]">{pct(c.deepShare)}</span>
                  </div>
                ))}
              </Frame>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {plan.figures.freed ? (
                <Frame
                  title="What it freed"
                  tag="AI estimate"
                  period="Last 30 days"
                  answer={<>
                    By hand, the team&rsquo;s {plan.figures.freed.sessions.toLocaleString('en-GB')} estimated sessions would have taken about{' '}
                    <b>{Math.round(plan.figures.freed.byHandHours).toLocaleString('en-GB')} hours</b>, against{' '}
                    <b>{Math.round(plan.figures.freed.aiHours).toLocaleString('en-GB')} hours</b> with {who}.
                  </>}
                  note={`By hand is Claude's estimate for each session, added up; with ${who} is measured active time. Only sessions carrying both are counted: Claude Cowork and Claude in Office/Google${chatgptShown ? ', and ChatGPT' : ''}. Claude Chat sessions carry no estimate.`}
                >
                  {[[`With ${who}`, plan.figures.freed.aiHours, false] as const, ['By hand (estimate)', plan.figures.freed.byHandHours, true] as const].map(([l, h, est]) => (
                    <div key={l} className="grid grid-cols-[minmax(0,150px)_minmax(0,1fr)_64px] gap-2.5 items-center py-[3px] text-[13px]">
                      <span className="text-[#333333]">{l}</span>
                      <Track value={h / Math.max(plan.figures.freed!.byHandHours, 1)} striped={est} />
                      <span className="text-right tabular-nums">{est ? '≈' : ''}{Math.round(h).toLocaleString('en-GB')} h</span>
                    </div>
                  ))}
                </Frame>
              ) : (data?.humanTimeOn ?? true) ? <Frame title="What it freed" tag="AI estimate" period="Last 30 days"><Muted>No sessions with a by-hand estimate in the last 30 days yet.</Muted></Frame> : null}

              {plan.figures.producedNothing ? (
                <Frame
                  title="Did the work come out"
                  period="Last 30 days"
                  answer={<>
                    <b>{(plan.figures.producedNothing.measured - plan.figures.producedNothing.sessions).toLocaleString('en-GB')} of {plan.figures.producedNothing.measured.toLocaleString('en-GB')} sessions</b> ended with something saved, sent or published.
                  </>}
                  note={`A session counts as producing something when a file was written, sent or published in it, in Claude Chat when a reply made an artifact or a file${chatgptShown ? ', and in ChatGPT when a reply listed a file' : ''}. Sessions that could not be read are left out of both figures. Names are the file names and titles as they were saved, without folders, with personal data masked.`}
                >
                  {([['Produced something', 1 - plan.figures.producedNothing.share], ['Produced nothing', plan.figures.producedNothing.share]] as const).map(([l, v]) => (
                    <div key={l} className="grid grid-cols-[minmax(0,150px)_minmax(0,1fr)_48px] gap-2.5 items-center py-[3px] text-[13px]">
                      <span className="text-[#333333]">{l}</span>
                      <Track value={v} />
                      <span className="text-right tabular-nums">{pct(v)}</span>
                    </div>
                  ))}
                  <ProducedList items={plan.figures.produced ?? []} />
                </Frame>
              ) : <Frame title="Did the work come out" period="Last 30 days"><Muted>Too few sessions in the last 30 days to say yet.</Muted></Frame>}
            </div>

            <Frame
              title="What to try"
              period={`Checked again ${plan.actions.some(a => a.done) ? 'from' : 'after'} ${data?.checkAfterDays ?? 30} days`}
              answer={plan.actions.length === 0
                ? <>Nothing to suggest: this team is within reach of everything the figures look at.</>
                : <><b>{plan.actions.length.toLocaleString('en-GB')} {plan.actions.length === 1 ? 'thing' : 'things'}</b> worth trying, each tied to the figure it should move.</>}
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
