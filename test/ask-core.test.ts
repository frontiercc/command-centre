// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Ask the data, pure parts: what a lookup hands the model (no prompt text, dates readable,
// figures unchanged), the number check on answers, the calculate lookup, and the question loop
// against a scripted model: a checked answer is shown, an unchecked one is corrected once, then
// trimmed or refused, and "no lookup fits" is said plainly.
import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { compact, pickCompact } from '@/lib/ask/compact';
import { calculate, matchPeople } from '@/lib/ask/lookups';
import { allowedFrom, askQuestion, tidy, trimUnchecked, uncheckedNumbers, ASK_MODEL } from '@/lib/ask/run';
import { NextRequest } from 'next/server';

describe('compact', () => {
  it('drops text that could carry a prompt, keeps counts under such keys', () => {
    const out = compact({ content_full: 'please summarise our Q3 board pack', explanation: 'asks to export a table', messages_7d: 12, title: 'Shadow IT intent detected in Codex', promptText: 'x' }) as Record<string, unknown>;
    expect(out).toEqual({ messages_7d: 12, title: 'Shadow IT intent detected in Codex' });
  });

  it('drops long strings, turns timestamps into dates and keeps figures to four decimals', () => {
    const out = compact({ note: 'x'.repeat(200), generated_at: 1794729350, share: 0.285345183145, usd: 408.68266192500005 }) as Record<string, unknown>;
    expect(out).toEqual({ generated_at: '2026-11-15', share: 0.2853, usd: 408.6827 });
  });

  it('cuts long lists with a note, and picks keys', () => {
    expect(compact([1, 2, 3, 4], { maxItems: 2 })).toEqual([1, 2, '(2 more not shown)']);
    expect(pickCompact({ a: 1, b: 2, c: 3 }, ['a', 'c'])).toEqual({ a: 1, c: 3 });
  });
});

describe('calculate', () => {
  it('works out changes, shares, sums and differences in code', () => {
    expect(calculate({ op: 'change', from: 1013.63, to: 408.68 })).toMatchObject({ difference: -604.95, percent_change: -59.68 });
    expect(calculate({ op: 'share', part: 128.01, whole: 408.68 })).toMatchObject({ percent: 31.32 });
    expect(calculate({ op: 'sum', values: [305.38, 103.31] })).toMatchObject({ sum: 408.69 });
    expect(calculate({ op: 'difference', from: 20, to: 15 })).toMatchObject({ difference: -5 });
    expect(calculate({ op: 'share', part: 1 })).toHaveProperty('error');
    expect(calculate({ op: 'change', from: 0, to: 5 })).toMatchObject({ percent_change: null });
  });
});

describe('the number check', () => {
  const allowed = allowedFrom(['{"totalUsd":408.6827,"share":0.2853,"people":75}', '15 November 2026']);

  it('accepts figures from the data, rounded, and shares as percentages', () => {
    expect(uncheckedNumbers('November so far: $408.68, about $409, across 75 people.', allowed)).toEqual([]);
    expect(uncheckedNumbers('Capability Creation is 29% of spend (28.5% exactly).', allowed)).toEqual([]);
    expect(uncheckedNumbers('As of 15 November 2026.', allowed)).toEqual([]);
  });

  it('flags invented figures, in digits or words', () => {
    expect(uncheckedNumbers('Spend rose 12% to $410 in total.', allowed)).toEqual(['12', '410']);
    expect(uncheckedNumbers('Seventeen teams use it.', allowed)).toEqual(['17']);
  });

  it('keeps the checked sentences, or gives up when most are unchecked', () => {
    expect(trimUnchecked('Spend is $408.68. It rose 12%. 75 people used it.', allowed)).toBe('Spend is $408.68. 75 people used it.');
    expect(trimUnchecked('It rose 12%. It fell 4%. Spend is $408.68.', allowed)).toBeNull();
  });
});

describe('matchPeople', () => {
  const people = [
    { id: '1', name: 'Nina Johansson', email: 'nina@corp.com', department: 'Product' },
    { id: '2', name: 'Nina Patel', email: 'npatel@corp.com', department: 'Sales' },
  ];
  it('matches every word of a name or email, case ignored', () => {
    expect(matchPeople(people, 'nina').map(p => p.id)).toEqual(['1', '2']);
    expect(matchPeople(people, 'Nina Johansson').map(p => p.id)).toEqual(['1']);
    expect(matchPeople(people, 'npatel').map(p => p.id)).toEqual(['2']);
  });
});

/** A scripted model: each call returns the next reply. */
function scripted(replies: Array<Partial<Anthropic.Message>>) {
  const calls: Anthropic.MessageCreateParams[] = [];
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        calls.push(params);
        const r = replies.shift();
        if (!r) throw new Error('no more replies');
        return { id: 'm', type: 'message', role: 'assistant', model: ASK_MODEL, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...r } as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}
const text = (t: string): Partial<Anthropic.Message> => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t, citations: null }] as Anthropic.ContentBlock[] });
const tool = (name: string, input: object): Partial<Anthropic.Message> => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t-${name}`, name, input }] as Anthropic.ContentBlock[] });
const ctx = { request: new NextRequest('http://localhost/api/ask') };

describe('askQuestion', () => {
  it('answers from a lookup, on Haiku 5.5, and counts the tokens', async () => {
    const { client, calls } = scripted([tool('calculate', { op: 'sum', values: [305.38, 103.31] }), text('Claude and OpenAI together: $408.69 this month.')]);
    const r = await askQuestion({ client, question: 'Total of 305.38 and 103.31?', ctx, today: '15 November 2026' });
    expect(r.outcome).toBe('answered');
    expect(r.answer).toBe('Claude and OpenAI together: $408.69 this month.');
    expect(r.lookups).toEqual([{ name: 'calculate', input: { op: 'sum', values: [305.38, 103.31] } }]);
    expect(r.usage).toEqual({ input: 200, output: 40, cacheRead: 0, cacheWrite: 0 });
    expect(calls.every(c => c.model === 'claude-haiku-5-5')).toBe(true);
  });

  it('asks once for a correction, then accepts a checked answer', async () => {
    const { client, calls } = scripted([text('Spend is $999.'), text('I have no figure for that.')]);
    const r = await askQuestion({ client, question: 'What is spend?', ctx, today: '15 November 2026' });
    expect(r.outcome).toBe('answered');
    expect(r.answer).toBe('I have no figure for that.');
    expect(JSON.stringify(calls[1].messages)).toContain('999');
  });

  it('refuses when the corrected answer is still unchecked', async () => {
    const { client } = scripted([text('Spend is $999.'), text('Spend is $998.')]);
    const r = await askQuestion({ client, question: 'What is spend?', ctx, today: '15 November 2026' });
    expect(r.outcome).toBe('refused');
    expect(r.answer).not.toContain('998');
  });

  it('says plainly when no lookup fits', async () => {
    const { client } = scripted([tool('cannot_answer', { reason: 'Prompt text is never shown.' })]);
    const r = await askQuestion({ client, question: "Show me Ben's prompts", ctx, today: '15 November 2026' });
    expect(r).toMatchObject({ outcome: 'not_answerable', answer: 'Prompt text is never shown.' });
  });

  it('keeps bold for the panel to show, and removes other markdown', () => {
    expect(tidy('- **Cowork is the biggest cost.** It accounts for $231.93.')).toBe('- **Cowork is the biggest cost.** It accounts for $231.93.');
    expect(tidy('__Gmail__ is next.')).toBe('**Gmail** is next.');
    expect(tidy('## Spend\nThe *main* model is `gpt-6.1-sol`.\n* Sales\n* Legal')).toBe('Spend\nThe main model is gpt-6.1-sol.\n- Sales\n- Legal');
    expect(tidy('2 * 3 people')).toBe('2 * 3 people');
  });

  it('turns em dashes into commas', async () => {
    const { client } = scripted([text('Nothing to report — all quiet.')]);
    expect((await askQuestion({ client, question: 'Anything new?', ctx, today: '15 November 2026' })).answer).toBe('Nothing to report, all quiet.');
  });
});
