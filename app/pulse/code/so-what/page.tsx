// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Developer Pulse, So what (admin and manager): what a leader gets if they act, priced from their
// own engineers. The leader asks a question at the top, each answer is one card, and a card they
// decide on comes back after 30 days to say what happened since.
'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { PageBody, Panel, Notice, Tag, B, cx } from '@/components/precision/ui';
import { linkCls } from '@/components/pulse/WorkPulseOverview';
import type { Card, Choice, GroupWords, SoWhat } from '@/lib/pulse/code/so-what';
import { sortLabels } from '@/lib/ui/alphabetical';

const day = (s: number) => new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const one = (v: number | null) => (v === null ? 'too few to tell' : String(Math.round(v * 10) / 10));

const PETROL = '#1F6F8B';
const PALE = '#C9DEE6';

/** A dot per person, in two groups. A count, never a person: the page carries no names. */
function Dots({ card, words }: { card: Card; words: GroupWords }) {
  const g = card.groups;
  if (!g) return null;
  const row = (label: string, count: number, perPerson: number | null, ink: string) => (
    <div className="flex items-center gap-3 flex-wrap py-1.5">
      <span className="w-[190px] shrink-0 text-[13px] text-[#333333] leading-5">{label}</span>
      <span className="flex gap-1 flex-wrap min-w-[120px]">
        {Array.from({ length: count }, (_, i) => (
          <span key={i} className="w-[10px] h-[10px] rounded-full" style={{ background: ink }} />
        ))}
        {count === 0 && <span className="text-[13px] text-[#8F8F8F]">nobody</span>}
      </span>
      <span className="ml-auto tabular-nums text-[13px] text-[#0A0A0A] whitespace-nowrap">
        {perPerson === null ? 'too few to tell' : `${one(perPerson)} commits each`}
      </span>
    </div>
  );
  const bar = (label: string, perPerson: number | null, widest: number, ink: string) => (
    <div className="grid grid-cols-[190px_minmax(0,1fr)_90px] gap-3 items-center py-[3px]">
      <span className="text-[13px] text-[#666666] leading-5">{label}</span>
      <span className="h-2 rounded-full bg-[#F2F2F2] overflow-hidden">
        <span className="block h-full rounded-full" style={{ width: `${((perPerson ?? 0) / widest) * 100}%`, background: ink }} />
      </span>
      <span className="text-right tabular-nums text-[13px]">{perPerson === null ? 'too few to tell' : one(perPerson)}</span>
    </div>
  );
  // One pair of bars per count that has any output in the team.
  const counts: Array<[string, number | null, number | null, number]> = [
    ['Commits', g.deep.perPerson, g.shallow.perPerson, g.deep.commits + g.shallow.commits],
    ['Pull requests', g.deep.prsPerPerson, g.shallow.prsPerPerson, g.deep.prs + g.shallow.prs],
    ['Accepted edits', g.deep.editsPerPerson, g.shallow.editsPerPerson, g.deep.edits + g.shallow.edits],
  ];
  return (
    <div>
      {row(`Mostly ${words.deep}`, g.deep.people, g.deep.perPerson, PETROL)}
      {row(`Mostly ${words.other}`, g.shallow.people, g.shallow.perPerson, PALE)}
      {counts.filter(([, , , total]) => total > 0).map(([label, d, sh]) => {
        const widest = Math.max(d ?? 0, sh ?? 0, 1);
        return (
          <div key={label} className="mt-2 pt-2 border-t border-[#F2F2F2]">
            {bar(`${label} each, first group`, d, widest, PETROL)}
            {bar(`${label} each, the rest`, sh, widest, PALE)}
          </div>
        );
      })}
    </div>
  );
}

function DecidedLine({ card }: { card: Card }) {
  const d = card.decided!;
  const agreed = d.chosen === d.recommended;
  return (
    <p className="m-0 text-[13px] text-[#666666]">
      Decided {day(d.at)} by {d.by}: {d.chosen === 'hold' ? card.buttons.hold.toLowerCase() : card.buttons.go.toLowerCase()}
      {agreed ? '' : ', against the recommendation'}
      {d.note ? <> &middot; &ldquo;{d.note}&rdquo;</> : null}
      {d.followUp ? null : <> &middot; back on {day(d.lookAgainAt)}</>}
    </p>
  );
}

export default function SoWhatPage() {
  // useSearchParams needs a Suspense boundary above it in an app-router page.
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <SoWhatBody />
    </Suspense>
  );
}

function SoWhatBody() {
  const params = useSearchParams();
  const [data, setData] = useState<(SoWhat & { department: string | null }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [department, setDepartment] = useState(params.get('department') ?? '');
  const [ask, setAsk] = useState<'hire' | 'backfill'>(params.get('ask') === 'backfill' ? 'backfill' : 'hire');
  const [hires, setHires] = useState(params.get('hires') ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback((dept: string, question: string, asked: string) => {
    setLoading(true);
    setError(null);
    const q = new URLSearchParams();
    if (dept) q.set('department', dept);
    q.set('ask', question);
    if (asked) q.set('hires', asked);
    fetch(`/api/pulse/code/so-what${q.toString() ? `?${q}` : ''}`)
      .then(async r => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || "Couldn't load this page. Try again.");
        return body as SoWhat & { department: string | null };
      })
      .then(d => { setData(d); setDepartment(d.department ?? ''); })
      .catch(e => { setData(null); setError(e.message); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(params.get('department') ?? '', params.get('ask') === 'backfill' ? 'backfill' : 'hire', params.get('hires') ?? '');
  }, [load, params]);

  const decide = async (card: Card, chosen: Choice | 'undo') => {
    setBusy(card.key);
    setFailed(null);
    const r = await fetch('/api/pulse/code/so-what/decisions', {
      method: chosen === 'undo' ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        card: card.cardId,
        department: card.department,
        hires: Number(hires) || 1,
        chosen: chosen === 'undo' ? 'hold' : chosen,
        note: chosen === 'undo' ? null : note || null,
      }),
    }).catch(() => null);
    // Say so when it did not save, rather than leaving the card as it was with no word.
    if (!r || !r.ok) {
      const body = r ? await r.json().catch(() => ({})) : {};
      setFailed(body.error || "That didn't save. Try again.");
    }
    setBusy(null);
    setNoteFor(null);
    setNote('');
    load(department, ask, hires);
  };

  const cards = data?.cards ?? [];

  return (
    <>
      <TopBar title="So What" subtitle="The gap between your best people and everyone else, and what closing it is worth" />
      <PageBody className="dash-compact">
        <p className="m-0 mb-3 text-[14px] leading-[21px] text-[#333333] max-w-[860px]">
          Find insights here on the gap between the people who get the most from AI and everyone else doing the same
          work, and what closing it is worth to you. Use it to decide on hiring, repeated work, rollout and reliance on
          key people.
        </p>
        <Panel>
          <div className="flex items-end gap-3 flex-wrap text-[14px]">
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] text-[#666666]">Team</span>
              <select
                value={department}
                onChange={e => { setDepartment(e.target.value); load(e.target.value, ask, hires); }}
                className={cx(B.select, 'min-w-[220px] text-[14px]')}
              >
                <option value="">Pick a team</option>
                {sortLabels(data?.teams ?? []).map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] text-[#666666]">The question</span>
              <select
                value={ask}
                onChange={e => { const v = e.target.value as 'hire' | 'backfill'; setAsk(v); load(department, v, hires); }}
                className={cx(B.select, 'min-w-[220px] text-[14px]')}
              >
                <option value="hire">They want to hire</option>
                <option value="backfill">Someone has left</option>
              </select>
            </label>
            <label className={cx('flex-col gap-1.5', ask === 'hire' ? 'flex' : 'hidden')}>
              <span className="text-[13px] text-[#666666]">People they have asked for</span>
              <input
                type="number"
                min={1}
                max={99}
                value={hires}
                onChange={e => setHires(e.target.value)}
                onBlur={() => load(department, ask, hires)}
                onKeyDown={e => { if (e.key === 'Enter') load(department, ask, hires); }}
                className={cx(B.input, 'w-[120px] text-[14px]')}
              />
            </label>
            <button type="button" onClick={() => load(department, ask, hires)} className={cx(B.primary, 'mb-[1px]')}>Answer</button>
          </div>
        </Panel>

        {loading && <LoadingSpinner />}
        {error && <Notice tone="warn" title="Not available.">{error}</Notice>}
        {failed && <Notice tone="warn" title="Not saved.">{failed}</Notice>}

        {!loading && !error && cards.length === 0 && (
          <Notice tone="info" title="Nothing asked yet.">
            Pick a team and the question you are asking.
          </Notice>
        )}

        {cards.map(card => (
          <Panel key={card.key}>
            {card.decided?.followUp && (
              <p className="m-0 mb-2 text-[12px] font-medium uppercase tracking-wide" style={{ color: PETROL }}>
                {data!.lookAgainDays} days on
              </p>
            )}
            <h2 className="m-0 text-[17px] leading-6 font-semibold text-[#0A0A0A]">{card.headline}</h2>
            {card.kind === 'rarely_used' && card.body.some(t => t.includes('estimated $')) && <span className="inline-block mt-1"><Tag tone="judged">Estimate</Tag></span>}
            {card.body.map((t, i) => (
              <p key={i} className="m-0 mt-1 text-[14px] leading-[21px] text-[#333333]">{t}</p>
            ))}

            {!card.refusal && (
              <>
                {card.groups && (
                  <div className="mt-3 pt-3 border-t border-[#F2F2F2]">
                    <Dots card={card} words={data!.words} />
                  </div>
                )}
                <p className={cx('m-0 text-[12px] text-[#8F8F8F] leading-5', card.groups ? 'mt-2' : 'mt-3')}>{card.caption}</p>
                {card.cannotSee && <p className="m-0 mt-1 text-[12px] text-[#8F8F8F] leading-5">{card.cannotSee}</p>}
                <p className="m-0 mt-1">
                  <a
                    href={card.kind === 'key_people'
                      ? `/pulse/code/coaching?department=${encodeURIComponent(card.department)}`
                      : `/pulse/code/dept${card.groups ? `?department=${encodeURIComponent(card.department)}` : ''}`}
                    className={linkCls}
                  >
                    See the work behind this
                  </a>
                </p>
              </>
            )}

            {card.decided?.followUp && (
              <div className="mt-3 pt-3 border-t border-[#EAEAEA]">
                <p className="m-0 text-[14px] leading-[21px] text-[#0A0A0A]">{card.decided.followUp.sentence}</p>
                <p className="m-0 mt-1 text-[12px] text-[#8F8F8F]">
                  What arrived since the decision. The page does not claim the decision caused it.
                </p>
              </div>
            )}

            <div className="mt-3 pt-3 border-t border-[#F2F2F2] flex items-center gap-2 flex-wrap">
              {card.decided ? (
                <>
                  <DecidedLine card={card} />
                  <button
                    type="button"
                    disabled={busy === card.key}
                    onClick={() => decide(card, 'undo')}
                    className={cx(linkCls, 'ml-auto')}
                  >
                    Undo
                  </button>
                </>
              ) : card.refusal ? (
                <span className="text-[13px] text-[#8F8F8F]">Nothing to decide until this can be answered.</span>
              ) : noteFor === card.key ? (
                <>
                  <input
                    autoFocus
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    placeholder="Why? (optional)"
                    maxLength={500}
                    className="flex-1 min-w-[200px] border border-[#DADADA] rounded-[8px] px-2 py-1 text-[13px]"
                  />
                  <button type="button" disabled={busy === card.key} onClick={() => decide(card, card.recommended)} className={B.primary}>
                    {card.recommended === 'hold' ? card.buttons.hold : card.buttons.go}
                  </button>
                  <button type="button" disabled={busy === card.key} onClick={() => decide(card, card.recommended === 'hold' ? 'go' : 'hold')} className={B.secondary}>
                    {card.recommended === 'hold' ? card.buttons.go : card.buttons.hold}
                  </button>
                </>
              ) : (
                <>
                  <button type="button" onClick={() => { setNoteFor(card.key); setNote(''); }} className={B.primary}>
                    {card.recommended === 'hold' ? card.buttons.hold : card.buttons.go}
                  </button>
                  <button type="button" onClick={() => { setNoteFor(card.key); setNote(''); }} className={B.secondary}>
                    {card.recommended === 'hold' ? card.buttons.go : card.buttons.hold}
                  </button>
                </>
              )}
            </div>
          </Panel>
        ))}
      </PageBody>
    </>
  );
}
