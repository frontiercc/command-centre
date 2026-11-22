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
 * case is that some of their own engineers already work this way. The one estimate, the monthly
 * cost of people who hardly use it (seat price times people), is tagged as one on the page.
 */
import type { OutputGroups } from '@/lib/pulse/code/output-groups';
import { MIN_GROUP, WINDOW_DAYS } from '@/lib/pulse/code/output-groups';
import type { DecisionRecord } from '@/lib/pulse/code/decision-log';
import type { Finds, StandardJob, Wave, RarelyUsed, KeyPeople } from '@/lib/pulse/code/so-what-finds';
import { LOOK_AGAIN_DAYS } from '@/lib/pulse/code/decision-log';
import type { TierNames } from '@/lib/pulse/tier-names';

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

/** How the cards name the two groups, from Developer Pulse's tier names. */
export interface GroupWords {
  /** The work the first group mostly does: the top two tiers, e.g. "Delegated work or Frontier delegation". */
  deep: string;
  /** The work everyone else mostly does: the first tier. */
  other: string;
}

/** Developer Pulse's shipped tier names (lib/pulse/code/classifier-prompt.ts). */
const DEFAULT_CODE_TIER_NAMES: TierNames = { t1: 'Single-step / conversational', t2: 'Delegated work', t3: 'Frontier delegation' };

export function groupWords(names?: TierNames | null): GroupWords {
  const t = names ?? DEFAULT_CODE_TIER_NAMES;
  return { deep: `${t.t2} or ${t.t3}`, other: t.t1 };
}

export interface SoWhat {
  /** Teams a leader can ask about, biggest first. */
  teams: string[];
  /** How the cards and the picture name the two groups. */
  words: GroupWords;
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

/** Why a team's figures cannot answer a question, in plain words. Null when they can. */
export function refusalFor(g: OutputGroups, w: GroupWords = groupWords()): string | null {
  if (g.verdict === 'no_output') {
    return `There is nothing to compare: nobody in the team made a commit, pull request or accepted edit in the last ${WINDOW_DAYS} days.`;
  }
  if (g.verdict === 'too_few') {
    const small = [
      g.deep.people < MIN_GROUP ? `${people(g.deep.people)} mostly ${g.deep.people === 1 ? 'does' : 'do'} ${w.deep}` : null,
      g.shallow.people < MIN_GROUP ? `${people(g.shallow.people)} mostly ${g.shallow.people === 1 ? 'does' : 'do'} ${w.other}` : null,
    ].filter(Boolean).join(' and ');
    return `Too few people to compare. Only ${small}, and comparing groups that small would single people out.`;
  }
  return null;
}

/** The people left off the picture, if any. */
function cannotSeeLine(g: OutputGroups): string {
  return g.hardly > 0 ? `${people(g.hardly)} used it too little to include.` : '';
}

const capt = () =>
  `One dot per person, last ${WINDOW_DAYS} days. Commits come from GitHub where a person's account is linked, otherwise from Claude Code and Codex.`;

/** The three counts, each with its per-person figure for both groups. */
function counts(g: OutputGroups): Array<{ name: string; deep: number; other: number }> {
  return [
    { name: 'commits', deep: g.deep.perPerson ?? 0, other: g.shallow.perPerson ?? 0, total: g.deep.commits + g.shallow.commits },
    { name: 'pull requests', deep: g.deep.prsPerPerson ?? 0, other: g.shallow.prsPerPerson ?? 0, total: g.deep.prs + g.shallow.prs },
    { name: 'accepted edits', deep: g.deep.editsPerPerson ?? 0, other: g.shallow.editsPerPerson ?? 0, total: g.deep.edits + g.shallow.edits },
  ].filter(c => c.total > 0);
}

const andList = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** What each person in each group makes, on each count that has any output. */
function outputLines(g: OutputGroups, w: GroupWords): string[] {
  const cs = counts(g);
  const list = (pick: (c: { deep: number; other: number }) => number) => andList(cs.map(c => `${round1(pick(c))} ${c.name}`));
  return [
    `The ${g.deep.people} who mostly do ${w.deep} each make ${list(c => c.deep)}.`,
    `The other ${g.shallow.people}, who mostly do ${w.other}, each make ${list(c => c.other)}.`,
  ];
}

/** When the first group is not ahead on every count: what the counts say, without a verdict they cannot give. */
function noGapLines(g: OutputGroups, w: GroupWords): string[] {
  if (g.shallow.people === 0) return [`All ${g.deep.people} people already mostly do ${w.deep}.`];
  const cs = counts(g);
  const ahead = cs.filter(c => c.deep > c.other).map(c => c.name);
  const behind = cs.filter(c => c.deep <= c.other).map(c => c.name);
  if (ahead.length === 0) {
    return [`The ${g.deep.people} who mostly do ${w.deep} get no more done than the other ${g.shallow.people}.`, 'So coaching the rest would not add much.'];
  }
  return [
    `The ${g.deep.people} who mostly do ${w.deep} make more ${andList(ahead)} each than the other ${g.shallow.people}, but no more ${andList(behind)}.`,
    'The counts do not agree, so they do not show that coaching the rest would do the work of more people.',
  ];
}

const worthLine = (g: OutputGroups, worth: number) =>
  `If the other ${g.shallow.people} worked like the first ${g.deep.people}, the team would get as much done as ${round1(worth)} more ${peopleNoun(round1(worth))}`;

/**
 * Should this team hire? Coach first when the people who do not hand work over, working like the
 * ones who do, would cover the request. Approve when there is no gap left to close.
 */
export function hireCard(g: OutputGroups, hires: number, decision: DecisionRecord | undefined, nowS: number, w: GroupWords = groupWords()): Card {
  const refusal = refusalFor(g, w);
  const worth = g.peopleWorth;
  const covers = refusal === null && worth !== null && worth >= hires;
  const asked = `${g.department} asked for ${hires} ${hires === 1 ? 'hire' : 'hires'}.`;
  const body: string[] = [];
  let headline: string;

  if (refusal !== null) {
    headline = asked;
    body.push(refusal);
  } else if (covers) {
    headline = `${asked} Coach the ${g.shallow.people} first.`;
    body.push(...outputLines(g, w), `${worthLine(g, worth!)}.`, `Look again in ${LOOK_AGAIN_DAYS} days.`);
  } else if (worth === null || worth <= 0) {
    headline = `${asked} Approve ${hires === 1 ? "it" : "them"}.`;
    body.push(...noGapLines(g, w));
  } else {
    const keep = Math.floor(worth!);
    headline = keep > 0
      ? `${asked} Hire ${hires - keep}, and coach the ${g.shallow.people} first.`
      : `${asked} Approve them, and coach the ${g.shallow.people} too.`;
    body.push(...outputLines(g, w), `${worthLine(g, worth!)}, short of the ${hires} asked for.`);
  }

  const recommended: Choice = refusal !== null ? 'go' : covers || (worth !== null && worth > 0) ? 'hold' : 'go';
  return {
    kind: 'hire',
    cardId: 'hire',
    key: `hire:${g.department}`,
    department: g.department,
    headline,
    body,
    caption: capt(),
    cannotSee: cannotSeeLine(g),
    groups: g,
    recommended,
    buttons: recommended === 'hold'
      ? { hold: 'Coach first', go: 'Hire anyway' }
      : { go: `Approve the ${hires === 1 ? 'hire' : 'hires'}`, hold: 'Hold anyway' },
    decided: decidedFrom(decision, g, nowS, w),
    refusal,
  };
}

/**
 * Someone has left. Replace them only where nothing has changed in how the team works: a team that
 * has closed its gap is already doing more with the people it has.
 */
export function backfillCard(g: OutputGroups, decision: DecisionRecord | undefined, nowS: number, w: GroupWords = groupWords()): Card {
  const refusal = refusalFor(g, w);
  const worth = g.peopleWorth;
  const closable = refusal === null && worth !== null && worth >= 1;
  const left = `Someone has left ${g.department}.`;
  const body: string[] = [];
  let headline: string;

  if (refusal !== null) {
    headline = left;
    body.push(refusal);
  } else if (closable) {
    headline = `${left} Coach the ${g.shallow.people} before replacing them.`;
    body.push(...outputLines(g, w), `${worthLine(g, worth!)}, which covers the one who left.`, `Look again in ${LOOK_AGAIN_DAYS} days.`);
  } else {
    headline = `${left} Replace them.`;
    body.push(...(worth !== null && worth > 0
      ? [...outputLines(g, w), `${worthLine(g, worth)}, less than the one who left.`]
      : noGapLines(g, w)));
  }

  const recommended: Choice = refusal !== null ? 'go' : closable ? 'hold' : 'go';
  return {
    kind: 'backfill',
    cardId: 'backfill',
    key: `backfill:${g.department}`,
    department: g.department,
    headline,
    body,
    caption: capt(),
    cannotSee: cannotSeeLine(g),
    groups: g,
    recommended,
    buttons: recommended === 'hold'
      ? { hold: 'Coach first', go: 'Replace anyway' }
      : { go: 'Replace them', hold: 'Hold anyway' },
    decided: decidedFrom(decision, g, nowS, w),
    refusal,
  };
}

/** The decided state, and the follow-up once the look-again date has passed. */
export function decidedFrom(d: DecisionRecord | undefined, g: OutputGroups, nowS: number, w: GroupWords = groupWords()): Decided | null {
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
    followUp: due ? { then, now, sentence: followUpSentence(then, now, w) } : null,
  };
}

/** What arrived since. Says "since then", never "because of", and says plainly when nothing moved. */
export function followUpSentence(then: CardFigures, now: CardFigures, w: GroupWords = groupWords()): string {
  const thenTotal = then.deepPeople + then.shallowPeople;
  const nowTotal = now.deepPeople + now.shallowPeople;
  const moved = now.deepPeople - then.deepPeople;
  const parts: string[] = [];

  if (thenTotal > 0 && nowTotal > 0) {
    parts.push(moved === 0
      ? `${now.deepPeople} of ${nowTotal} mostly ${now.deepPeople === 1 ? 'does' : 'do'} ${w.deep}, the same as then.`
      : `Since then, ${now.deepPeople} of ${nowTotal} mostly ${now.deepPeople === 1 ? 'does' : 'do'} ${w.deep}. It was ${then.deepPeople} of ${thenTotal} when you decided.`);
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
      : `Closing the gap now would be worth ${left} ${peopleNoun(left)}.`);
  }
  return parts.join(' ');
}

/** A card about everyone who does coding work, in any department, rather than one team. */
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
  // Worded from the card's current label, so decisions saved under an older label read correctly too.
  if (same) return `${now.label} is about where it was: ${fig(then)} then, ${fig(now)} now.`;
  const better = now.lowerIsBetter ? now.value < then.value : now.value > then.value;
  // Said against the card's aim, not the leader's: they may have chosen "Not now".
  return `Since then, ${now.label.toLowerCase()} has gone from ${fig(then)} to ${fig(now)}, which is ${better ? 'the way this card aimed for' : 'the opposite of what this card aimed for'}.`;
}

const fig = (m: Measure) => (m.unit === ' weeks' ? weeksWord(m.value) : `${Math.round(m.value * 10) / 10}${m.unit}`);

/** Make a recurring job the standard way: the people who hand it over whole finish it far quicker. */
export function standardJobCard(j: StandardJob, decision: DecisionRecord | undefined, nowS: number, w: GroupWords = groupWords()): Card {
  return foundCard(
    'standard_job',
    `standard_job:${j.workType}`,
    EVERYONE,
    `Make ${j.label.toLowerCase()} a standard skill.`,
    [
      `${people(j.people)} ${j.people === 1 ? 'does' : 'do'} this work. The ${j.deepPeople} who do it as ${w.deep} spend ${minutesWord(j.deepMinutes)} on it. The other ${j.shallowPeople} spend ${minutesWord(j.shallowMinutes)}.`,
      j.hoursAMonth < 1
        ? 'Moving them across frees under an hour a month.'
        : `Moving them across frees about ${Math.round(j.hoursAMonth)} ${Math.round(j.hoursAMonth) === 1 ? 'hour' : 'hours'} a month.`,
    ],
    `Measured time in the tool, last ${WINDOW_DAYS} days.`,
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
export function expandCard(waves: Wave[], decision: DecisionRecord | undefined, nowS: number, w: GroupWords = groupWords()): Card | null {
  const measured = waves.filter(w => w.weeksToHalf !== null);
  const last = measured[0];
  if (!last) return null;
  // The newest wave may not be halfway yet; then the card is about the latest one that is.
  const newest = waves[0] === last;
  const body = [
    `${newest ? 'Your last wave' : 'Your latest wave to get there'}, of ${last.people}, took ${weeksWord(last.weeksToHalf!)} for half of them to start doing ${w.deep}.`,
    `${last.reached === last.people ? (last.people === 1 ? 'They have' : `All ${last.people} have`) : `${last.reached} of the ${last.people} have`} got there so far.`,
  ];
  if (measured.length > 1) {
    const before = measured[1];
    // Compared in the words shown, so "under a week" against "under a week" never reads as longer.
    body.push(`The wave before took ${weeksWord(before.weeksToHalf!)}, so the time to get there is ${weeksWord(last.weeksToHalf ?? 0) === weeksWord(before.weeksToHalf!) || (last.weeksToHalf ?? 0) <= (before.weeksToHalf ?? 0) ? 'holding or improving' : 'getting longer'}.`);
  }
  return foundCard(
    'expand',
    'expand',
    EVERYONE,
    (last.weeksToHalf ?? 0) <= 12 ? 'Give AI coding to the next wave of people.' : 'Hold the next wave until this one lands.',
    body,
    'A wave is everyone who started in the same month.',
    { label: 'The time for half a wave to get there', value: last.weeksToHalf ?? 0, unit: ' weeks', lowerIsBetter: true },
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
    : `At the Claude seat price an admin has set, that is an estimated $${Math.round(r.costAMonth).toLocaleString('en-GB')} a month (an estimate: the seat price times these people).`);
  return foundCard(
    'rarely_used',
    'rarely_used',
    EVERYONE,
    `Decide what to do about ${r.people} ${r.people === 1 ? 'person who has' : 'people who have'} hardly used it.`,
    body,
    'Counted from sessions, over the last 90 days.',
    { label: 'The number of people who have hardly used it', value: r.people, unit: '', lowerIsBetter: true },
    decision,
    nowS,
  );
}

/** A team where one or two people hold all the handed-over work. */
export function keyPeopleCard(k: KeyPeople, decision: DecisionRecord | undefined, nowS: number, w: GroupWords = groupWords(), tool = 'Claude Code'): Card {
  return foundCard(
    'key_people',
    'key_people',
    k.department,
    `Spread what ${k.holders === 1 ? 'one person' : 'two people'} in ${k.department} ${k.holders === 1 ? 'knows' : 'know'}.`,
    [
      `${Math.round(k.share * 100)}% of the ${w.deep} done by the ${k.people.toLocaleString('en-GB')} ${k.people === 1 ? 'person' : 'people'} in ${k.department} who use ${tool} comes from ${k.holders === 1 ? 'one person' : 'two people'}.`,
      'If they leave, the team loses it.',
    ],
    `Counted from sessions over the last ${WINDOW_DAYS} days. The people are named on the team's coaching plan.`,
    { label: 'The share held by those people', value: k.share * 100, unit: '%', lowerIsBetter: true },
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
  /** Developer Pulse's tier names; the shipped names when left out. */
  tierNames?: TierNames | null;
  /** The tool the people use, as the page's view names it; Claude Code when left out. */
  tool?: string;
}

/** The page: the question at the top, and a card for each choice. */
export function buildSoWhat({ groups, decisions, asked, finds, nowS, tierNames, tool }: BuildInput): SoWhat {
  const w = groupWords(tierNames);
  const byKey = new Map(decisions.map(d => [`${d.card}:${d.department}`, d]));
  const teams = groups.map(g => g.department);
  const cards: Card[] = [];

  // Only the question that was asked is answered: a backfill card nobody asked for reads as
  // though somebody has left.
  if (asked) {
    const g = groups.find(x => x.department === asked.department);
    if (g && asked.question === 'hire') cards.push(hireCard(g, asked.hires, byKey.get(`hire:${g.department}`), nowS, w));
    if (g && asked.question === 'backfill') cards.push(backfillCard(g, byKey.get(`backfill:${g.department}`), nowS, w));
  }

  // What the page found on its own, biggest first, under whatever was asked.
  if (finds) {
    const found: Card[] = [];
    for (const j of finds.jobs) found.push(standardJobCard(j, byKey.get(`standard_job:${j.workType}:${EVERYONE}`), nowS, w));
    const expand = expandCard(finds.waves, byKey.get(`expand:${EVERYONE}`), nowS, w);
    if (expand) found.push(expand);
    if (finds.rarelyUsed) found.push(rarelyUsedCard(finds.rarelyUsed, byKey.get(`rarely_used:${EVERYONE}`), nowS));
    for (const k of finds.keyPeople) found.push(keyPeopleCard(k, byKey.get(`key_people:${k.department}`), nowS, w, tool));
    // At most MAX_FOUND undecided cards; a decided card is never dropped by the limit, so its
    // follow-up still comes back (as on Work Pulse).
    const seen = new Set<string>();
    let shown = 0;
    for (const c of found) {
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

  return { teams, words: w, asked, cards, lookAgainDays: LOOK_AGAIN_DAYS, windowDays: WINDOW_DAYS };
}
