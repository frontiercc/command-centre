// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The number check every briefing now goes through.
// Modelled on a real 6 September Code briefing: a share the model worked
// out wrongly ("28%" where the data gave 35%) and a total it invented.
import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  allowedNumbersFrom, checkGroundedJson, createGroundedJson, GroundingRejectedError,
  numberWordsIn, paragraphsShape, pctChange, pctOf, splitSentences,
} from '@/lib/anthropic/grounded-json';

const DATA = 'work_mix (154 classified sessions in total): feature=107 (69%), bugfix=19 (12%)\nai_assisted_share_of_shipped_commits=35%\nspend_usd=1234.56';
const shape = paragraphsShape(1, ['suggestion'] as const);
const reply = (paragraphs: string[], suggestion = 'Keep going.') => JSON.stringify({ paragraphs, suggestion });

function fakeClient(replies: Array<string | Error>) {
  const calls: string[] = [];
  const client = {
    messages: {
      create: vi.fn(async (p: { messages: Array<{ content: string }> }) => {
        calls.push(p.messages[0].content);
        const r = replies.shift();
        if (r instanceof Error) throw r;
        return { content: [{ type: 'text', text: r ?? '' }] };
      }),
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe('checkGroundedJson', () => {
  const allowed = allowedNumbersFrom(DATA);

  it('accepts numbers from the data, including rounded forms', () => {
    const r = checkGroundedJson(reply(['Of 154 sessions, 107 were features (69%); spend was $1,235 and 35% of commits were AI-assisted.']), allowed, shape);
    expect(r.ok).toBe(true);
  });

  it('rejects a share the model worked out itself, and a total that does not add up', () => {
    const r = checkGroundedJson(reply(['28% of commits were AI-assisted across 135 sessions.']), allowed, shape);
    expect(r).toEqual({ ok: false, reasons: ['it used numbers that are not in the data (28, 135)'] });
  });

  it('checks the suggestion as well as the paragraphs', () => {
    expect(checkGroundedJson(reply(['Fine.'], 'Aim for 50% next week.'), allowed, shape).ok).toBe(false);
  });

  it('accepts a fenced block after a preamble, and refuses a wrong shape', () => {
    expect(checkGroundedJson('Here you go:\n```json\n' + reply(['107 features.']) + '\n```', allowed, shape).ok).toBe(true);
    expect(checkGroundedJson('{"text":"no paragraphs"}', allowed, shape).ok).toBe(false);
    expect(checkGroundedJson('not json', allowed, shape).ok).toBe(false);
  });

  it('allows a number the model is meant to author (a risk score)', () => {
    const s = { parse: (o: unknown) => o as { score: number; text: string }, texts: (v: { text: string }) => [v.text], extraAllowed: (v: { score: number }) => [v.score] };
    expect(checkGroundedJson('{"score":27,"text":"Risk is 27."}', allowed, s).ok).toBe(true);
  });
});

describe('number words', () => {
  const allowed = allowedNumbersFrom(DATA);
  it('reads number words as digits, but not "one" or vague words', () => {
    expect(numberWordsIn('Four people ran twenty-five sessions over two weeks.')).toEqual(['4', '25', '2']);
    expect(numberWordsIn('One concrete action: half of them, a few twice.')).toEqual([]);
  });
  it('a number word must be in the data like a digit', () => {
    // 107 and 19 are in the data; "nineteen" matches 19, "twelve" matches 12 (a share), "forty" does not.
    expect(checkGroundedJson(reply(['Nineteen bug fixes.']), allowed, shape).ok).toBe(true);
    expect(checkGroundedJson(reply(['Forty sessions were features.']), allowed, shape)).toEqual({ ok: false, reasons: ['it used numbers that are not in the data (40)'] });
  });
});

describe('createGroundedJson', () => {
  const base = { model: 'm', maxTokens: 100, system: 'Use only the numbers given.', userMessage: DATA, ...shape };

  it('accepts a good first reply in one call', async () => {
    const { client, calls } = fakeClient([reply(['107 features out of 154.'])]);
    const r = await createGroundedJson({ ...base, client });
    expect(r.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('retries once with the offending numbers, and accepts a fixed reply', async () => {
    const { client, calls } = fakeClient([reply(['28% AI-assisted.']), reply(['35% AI-assisted.'])]);
    const r = await createGroundedJson({ ...base, client });
    expect(r.attempts).toBe(2);
    expect(calls[1]).toContain('not in the data (28)');
    expect(r.value.paragraphs[0]).toBe('35% AI-assisted.');
  });

  it('throws GroundingRejectedError after two refused replies, never a third call', async () => {
    const { client, calls } = fakeClient([reply(['28%.']), reply(['29%.'])]);
    await expect(createGroundedJson({ ...base, client })).rejects.toBeInstanceOf(GroundingRejectedError);
    expect(calls).toHaveLength(2);
  });

  // The Code briefing and 5 personal briefings failed a week's run;
  // the same Code briefing passed first time when run again, so refusals are chance events.
  it('with cycles: 2, tries a fresh reply after a refused cycle and accepts it', async () => {
    const { client, calls } = fakeClient([reply(['28%.']), reply(['29%.']), reply(['107 features out of 154.'])]);
    const r = await createGroundedJson({ ...base, client, cycles: 2 });
    expect(r.value.paragraphs[0]).toBe('107 features out of 154.');
    expect(calls).toHaveLength(3);
    expect(calls[2]).not.toContain('not accepted'); // a fresh reply, not another retry
  });

  it('with cycles: 2, still throws when both cycles are refused, after four calls at most', async () => {
    const { client, calls } = fakeClient([reply(['28%.']), reply(['29%.']), reply(['30%.']), reply(['31%.'])]);
    await expect(createGroundedJson({ ...base, client, cycles: 2 })).rejects.toBeInstanceOf(GroundingRejectedError);
    expect(calls).toHaveLength(4);
  });

  // 12 personal briefings and the Code briefing failed
  // because the model COUNTED a list it was given ("You used
  // seven task types: ..."). After the retry, only the offending sentence goes.
  it('after a refused retry, drops only the sentences with unchecked numbers and keeps the rest', async () => {
    const { client, calls } = fakeClient([
      reply(['You used seven task types. 107 features out of 154.']),
      reply(['107 features out of 154. You used seven task types across the week.', 'Spend was 1234.56 dollars.'], 'Try 3 new things.'),
    ]);
    const r = await createGroundedJson({ ...base, client });
    expect(calls).toHaveLength(2);
    expect(r.trimmed).toBe(true);
    expect(r.value.paragraphs).toEqual(['107 features out of 154.', 'Spend was 1234.56 dollars.']);
    expect(r.value.suggestion).toBeUndefined(); // it carried an unchecked 3
  });

  it('refuses a retry that is mostly unchecked rather than keep a stub', async () => {
    const { client } = fakeClient([reply(['28%.']), reply(['28% share. 29 more. 107 of 154.'])]);
    await expect(createGroundedJson({ ...base, client })).rejects.toBeInstanceOf(GroundingRejectedError);
  });

  it('still throws when too little is left after trimming', async () => {
    const two = { ...base, ...paragraphsShape(2, ['suggestion'] as const) };
    const { client } = fakeClient([reply(['28%.', '107 of 154.']), reply(['28% share.', '107 of 154.'])]);
    await expect(createGroundedJson({ ...two, client })).rejects.toBeInstanceOf(GroundingRejectedError);
  });

  it('a model-call error is thrown as-is, not treated as a rejection', async () => {
    const { client, calls } = fakeClient([new Error('529 overloaded')]);
    await expect(createGroundedJson({ ...base, client })).rejects.toThrow('529 overloaded');
    expect(calls).toHaveLength(1);
  });
});

describe('facts helpers', () => {
  it('pctChange', () => {
    expect(pctChange(120, 100)).toBe('+20%');
    expect(pctChange(90, 100)).toBe('-10%');
    expect(pctChange(100, 100)).toBe('no change');
    expect(pctChange(5, 0)).toBeNull();
    expect(pctChange(null, 3)).toBeNull();
  });
  it('pctOf', () => {
    expect(pctOf(47, 135)).toBe(35);
    expect(pctOf(3, 0)).toBeNull();
  });
});

describe('splitSentences', () => {
  it('splits on sentence ends but not inside decimals', () => {
    expect(splitSentences('Depth was 2.20 this week. Output ran at 1.57x! Good?  Yes.'))
      .toEqual(['Depth was 2.20 this week.', 'Output ran at 1.57x!', 'Good?', 'Yes.']);
  });
});
