// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * So what (Developer Pulse, admin and manager): what a leader gets if they act, priced from their
 * own engineers. Every other page says what happened. This one says do this, get that, and it can
 * say no.
 *
 * Each choice is the same card in one of three states. The answer: a recommendation, the two
 * groups as a picture, one sentence pricing the gap, and two buttons. Decided: what was chosen,
 * with every figure as it stood that day. The follow-up, LOOK_AGAIN_DAYS later: the same figures
 * then and now, said as "since then", never "because of".
 *
 * Nothing here is an AI estimate and nothing is a benchmark from outside the customer. The whole
 * case is that some of their own engineers already work this way.
 */
import type { OutputGroups } from '@/lib/pulse/code/output-groups';
import { MIN_GROUP, WINDOW_DAYS } from '@/lib/pulse/code/output-groups';
import type { DecisionRecord } from '@/lib/pulse/code/decision-log';
import type { Finds, StandardJob, Wave, RarelyUsed, KeyPeople } from '@/lib/pulse/code/so-what-finds';
import { LOOK_AGAIN_DAYS } from '@/lib/pulse/code/decision-log';

export type CardKind = 'hire' | 'backfill' | 'standard_job' | 'expand' | 'rarely_used' | 'key_people';

/** The cards the page finds on its own, as against the ones a leader asks about. */
export const FOUND_CARDS: CardKind[] = ['standard_job', 'expand', 'rarely_used', 'key_people'];
/** At most this many found cards, biggest first. */
export const MAX_FOUND = 5;

/** What the page recommends, and what a leader can choose. */
export type Choice = 'go' | 'hold';

export interface CardFigures {
  deepPeople: number;
  shallowPeople: number;
  deepPerPerson: number | null;
  shallowPerPerson: number | null;
  peopleWorth: number | null;
  commits: number;
}

export interface Decided {
  chosen: Choice;
  recommended: Choice;
  by: string;
  at: number;
  note: string | null;
  lookAgainAt: number;
  /** Null until the look-again date has passed. */
  followUp: null | {
    then: CardFigures;
    now: CardFigures;
    /** One sentence on what arrived since. Never says the decision caused it. */
    sentence: string;
  };
}

export interface Card {
  kind: CardKind;
  /** What the decision log stores as the card: the kind, plus its subject where there can be
   *  several of one kind, so three standard jobs are three separate decisions. */
  cardId: string;
  /** cardId and team together: what the page keys a card by. */
  key: string;
  /** The team a card is about. A found card that spans the organisation uses EVERYONE. */
  department: string;
  /** The recommendation, as the headline. */
  headline: string;
  /** The sentences under it, including the one that prices the gap. */
  body: string[];
  /** What the picture is, and that it is measured. */
  caption: string;
  /** What this page cannot see. Always said, never hidden. */
  cannotSee: string;
  /** The two groups behind the card. Null on a found card that is not about one team's output. */
  groups: OutputGroups | null;
  /** The figure a found card is judged on later. Null on an asked card, which uses its groups. */
  measure?: Measure;
  recommended: Choice;
  buttons: { go: string; hold: string };
  decided: Decided | null;
  /** Set instead of a recommendation when the figures cannot answer the question. */
  refusal: string | null;
}

/** The question a leader is asking. Nothing is answered until one is picked. */
export type Question = 'hire' | 'backfill';

export interface SoWhat {
  /** Teams a leader can ask about, biggest first. */
  teams: string[];
  /** The question at the top: which team, which question, and how many engineers if hiring. */
  asked: { department: string; question: Question; hires: number } | null;
  cards: Card[];
  lookAgainDays: number;
  windowDays: number;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
/** Only exactly one is singular: 1.5 people read as a person otherwise. */
const peopleNoun = (v: number) => (v === 1 ? 'person' : 'people');
const people = (c: number) => `${c} ${c === 1 ? 'person' : 'people'}`;
const commitNoun = (c: number) => (c === 1 ? 'commit' : 'commits');

export function cardFigures(g: OutputGroups): CardFigures {
  return {
    deepPeople: g.deep.people,
    shallowPeople: g.shallow.people,
    deepPerPerson: g.deep.perPerson,
    shallowPerPerson: g.shallow.perPerson,
    peopleWorth: g.peopleWorth,
    commits: g.deep.commits + g.shallow.commits,
  };
}

/** Why a team's figures cannot answer a question, in the leader's words. Null when they can. */
export function refusalFor(g: OutputGroups): string | null {
  if (g.verdict === 'no_github') {
    return 'We cannot answer this for this team. No commits can be attributed to anyone in it, so there is nothing to compare.';
  }
  if (g.verdict === 'too_few') {
    const small = [
      g.deep.people < MIN_GROUP
        ? `${people(g.deep.people)} ${g.deep.people === 1 ? 'does' : 'do'} mostly multi-step work`
        : null,
      g.shallow.people < MIN_GROUP
        ? `${people(g.shallow.people)} ${g.shallow.people === 1 ? 'does' : 'do'} not`
        : null,
    ].filter(Boolean).join(' and ');
    return `Too few people to tell. ${small ? `${small[0].toUpperCase()}${small.slice(1)}, ` : ''}so the two groups cannot be compared without pointing at individuals.`;
  }
  return null;
}

/** What the page cannot see, said on every card. */
function cannotSeeLine(g: OutputGroups): string {
  const parts = ['We cannot see work done without Claude beyond the commits on this chart'];
  if (g.unmatched > 0) parts.push(`${people(g.unmatched)} in this team are left out because no commits can be attributed to them`);
  if (g.hardly > 0) parts.push(`${people(g.hardly)} hardly used it and are in neither group`);
  return `${parts.join('. ')}.`;
}

const capt = (g: OutputGroups) =>
  `A dot per person, and commits per person over the last ${WINDOW_DAYS} days, from GitHub. Measured. Commits made with Claude Code, with Codex and with no tool are all counted. ${g.deep.people + g.shallow.people} of ${g.people} people in the team are on the chart.`;

/**
 * Should this team hire? Hold when the people who do not hand work over, working like the ones who
 * do, would cover the request. Approve when there is no gap left to close.
 */
export function hireCard(g: OutputGroups, hires: number, decision: DecisionRecord | undefined, nowS: number): Card {
  const refusal = refusalFor(g);
  const worth = g.peopleWorth;
  const covers = refusal === null && worth !== null && worth >= hires;
  const body: string[] = [];
  let headline: string;

  if (refusal !== null) {
    headline = `${g.department} has asked for ${hires} ${hires === 1 ? 'hire' : 'hires'}.`;
    body.push(refusal);
  } else if (covers) {
    headline = `Hold the ${hires} ${hires === 1 ? 'hire' : 'hires'}. Close the gap first.`;
    body.push(
      `${g.deep.people} of ${g.deep.people + g.shallow.people} do mostly multi-step work and ship ${timesWord(g)} as much as the other ${g.shallow.people}.`,
      `If the ${g.shallow.people} worked like the ${g.deep.people}, that is the output of ${round1(worth!)} more ${peopleNoun(round1(worth!))}.`,
      `Look again in ${LOOK_AGAIN_DAYS} days.`,
    );
  } else if (worth === null || worth <= 0) {
    headline = `Approve the ${hires} ${hires === 1 ? 'hire' : 'hires'}.`;
    body.push(
      g.shallow.people === 0
        ? `All ${g.deep.people} already do mostly multi-step work.`
        : `The ${g.deep.people} who do mostly multi-step work ship no more than the ${g.shallow.people} who do not.`,
      'There is no gap to close here, so more output means more people.',
    );
  } else {
    headline = `Hold ${Math.floor(worth!)} of the ${hires}. The gap covers that much.`;
    body.push(
      `${g.deep.people} of ${g.deep.people + g.shallow.people} do mostly multi-step work and ship ${timesWord(g)} as much as the other ${g.shallow.people}.`,
      `If the ${g.shallow.people} worked like the ${g.deep.people}, that is the output of ${round1(worth!)} more ${peopleNoun(round1(worth!))}, which is short of the ${hires} asked for.`,
    );
  }

  const recommended: Choice = refusal !== null ? 'go' : covers || (worth !== null && worth > 0) ? 'hold' : 'go';
  return {
    kind: 'hire',
    cardId: 'hire',
    key: `hire:${g.department}`,
    department: g.department,
    headline,
    body,
    caption: capt(g),
    cannotSee: cannotSeeLine(g),
    groups: g,
    recommended,
    buttons: recommended === 'hold'
      ? { hold: `Hold the ${hires === 1 ? 'hire' : 'hires'}`, go: 'Hire anyway' }
      : { go: `Approve the ${hires === 1 ? 'hire' : 'hires'}`, hold: 'Hold anyway' },
    decided: decidedFrom(decision, g, nowS),
    refusal,
  };
}

/** How much more the first group ships, in words rather than a ratio nobody can picture. */
function timesWord(g: OutputGroups): string {
  const d = g.deep.perPerson ?? 0;
  const s = g.shallow.perPerson ?? 0;
  if (s <= 0) return 'more';
  const ratio = d / s;
  if (ratio >= 2.75) return `${Math.round(ratio)} times`;
  if (ratio >= 1.75) return 'twice';
  if (ratio >= 1.4) return 'half as much again';
  return `${Math.round((ratio - 1) * 100)}% more`;
}

/**
 * Someone has left. Replace them only where nothing has changed in how the team works: a team that
 * has closed its gap is already doing more with the people it has.
 */
export function backfillCard(g: OutputGroups, decision: DecisionRecord | undefined, nowS: number): Card {
  const refusal = refusalFor(g);
  const worth = g.peopleWorth;
  const closable = refusal === null && worth !== null && worth >= 1;
  const body: string[] = [];
  let headline: string;

  if (refusal !== null) {
    headline = `Someone has left ${g.department}.`;
    body.push(refusal);
  } else if (closable) {
    headline = 'Do not replace them yet.';
    body.push(
      `${g.shallow.people} of ${g.deep.people + g.shallow.people} do not do mostly multi-step work.`,
      `Closing that gap is worth ${round1(worth!)} ${peopleNoun(round1(worth!))}, which covers the one who left.`,
      `Look again in ${LOOK_AGAIN_DAYS} days.`,
    );
  } else {
    headline = 'Replace them.';
    body.push(
      'Nothing in how this team works would make up the difference.',
      'Losing one person loses one person\'s work.',
    );
  }

  const recommended: Choice = refusal !== null ? 'go' : closable ? 'hold' : 'go';
  return {
    kind: 'backfill',
    cardId: 'backfill',
    key: `backfill:${g.department}`,
    department: g.department,
    headline,
    body,
    caption: capt(g),
    cannotSee: cannotSeeLine(g),
    groups: g,
    recommended,
    buttons: recommended === 'hold'
      ? { hold: 'Do not replace', go: 'Replace anyway' }
      : { go: 'Replace them', hold: 'Hold anyway' },
    decided: decidedFrom(decision, g, nowS),
    refusal,
  };
}

/** The decided state, and the follow-up once the look-again date has passed. */
export function decidedFrom(d: DecisionRecord | undefined, g: OutputGroups, nowS: number): Decided | null {
  if (!d) return null;
  const then = d.figures as unknown as CardFigures;
  const now = cardFigures(g);
  const due = nowS >= d.lookAgainAt;
  return {
    chosen: d.chosen as Choice,
    recommended: d.recommended as Choice,
    by: d.decidedBy,
    at: d.decidedAt,
    note: d.note,
    lookAgainAt: d.lookAgainAt,
    followUp: due ? { then, now, sentence: followUpSentence(then, now) } : null,
  };
}

/** What arrived since. Says "since then", never "because of", and says plainly when nothing moved. */
export function followUpSentence(then: CardFigures, now: CardFigures): string {
  const thenTotal = then.deepPeople + then.shallowPeople;
  const nowTotal = now.deepPeople + now.shallowPeople;
  const moved = now.deepPeople - then.deepPeople;
  const parts: string[] = [];

  if (thenTotal > 0 && nowTotal > 0) {
    parts.push(moved === 0
      ? `${now.deepPeople} of ${nowTotal} do mostly multi-step work, the same as then.`
      : `Since then, ${now.deepPeople} of ${nowTotal} do mostly multi-step work. It was ${then.deepPeople} of ${thenTotal} when you decided.`);
  }
  if (then.commits > 0) {
    const change = now.commits - then.commits;
    parts.push(change === 0
      ? 'The team ships the same as it did then.'
      : `The team ships ${Math.abs(change)} ${change > 0 ? 'more' : 'fewer'} ${commitNoun(Math.abs(change))} over the window than it did then.`);
  }
  if (now.peopleWorth !== null && then.peopleWorth !== null) {
    const left = round1(now.peopleWorth);
    parts.push(left <= 0
      ? 'There is no gap left to close. Ask again.'
      : `The gap left is worth ${left} ${peopleNoun(left)}.`);
  }
  return parts.join(' ');
}

/** A card about the whole of engineering rather than one team. */
export const EVERYONE = 'Everyone';

/** The one figure a found card is judged on later, so its decision gets a follow-up too. */
export interface Measure { label: string; value: number; unit: string; lowerIsBetter: boolean }

/** The shell every found card shares: no two-group chart, one move, two buttons. */
function foundCard(
  kind: CardKind,
  cardId: string,
  department: string,
  headline: string,
  body: string[],
  caption: string,
  measure: Measure,
  decision: DecisionRecord | undefined,
  nowS: number,
): Card {
  const then = decision ? (decision.figures as { measure?: Measure }).measure : undefined;
  const due = decision ? nowS >= decision.lookAgainAt : false;
  return {
    kind,
    cardId,
    key: `${cardId}:${department}`,
    department,
    headline,
    body,
    caption,
    cannotSee: '',
    groups: null,
    recommended: 'go',
    buttons: { go: "We'll do this", hold: 'Not now' },
    measure,
    decided: decision
      ? {
          chosen: decision.chosen as Choice,
          recommended: decision.recommended as Choice,
          by: decision.decidedBy,
          at: decision.decidedAt,
          note: decision.note,
          lookAgainAt: decision.lookAgainAt,
          followUp: due && then ? { then: {} as CardFigures, now: {} as CardFigures, sentence: measureSentence(then, measure) } : null,
        }
      : null,
    refusal: null,
  };
}

/** What the card's own figure did since the decision. Never says the decision caused it. */
export function measureSentence(then: Measure, now: Measure): string {
  const same = Math.abs(now.value - then.value) < 0.05 * Math.max(Math.abs(then.value), 1);
  if (same) return `${then.label} is about where it was: ${fig(then)} then, ${fig(now)} now.`;
  const better = now.lowerIsBetter ? now.value < then.value : now.value > then.value;
  return `Since then, ${then.label.toLowerCase()} has gone from ${fig(then)} to ${fig(now)}, which is ${better ? 'the way you wanted' : 'the wrong way'}.`;
}

const fig = (m: Measure) => `${Math.round(m.value * 10) / 10}${m.unit}`;

/** Make a recurring job the standard way: the people who hand it over whole finish it far quicker. */
export function standardJobCard(j: StandardJob, decision: DecisionRecord | undefined, nowS: number): Card {
  return foundCard(
    'standard_job',
    `standard_job:${j.workType}`,
    EVERYONE,
    `Make ${j.label.toLowerCase()} a standard skill.`,
    [
      `${j.people} engineers do this work. The ${j.deepPeople} who do it as multi-step work spend ${Math.round(j.deepMinutes)} minutes on it. The other ${j.shallowPeople} spend ${minutesWord(j.shallowMinutes)}.`,
      `Moving them across frees about ${Math.round(j.hoursAMonth)} hours a month.`,
    ],
    `Measured active time on both sides, over the last ${WINDOW_DAYS} days. Not an estimate of how long the work would take by hand.`,
    { label: 'The time the slower side spends on it', value: j.shallowMinutes, unit: ' minutes', lowerIsBetter: true },
    decision,
    nowS,
  );
}

/** Weeks said the way a person would say them. Under one is not "0 weeks". */
function weeksWord(weeks: number): string {
  if (weeks < 1) return 'under a week';
  const w = Math.round(weeks * 10) / 10;
  return `${w} ${w === 1 ? 'week' : 'weeks'}`;
}

/** Minutes said the way a person would say them. */
function minutesWord(mins: number): string {
  if (mins < 90) return `${Math.round(mins)} minutes`;
  const hours = Math.round((mins / 60) * 10) / 10;
  return `${hours} hours`;
}

/** Expand to the next wave, or hold: how long the last waves took to get there. */
export function expandCard(waves: Wave[], decision: DecisionRecord | undefined, nowS: number): Card | null {
  const measured = waves.filter(w => w.weeksToHalf !== null);
  const last = measured[0];
  if (!last) return null;
  const body = [
    `Your last wave of ${last.people} took ${weeksWord(last.weeksToHalf!)} for half of them to start doing multi-step work.`,
    `${last.reached} of the ${last.people} have got there so far.`,
  ];
  if (measured.length > 1) {
    const before = measured[1];
    body.push(`The wave before took ${weeksWord(before.weeksToHalf!)}, so the time to get there is ${(last.weeksToHalf ?? 0) <= (before.weeksToHalf ?? 0) ? 'holding or improving' : 'getting longer'}.`);
  }
  return foundCard(
    'expand',
    'expand',
    EVERYONE,
    (last.weeksToHalf ?? 0) <= 12 ? 'Give Claude to the next wave of engineers.' : 'Hold the next wave until this one lands.',
    body,
    'A wave is everyone whose first session was in the same month. Measured to their first multi-step session.',
    { label: 'Weeks for half a wave to get there', value: last.weeksToHalf ?? 0, unit: ' weeks', lowerIsBetter: true },
    decision,
    nowS,
  );
}

/** People who were given it and have hardly touched it since. */
export function rarelyUsedCard(r: RarelyUsed, decision: DecisionRecord | undefined, nowS: number): Card {
  const body = [
    `${r.people} ${r.people === 1 ? 'person has' : 'people have'} had fewer than two sessions in ${r.days} days.`,
  ];
  body.push(r.costAMonth === null
    ? 'What that costs is not shown because no seat price is set on Admin → System.'
    : `At the seat price an admin has set, that is about ${Math.round(r.costAMonth).toLocaleString('en-GB')} a month.`);
  body.push('This counts people, not seats. Seats are held for the whole organisation, so the page cannot say how many a team holds.');
  return foundCard(
    'rarely_used',
    'rarely_used',
    EVERYONE,
    `Decide what to do about ${r.people} ${r.people === 1 ? 'person' : 'people'} who have hardly used it.`,
    body,
    'Counted from sessions, over the last 90 days. No card here recommends anything about a person\'s job.',
    { label: 'People who have hardly used it', value: r.people, unit: '', lowerIsBetter: true },
    decision,
    nowS,
  );
}

/** A team where one or two people hold all the handed-over work. */
export function keyPeopleCard(k: KeyPeople, decision: DecisionRecord | undefined, nowS: number): Card {
  return foundCard(
    'key_people',
    'key_people',
    k.department,
    `Spread what ${k.holders === 1 ? 'one person' : 'two people'} in ${k.department} know.`,
    [
      `${Math.round(k.share * 100)}% of the multi-step work in this team of ${k.people} comes from ${k.holders === 1 ? 'one person' : 'two people'}.`,
      'If they leave, the team loses it.',
    ],
    `Counted from sessions over the last ${WINDOW_DAYS} days. The people are named on the team's own coaching plan, not here.`,
    { label: 'Share held by those people', value: k.share * 100, unit: '%', lowerIsBetter: true },
    decision,
    nowS,
  );
}

export interface BuildInput {
  groups: OutputGroups[];
  decisions: DecisionRecord[];
  asked: { department: string; question: Question; hires: number } | null;
  /** What the page found on its own. Omitted where only the asked question matters. */
  finds?: Finds;
  nowS: number;
}

/** The page: the question at the top, and a card for each choice. */
export function buildSoWhat({ groups, decisions, asked, finds, nowS }: BuildInput): SoWhat {
  const byKey = new Map(decisions.map(d => [`${d.card}:${d.department}`, d]));
  const teams = groups.map(g => g.department);
  const cards: Card[] = [];

  // Only the question that was asked is answered: a backfill card nobody asked for reads as
  // though somebody has left.
  if (asked) {
    const g = groups.find(x => x.department === asked.department);
    if (g && asked.question === 'hire') cards.push(hireCard(g, asked.hires, byKey.get(`hire:${g.department}`), nowS));
    if (g && asked.question === 'backfill') cards.push(backfillCard(g, byKey.get(`backfill:${g.department}`), nowS));
  }

  // What the page found on its own, biggest first, under whatever was asked.
  if (finds) {
    const found: Card[] = [];
    for (const j of finds.jobs) found.push(standardJobCard(j, byKey.get(`standard_job:${j.workType}:${EVERYONE}`), nowS));
    const expand = expandCard(finds.waves, byKey.get(`expand:${EVERYONE}`), nowS);
    if (expand) found.push(expand);
    if (finds.rarelyUsed) found.push(rarelyUsedCard(finds.rarelyUsed, byKey.get(`rarely_used:${EVERYONE}`), nowS));
    for (const k of finds.keyPeople) found.push(keyPeopleCard(k, byKey.get(`key_people:${k.department}`), nowS));
    const seen = new Set<string>();
    for (const c of found) {
      if (seen.has(c.key)) continue;
      seen.add(c.key);
      cards.push(c);
      if (cards.length >= MAX_FOUND + (asked ? 1 : 0)) break;
    }
  }

  // A decision already taken comes back to the top once it is due to be looked at again.
  cards.sort((a, b) => Number(!!b.decided?.followUp) - Number(!!a.decided?.followUp));

  return { teams, asked, cards, lookAgainDays: LOOK_AGAIN_DAYS, windowDays: WINDOW_DAYS };
}
