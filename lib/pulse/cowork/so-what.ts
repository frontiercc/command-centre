// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * So What (Work Pulse, admin and manager): what a leader gets if they act, priced from their own
 * people. Every other page says what happened. This one says do this, get that, and it can say no.
 * It mirrors Developer Pulse's So What (lib/pulse/code/so-what.ts): the same card, in the same
 * three states, recorded in the same decision log.
 *
 * The answer: a recommendation, a picture, one sentence pricing the gap, and two buttons. Decided:
 * what was chosen, with every figure as it stood that day. The follow-up, LOOK_AGAIN_DAYS later:
 * the same figures then and now, said as "since then", never "because of".
 *
 * Work Pulse holds no count of how much each person produced, only whether a session produced
 * something, so no card here can say how many people a gap is worth, and the team cards say so.
 * Measured and judged figures are never added together: depth is the classifier's judgement of
 * each prompt; time and output are measured. The by-hand estimate is not used on this page.
 */
import { LOOK_AGAIN_DAYS, type DecisionRecord } from '@/lib/pulse/code/decision-log';
import { GAP_MIN, MIN_GROUP, MIN_MEASURED, WINDOW_DAYS, type WorkGroups } from '@/lib/pulse/cowork/work-groups';
import type {
  Evenings, KeyPeople, RarelyUsed, Rollout, StandardJob, TimeFreed, Wave, WorkFinds,
} from '@/lib/pulse/cowork/so-what-finds';
import { MEANINGFUL_WORK } from '@/lib/pulse/cowork/coaching-words';

export type CardKind = 'hire' | 'backfill' | 'standard_job' | 'expand' | 'rarely_used' | 'key_people' | 'rollout' | 'time_freed' | 'evenings';

/** The cards the page finds on its own, in the order they are listed when they touch as many people. */
export const FOUND_CARDS: CardKind[] = ['standard_job', 'time_freed', 'expand', 'rarely_used', 'key_people', 'rollout', 'evenings'];
/** At most this many found cards, biggest first, as on Developer Pulse. */
export const MAX_FOUND = 5;
/**
 * Work Pulse's decisions share the decision log with Developer Pulse's, so each card id is stored
 * with this in front of it. Developer Pulse never reads a card that starts with it.
 */
export const DECISION_PREFIX = 'work.';

/** What the page recommends, and what a leader can choose. */
export type Choice = 'go' | 'hold';

/** What an asked card freezes the day it is decided. */
export interface CardFigures {
  deepPeople: number;
  shallowPeople: number;
  deepShare: number | null;
  shallowShare: number | null;
}

/** The one figure a found card is judged on later, so its decision gets a follow-up too. */
export interface Measure { label: string; value: number; unit: string; lowerIsBetter: boolean }

export interface Decided {
  chosen: Choice;
  recommended: Choice;
  by: string;
  at: number;
  note: string | null;
  lookAgainAt: number;
  /** Null until the look-again date has passed. */
  followUp: null | { sentence: string };
}

export interface Card {
  kind: CardKind;
  /** The card as the decision log knows it, without DECISION_PREFIX: the kind, plus its subject
   *  where there can be several of one kind. */
  cardId: string;
  /** cardId and team together: what the page keys a card by. */
  key: string;
  /** The team a card is about. A card about the whole organisation uses EVERYONE. */
  department: string;
  /** How many people the decision touches: the found cards are listed biggest first by it. */
  touches: number;
  headline: string;
  body: string[];
  /** What the picture or the figures are, and whether they are measured or judged. */
  caption: string;
  /** What this page cannot see. Said wherever it applies. */
  cannotSee: string;
  /** The two groups behind a team card. */
  groups: WorkGroups | null;
  measure?: Measure;
  recommended: Choice;
  buttons: { go: string; hold: string };
  decided: Decided | null;
  /** Set instead of a recommendation when the figures cannot answer the question. */
  refusal: string | null;
  /** Where the work behind the card is. */
  link: string;
}

export type Question = 'hire' | 'backfill';

export interface SoWhat {
  /** Teams a leader can ask about, biggest first. */
  teams: string[];
  asked: { department: string; question: Question; hires: number } | null;
  cards: Card[];
  lookAgainDays: number;
  windowDays: number;
}

/** A card about the whole organisation rather than one team. */
export const EVERYONE = 'Everyone';

const people = (c: number) => `${c} ${c === 1 ? 'person' : 'people'}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const hiresWord = (h: number) => (h === 1 ? 'hire' : 'hires');
const dateWord = (s: number) => new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
const teamLink = (d: string) => `/pulse/coaching?department=${encodeURIComponent(d)}`;

export function cardFigures(g: WorkGroups): CardFigures {
  return { deepPeople: g.deep.people, shallowPeople: g.shallow.people, deepShare: g.deep.share, shallowShare: g.shallow.share };
}

/** Why a team's figures cannot answer a question, in the leader's words. Null when they can. */
export function refusalFor(g: WorkGroups): string | null {
  if (g.verdict === 'too_few') {
    const small = [
      g.deep.people < MIN_GROUP ? `${people(g.deep.people)} ${g.deep.people === 1 ? 'does' : 'do'} mostly ${MEANINGFUL_WORK}` : null,
      g.shallow.people < MIN_GROUP ? `${people(g.shallow.people)} ${g.shallow.people === 1 ? 'does' : 'do'} not` : null,
    ].filter(Boolean).join(' and ');
    return `Too few people to tell. ${small ? `${small[0].toUpperCase()}${small.slice(1)}, ` : ''}so the two groups cannot be compared without pointing at individuals.`;
  }
  if (g.verdict === 'not_measured') {
    return `Too little was measured to tell. Each group needs at least ${MIN_MEASURED} sessions where Command Centre could see whether something was produced.`;
  }
  return null;
}

function cannotSeeLine(g: WorkGroups): string {
  const parts = ['Work Pulse cannot count how much each person produces, only whether a session produced something, so it cannot say how many people a gap is worth'];
  if (g.light > 0) parts.push(`${people(g.light)} used it too little to judge and ${g.light === 1 ? 'is' : 'are'} in neither group`);
  if (g.hardly > 0) parts.push(`${people(g.hardly)} hardly used it and ${g.hardly === 1 ? 'is' : 'are'} in neither group`);
  return `${parts.join('. ')}.`;
}

const groupsCaption = (g: WorkGroups) =>
  `A dot per person. The bars are the share of each group's sessions over the last ${WINDOW_DAYS} days that produced something: a file saved, sent or published, an artifact or file in Claude Chat, a file listed on a ChatGPT reply. Measured, and a floor: a file was made, not that anyone used it. ${g.deep.measured + g.shallow.measured} sessions were measured.`;

/** The gap, said with both shares. */
function gapSentence(g: WorkGroups): string {
  return `${g.deep.people} of ${g.deep.people + g.shallow.people} do mostly ${MEANINGFUL_WORK}. Their sessions produced something ${pct(g.deep.share!)} of the time. For the other ${g.shallow.people} it was ${pct(g.shallow.share!)}.`;
}

/** Why there is no gap, said with both shares and never rounder than the figures are. */
function noGapSentence(g: WorkGroups): string {
  if (g.shallow.people === 0) return `All ${g.deep.people} already do mostly ${MEANINGFUL_WORK}.`;
  const both = `(${pct(g.deep.share!)} against ${pct(g.shallow.share!)})`;
  const first = `The ${g.deep.people} who do mostly ${MEANINGFUL_WORK}`;
  const second = `the ${g.shallow.people} who do not`;
  return g.gap !== null && g.gap > 0
    ? `${first} produce something a little more often than ${second} ${both}, a difference under ${Math.round(GAP_MIN * 100)} points.`
    : `${first} produce something no more often than ${second} ${both}.`;
}

/** Should this team hire? Hold while there is a gap to close; approve when there is none. */
export function hireCard(g: WorkGroups, hires: number, decision: DecisionRecord | undefined, nowS: number): Card {
  const refusal = refusalFor(g);
  const gap = refusal === null && g.gap !== null && g.gap >= GAP_MIN;
  const body: string[] = [];
  let headline: string;
  if (refusal !== null) {
    headline = `${g.department} has asked for ${hires} ${hiresWord(hires)}.`;
    body.push(refusal);
  } else if (gap) {
    headline = `Hold the ${hires} ${hiresWord(hires)}. Close the gap first.`;
    body.push(gapSentence(g), 'We cannot count how much each person produces, so we cannot say how many hires closing the gap is worth.', `Look again in ${LOOK_AGAIN_DAYS} days.`);
  } else {
    headline = `Approve the ${hires} ${hiresWord(hires)}.`;
    body.push(noGapSentence(g), 'There is no gap to close here, so more output means more people.');
  }
  const recommended: Choice = refusal === null && gap ? 'hold' : 'go';
  return {
    kind: 'hire', cardId: 'hire', key: `hire:${g.department}`, department: g.department, touches: g.people,
    headline, body, caption: groupsCaption(g), cannotSee: cannotSeeLine(g), groups: g,
    recommended,
    buttons: recommended === 'hold'
      ? { hold: `Hold the ${hiresWord(hires)}`, go: 'Hire anyway' }
      : { go: `Approve the ${hiresWord(hires)}`, hold: 'Hold anyway' },
    decided: decidedFrom(decision, g, nowS),
    refusal,
    link: `/pulse/dept?dept=${encodeURIComponent(g.department)}`,
  };
}

/** Someone has left. Replace them unless there is a gap the team could close first. */
export function backfillCard(g: WorkGroups, decision: DecisionRecord | undefined, nowS: number): Card {
  const refusal = refusalFor(g);
  const gap = refusal === null && g.gap !== null && g.gap >= GAP_MIN;
  const body: string[] = [];
  let headline: string;
  if (refusal !== null) {
    headline = `Someone has left ${g.department}.`;
    body.push(refusal);
  } else if (gap) {
    headline = 'Do not replace them yet. Close the gap first.';
    body.push(gapSentence(g), 'We cannot count how much each person produces, so we cannot say whether closing the gap covers the one who left.', `Look again in ${LOOK_AGAIN_DAYS} days.`);
  } else {
    headline = 'Replace them.';
    body.push('Nothing in how this team works would make up the difference.', "Losing one person loses one person's work.");
  }
  const recommended: Choice = refusal === null && gap ? 'hold' : 'go';
  return {
    kind: 'backfill', cardId: 'backfill', key: `backfill:${g.department}`, department: g.department, touches: g.people,
    headline, body, caption: groupsCaption(g), cannotSee: cannotSeeLine(g), groups: g,
    recommended,
    buttons: recommended === 'hold' ? { hold: 'Do not replace', go: 'Replace anyway' } : { go: 'Replace them', hold: 'Hold anyway' },
    decided: decidedFrom(decision, g, nowS),
    refusal,
    link: `/pulse/dept?dept=${encodeURIComponent(g.department)}`,
  };
}

/** The decided state of an asked card, and the follow-up once the look-again date has passed. */
export function decidedFrom(d: DecisionRecord | undefined, g: WorkGroups, nowS: number): Decided | null {
  if (!d) return null;
  const then = d.figures as unknown as CardFigures;
  return {
    chosen: d.chosen as Choice,
    recommended: d.recommended as Choice,
    by: d.decidedBy,
    at: d.decidedAt,
    note: d.note,
    lookAgainAt: d.lookAgainAt,
    followUp: nowS >= d.lookAgainAt ? { sentence: followUpSentence(then, cardFigures(g)) } : null,
  };
}

/** What arrived since. Says "since then", never "because of", and says plainly when nothing moved. */
export function followUpSentence(then: CardFigures, now: CardFigures): string {
  const thenTotal = then.deepPeople + then.shallowPeople;
  const nowTotal = now.deepPeople + now.shallowPeople;
  const parts: string[] = [];
  if (thenTotal > 0 && nowTotal > 0) {
    parts.push(now.deepPeople === then.deepPeople
      ? `${now.deepPeople} of ${nowTotal} do mostly ${MEANINGFUL_WORK}, the same as then.`
      : `Since then, ${now.deepPeople} of ${nowTotal} do mostly ${MEANINGFUL_WORK}. It was ${then.deepPeople} of ${thenTotal} when you decided.`);
  }
  if (then.shallowShare !== null && now.shallowShare !== null) {
    const moved = Math.round((now.shallowShare - then.shallowShare) * 100);
    parts.push(moved === 0
      ? `The other group's sessions produce something as often as they did, ${pct(now.shallowShare)} of the time.`
      : `The other group's sessions produced something ${pct(now.shallowShare)} of the time, against ${pct(then.shallowShare)} then.`);
  } else {
    parts.push('Too little is measured now to compare what the sessions produced.');
  }
  return parts.join(' ');
}

/** What the card's own figure did since the decision. Never says the decision caused it. */
export function measureSentence(then: Measure, now: Measure): string {
  const same = Math.abs(now.value - then.value) < 0.05 * Math.max(Math.abs(then.value), 1);
  if (same) return `${then.label} is about where it was: ${fig(then)} then, ${fig(now)} now.`;
  const better = now.lowerIsBetter ? now.value < then.value : now.value > then.value;
  return `Since then, ${then.label.toLowerCase()} has gone from ${fig(then)} to ${fig(now)}, which is ${better ? 'the way you wanted' : 'the wrong way'}.`;
}

const fig = (m: Measure) => (m.unit === ' weeks' ? weeksWord(m.value) : `${Math.round(m.value * 10) / 10}${m.unit}`);

interface FoundShell {
  kind: CardKind;
  cardId: string;
  department: string;
  touches: number;
  headline: string;
  body: string[];
  caption: string;
  measure: Measure;
  link: string;
  recommended?: Choice;
  buttons?: { go: string; hold: string };
  cannotSee?: string;
}

/** The shell every found card shares: one move, two buttons, and a follow-up on its own figure. */
function foundCard(c: FoundShell, decision: DecisionRecord | undefined, nowS: number): Card {
  const then = decision ? (decision.figures as { measure?: Measure }).measure : undefined;
  const due = decision ? nowS >= decision.lookAgainAt : false;
  return {
    kind: c.kind,
    cardId: c.cardId,
    key: `${c.cardId}:${c.department}`,
    department: c.department,
    touches: c.touches,
    headline: c.headline,
    body: c.body,
    caption: c.caption,
    cannotSee: c.cannotSee ?? '',
    groups: null,
    measure: c.measure,
    recommended: c.recommended ?? 'go',
    buttons: c.buttons ?? { go: "We'll do this", hold: 'Not now' },
    decided: decision
      ? {
          chosen: decision.chosen as Choice,
          recommended: decision.recommended as Choice,
          by: decision.decidedBy,
          at: decision.decidedAt,
          note: decision.note,
          lookAgainAt: decision.lookAgainAt,
          followUp: due && then ? { sentence: measureSentence(then, c.measure) } : null,
        }
      : null,
    refusal: null,
    link: c.link,
  };
}

/** Minutes said the way a person would say them. */
function minutesWord(mins: number): string {
  if (mins < 90) return `${Math.round(mins)} ${Math.round(mins) === 1 ? 'minute' : 'minutes'}`;
  return `${Math.round((mins / 60) * 10) / 10} hours`;
}

/** Weeks said the way a person would say them. Under one is not "0 weeks". */
function weeksWord(weeks: number): string {
  if (weeks < 1) return 'under a week';
  const w = Math.round(weeks * 10) / 10;
  return `${w} ${w === 1 ? 'week' : 'weeks'}`;
}

/** Make a kind of work several people repeat with no skill behind it the standard way. */
export function standardJobCard(j: StandardJob, decision: DecisionRecord | undefined, nowS: number): Card {
  const body = [
    `${j.people} people in ${j.department} did ${j.label} ${j.prompts} times in the last ${WINDOW_DAYS} days, across ${j.sessions} ${j.sessions === 1 ? 'session' : 'sessions'}. None of them used a skill.`,
  ];
  if (j.measuredHours !== null) body.push(`It took ${minutesWord(j.measuredHours * 60)} of measured time.`);
  if (j.deepMinutes !== null && j.otherMinutes !== null) {
    body.push(`Done as ${MEANINGFUL_WORK}, a session of it took ${minutesWord(j.deepMinutes)}. Otherwise it took ${minutesWord(j.otherMinutes)}.`);
  }
  return foundCard({
    kind: 'standard_job',
    cardId: `standard_job:${j.taskType}`,
    department: j.department,
    touches: j.people,
    headline: `Make ${j.label} a standard skill in ${j.department}.`,
    body,
    caption: `Counted from prompts over the last ${WINDOW_DAYS} days. Times are measured active time, not an estimate of how long the work would take by hand. The kind of work is the classifier's judgement of each prompt.`,
    measure: { label: 'The share of its sessions that used a skill', value: j.skillShare * 100, unit: '%', lowerIsBetter: false },
    link: teamLink(j.department),
  }, decision, nowS);
}

/** Give it to the next wave of people, or hold: how long the last waves took to get there. */
export function expandCard(waves: Wave[], decision: DecisionRecord | undefined, nowS: number): Card | null {
  const measured = waves.filter(w => w.weeksToHalf !== null);
  const last = measured[0];
  if (!last) return null;
  const body = [
    `Your last wave of ${last.people} took ${weeksWord(last.weeksToHalf!)} for half of them to start doing ${MEANINGFUL_WORK}.`,
    `${last.reached} of the ${last.people} have got there so far.`,
  ];
  if (measured.length > 1) {
    const before = measured[1];
    body.push(`The wave before took ${weeksWord(before.weeksToHalf!)}, so the time to get there is ${(last.weeksToHalf ?? 0) <= (before.weeksToHalf ?? 0) ? 'holding or improving' : 'getting longer'}.`);
  }
  return foundCard({
    kind: 'expand',
    cardId: 'expand',
    department: EVERYONE,
    touches: last.people,
    headline: (last.weeksToHalf ?? 0) <= 12 ? 'Give AI to the next wave of people.' : 'Hold the next wave until this one lands.',
    body,
    caption: `A wave is everyone whose first prompt was in the same month. Measured to their first prompt the classifier judged ${MEANINGFUL_WORK} or better.`,
    measure: { label: 'Weeks for half a wave to get there', value: last.weeksToHalf ?? 0, unit: ' weeks', lowerIsBetter: true },
    link: '/pulse/cio',
  }, decision, nowS);
}

/** People who were given it and have hardly used it since. */
export function rarelyUsedCard(r: RarelyUsed, decision: DecisionRecord | undefined, nowS: number): Card {
  const body = [`${r.people} ${r.people === 1 ? 'person has' : 'people have'} had fewer than two sessions in ${r.days} days.`];
  body.push(r.costAMonth === null
    ? 'What that costs is not shown because no seat price is set on Admin → System.'
    : `At the seat price an admin has set, that is about ${Math.round(r.costAMonth).toLocaleString('en-GB')} a month.`);
  body.push('This counts people, not seats. Seats are held for the whole organisation, so the page cannot say how many a team holds.');
  return foundCard({
    kind: 'rarely_used',
    cardId: 'rarely_used',
    department: EVERYONE,
    touches: r.people,
    headline: `Decide what to do about ${people(r.people)} who ${r.people === 1 ? 'has' : 'have'} hardly used it.`,
    body,
    caption: `Counted from sessions, over the last ${r.days} days. No card here recommends anything about a person's job.`,
    measure: { label: 'People who have hardly used it', value: r.people, unit: '', lowerIsBetter: true },
    link: '/pulse/coaching',
  }, decision, nowS);
}

/** A team where one or two people hold most of the meaningful work. */
export function keyPeopleCard(k: KeyPeople, decision: DecisionRecord | undefined, nowS: number): Card {
  const who = k.holders === 1 ? 'one person' : 'two people';
  const body = [`${pct(k.share)} of the ${MEANINGFUL_WORK} in this team of ${k.people} comes from ${who}.`];
  if (k.soloKinds > 0) {
    body.push(`${k.soloKinds === 1 ? 'One kind' : `${k.soloKinds} kinds`} of work in the team ${k.soloKinds === 1 ? 'is' : 'are'} done by one person alone.`);
  }
  body.push('If they leave, the team loses how it is done.');
  return foundCard({
    kind: 'key_people',
    cardId: 'key_people',
    department: k.department,
    touches: k.people,
    headline: `Spread what ${who} in ${k.department} know.`,
    body,
    caption: `Counted from prompts over the last ${WINDOW_DAYS} days. Whether a prompt was ${MEANINGFUL_WORK} is the classifier's judgement. The people are named on the team's own coaching plan, not here.`,
    measure: { label: 'Share held by those people', value: k.share * 100, unit: '%', lowerIsBetter: true },
    link: teamLink(k.department),
  }, decision, nowS);
}

/** A new way of working one team confirmed, where other teams do the same kind of work. */
export function rolloutCard(r: Rollout, decision: DecisionRecord | undefined, nowS: number): Card {
  return foundCard({
    kind: 'rollout',
    cardId: `rollout:${r.eventId}`,
    department: r.department,
    touches: r.people,
    headline: `Take "${r.title.trim()}" from ${r.department} to ${r.teams} more ${r.teams === 1 ? 'team' : 'teams'}.`,
    body: [
      `A manager confirmed it as a new way of working in ${r.department} on ${dateWord(r.confirmedAt)}.`,
      `${people(r.people)} in ${r.teams} other ${r.teams === 1 ? 'team' : 'teams'} did the same kind of work, ${r.label}, in the last ${WINDOW_DAYS} days.`,
    ],
    caption: `Confirmed on New ways of working. The kind of work is the classifier's judgement of the prompt it was found in. People are counted from prompts.`,
    measure: { label: 'Teams with a confirmed way of working for it', value: r.teamsWithOne, unit: '', lowerIsBetter: false },
    link: '/pulse/cio',
  }, decision, nowS);
}

/** A kind of work a team now does far quicker: decide what the freed time goes on. */
export function timeFreedCard(t: TimeFreed, decision: DecisionRecord | undefined, nowS: number): Card {
  return foundCard({
    kind: 'time_freed',
    cardId: `time_freed:${t.taskType}`,
    department: t.department,
    touches: t.people,
    headline: `Decide what ${t.department} does with the time ${t.label} has freed.`,
    body: [
      `A session of ${t.label} now takes ${minutesWord(t.nowMinutes)}, down from ${minutesWord(t.beforeMinutes)} in the ${WINDOW_DAYS} days to ${dateWord(t.beforeFrom + WINDOW_DAYS * 86400)}.`,
      `At ${t.sessions} ${t.sessions === 1 ? 'session' : 'sessions'} a month, that is about ${minutesWord(t.hoursAMonth * 60)} a month the team has back.`,
      'Decide where it goes: work the team has not had time for, or a team that is short of time.',
    ],
    caption: `Measured time in the tool over the last ${WINDOW_DAYS} days, against the ${WINDOW_DAYS} days that ended two months ago. It shows the work got quicker, not that less of it was done, and it cannot see time spent outside the tool. The kind of work is the classifier's judgement.`,
    measure: { label: 'Minutes a session', value: t.nowMinutes, unit: ' minutes', lowerIsBetter: true },
    link: teamLink(t.department),
    buttons: { go: 'Plan for the time', hold: 'Not now' },
  }, decision, nowS);
}

/** A team doing far more of its AI work out of hours than the organisation. Counts only. */
export function eveningsCard(e: Evenings, decision: DecisionRecord | undefined, nowS: number): Card {
  return foundCard({
    kind: 'evenings',
    cardId: 'evenings',
    department: e.department,
    touches: e.people,
    headline: `Look at the workload in ${e.department}.`,
    body: [
      `${pct(e.share)} of the AI work in ${e.department} in the last ${WINDOW_DAYS} days was in the evening or at the weekend, against ${pct(e.orgShare)} across the organisation.`,
      `${e.peopleOutOfHours} of the ${e.people} people in the team did some of it then.`,
      'It may be choice, deadlines or too much work. Asking the team is the way to know.',
    ],
    caption: `Measured from when each prompt was sent, in ${e.timezone} time: weekdays before 7am or from 7pm, and weekends. A count for the team, never about one person.`,
    measure: { label: 'The share of its AI work out of hours', value: e.share * 100, unit: '%', lowerIsBetter: true },
    link: teamLink(e.department),
    buttons: { go: 'Look into it', hold: 'Not now' },
  }, decision, nowS);
}

export interface BuildInput {
  groups: WorkGroups[];
  /** Work Pulse's decisions, with DECISION_PREFIX already taken off their card ids. */
  decisions: DecisionRecord[];
  asked: { department: string; question: Question; hires: number } | null;
  /** What the page found on its own. Omitted where only the asked question matters. */
  finds?: WorkFinds;
  nowS: number;
}

/** The page: the question at the top, and a card for each choice, biggest first. */
export function buildSoWhat({ groups, decisions, asked, finds, nowS }: BuildInput): SoWhat {
  const byKey = new Map(decisions.map(d => [`${d.card}:${d.department}`, d]));
  const cards: Card[] = [];

  // Only the question that was asked is answered: a backfill card nobody asked for reads as
  // though somebody has left.
  if (asked) {
    const g = groups.find(x => x.department === asked.department);
    if (g && asked.question === 'hire') cards.push(hireCard(g, asked.hires, byKey.get(`hire:${g.department}`), nowS));
    if (g && asked.question === 'backfill') cards.push(backfillCard(g, byKey.get(`backfill:${g.department}`), nowS));
  }

  if (finds) {
    const found: Card[] = [];
    for (const j of finds.jobs) found.push(standardJobCard(j, byKey.get(`standard_job:${j.taskType}:${j.department}`), nowS));
    const expand = expandCard(finds.waves, byKey.get(`expand:${EVERYONE}`), nowS);
    if (expand) found.push(expand);
    if (finds.rarelyUsed) found.push(rarelyUsedCard(finds.rarelyUsed, byKey.get(`rarely_used:${EVERYONE}`), nowS));
    for (const k of finds.keyPeople) found.push(keyPeopleCard(k, byKey.get(`key_people:${k.department}`), nowS));
    for (const r of finds.rollouts) found.push(rolloutCard(r, byKey.get(`rollout:${r.eventId}:${r.department}`), nowS));
    for (const t of finds.timeFreed) found.push(timeFreedCard(t, byKey.get(`time_freed:${t.taskType}:${t.department}`), nowS));
    for (const e of finds.evenings) found.push(eveningsCard(e, byKey.get(`evenings:${e.department}`), nowS));
    // Biggest first by how many people the decision touches; a tie keeps the order above, so a
    // recurring job leads. A decision due its follow-up is never dropped by the limit.
    const order = (c: Card) => FOUND_CARDS.indexOf(c.kind);
    const ranked = found
      .map((c, i) => ({ c, i }))
      .sort((a, b) => b.c.touches - a.c.touches || order(a.c) - order(b.c) || a.i - b.i)
      .map(x => x.c);
    const seen = new Set<string>();
    let shown = 0;
    for (const c of ranked) {
      if (seen.has(c.key)) continue;
      seen.add(c.key);
      if (shown < MAX_FOUND || c.decided) {
        cards.push(c);
        if (!c.decided) shown++;
      }
    }
  }

  // A decision already taken comes back to the top once it is due to be looked at again.
  cards.sort((a, b) => Number(!!b.decided?.followUp) - Number(!!a.decided?.followUp));

  return { teams: groups.map(g => g.department), asked, cards, lookAgainDays: LOOK_AGAIN_DAYS, windowDays: WINDOW_DAYS };
}

/** The decision log's rows that belong to Work Pulse, with DECISION_PREFIX taken off. */
export function workDecisions(all: DecisionRecord[]): DecisionRecord[] {
  return all.filter(d => d.card.startsWith(DECISION_PREFIX)).map(d => ({ ...d, card: d.card.slice(DECISION_PREFIX.length) }));
}
