// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The pure rules behind ChatGPT and Codex spend: which export records carry
// spend and how each is valued, and the Work Pulse spend figure for each view
// of the Claude / ChatGPT switch.
import { describe, it, expect } from 'vitest';
import { interpretSpend } from '@/lib/openai/sync';
import { workSpendFigure, formatUsd } from '@/lib/pulse/spend-figure';

const floors = { cowork: 0, code: 0 };
const hour = Date.UTC(2026, 9, 30, 14) / 1000;

function costRecord(billing: unknown[], identity: Record<string, unknown> = { email: 'sam@example.com' }, product = 'chatgpt') {
  return {
    event_id: 'ev-1', type: 'COSTS', timestamp: '2026-10-30T14:59:59Z',
    payload: {
      day: '2026-10-30', hour: 14, product, client: 'web', model: 'gpt-5.5', identity,
      measures: { usage: { text_input_tokens: 1000, text_cached_input_tokens: 200, text_output_tokens: 300 }, billing },
    },
  };
}

describe('interpretSpend', () => {
  it('values a credits cost at OpenAI\'s estimated dollars', () => {
    const s = interpretSpend(costRecord([
      { cost: { value: 10, unit: 'CREDITS' }, estimated_cost_usd: { value: 0.4 } },
      { cost: { value: 5, unit: 'CREDITS' }, estimated_cost_usd: { value: 0.2 } },
    ]), floors);
    expect(s).toMatchObject({ kind: 'cost', id: 'openai-cost:ev-1', email: 'sam@example.com', hourStart: hour, billedIn: 'CREDITS', credits: 15, input: 1000, cachedInput: 200, output: 300 });
    expect(s && s.kind === 'cost' && s.costUsd).toBeCloseTo(0.6, 6);
  });

  it('keeps a dollar cost as billed', () => {
    const s = interpretSpend(costRecord([{ cost: { value: 1.5, unit: 'USD' } }]), floors);
    expect(s).toMatchObject({ kind: 'cost', billedIn: 'USD', costUsd: 1.5, credits: null });
  });

  it('leaves the dollar cost unknown when a credit line has no estimate, rather than guessing', () => {
    const s = interpretSpend(costRecord([{ cost: { value: 10, unit: 'CREDITS' } }]), floors);
    expect(s).toMatchObject({ kind: 'cost', costUsd: null, credits: 10 });
  });

  it('keeps a cost with no person, and names an agent', () => {
    expect(interpretSpend(costRecord([{ cost: { value: 1, unit: 'USD' } }], {}), floors)).toMatchObject({ email: null, agentName: null });
    expect(interpretSpend(costRecord([{ cost: { value: 1, unit: 'USD' } }], { agent: { name: 'Procurement Review Agent' } }), floors))
      .toMatchObject({ email: null, agentName: 'Procurement Review Agent' });
  });

  it('drops a cost whose hour ended before the retention floor: Codex on the Code window, ChatGPT on Cowork', () => {
    const late = { cowork: hour + 3600, code: 0 };
    expect(interpretSpend(costRecord([{ cost: { value: 1, unit: 'USD' } }]), late)).toBeNull();
    expect(interpretSpend(costRecord([{ cost: { value: 1, unit: 'USD' } }], { email: 'sam@example.com' }, 'codex'), late)).not.toBeNull();
  });

  it('reads a ChatGPT reply\'s model and time, never its text', () => {
    const s = interpretSpend({
      type: 'CONVERSATION_MESSAGE', actor: { user_email: 'sam@example.com' },
      message: { id: 'm1', created_at: '2026-10-30T14:10:00Z', author: { type: 'assistant', model: 'gpt-5.5' }, content: { type: 'text', value: 'secret reply' } },
      conversation: { id: 'c1', mode: 'work' },
    }, floors);
    expect(s).toEqual({ kind: 'reply', id: 'chatgpt-reply:m1', sessionId: 'chatgpt:c1', source: 'chatgpt_work', email: 'sam@example.com', model: 'gpt-5.5', occurredAt: hour + 600 });
  });

  it('reads a Codex turn and skips a ChatGPT Work turn', () => {
    const turn = (client: string) => ({
      type: 'CODEX_TURN', actor: { user_email: 'sam@example.com' }, timestamp: '2026-10-30T14:59:59Z',
      payload: {
        turn_key: 's1:t1', session_id: 's1', product_client_id: client, model: 'gpt-5.5-codex',
        started_at: '2026-10-30T14:05:00Z', completed_at: '2026-10-30T14:06:00Z',
        credits: 2, estimated_cost_usd: 0.08, tags: ['automation'],
        token_usage: { uncached_input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 },
      },
    });
    expect(interpretSpend(turn('CODEX_CLI'), floors)).toMatchObject({
      kind: 'turn', id: 'codex-turn:s1:t1', sessionId: 'codex:s1', uncachedInput: 100, cachedInput: 50, output: 20,
      credits: 2, openaiCostUsd: 0.08, automation: true, startedAt: hour + 300,
    });
    expect(interpretSpend(turn('CODEX_WORK_WEB'), floors)).toBeNull();
  });
});

describe('workSpendFigure', () => {
  it('All view with ChatGPT costs: the total, with each part beneath', () => {
    const f = workSpendFigure('all', 12.5, 40)!;
    expect(f.label).toBe('Spend');
    expect(f.usd).toBe(52.5);
    expect(f.sub).toContain('Claude Cowork $12.50 · ChatGPT $40.00');
  });

  it('All view before any ChatGPT cost arrives: Claude Cowork alone, saying so', () => {
    const f = workSpendFigure('all', 12.5, null)!;
    expect(f).toMatchObject({ label: 'Claude Cowork spend', usd: 12.5 });
    expect(f.sub).toContain('No ChatGPT cost record has arrived yet');
  });

  it('a Claude-only hub keeps the Claude Cowork card as it was', () => {
    expect(workSpendFigure('all', 3, undefined)).toEqual({ label: 'Claude Cowork spend', usd: 3, sub: 'API cost of every Claude Cowork session, measured.' });
  });

  it('each vendor view shows its own spend only', () => {
    expect(workSpendFigure('claude', 3, undefined)?.label).toBe('Claude Cowork spend');
    expect(workSpendFigure('openai', undefined, 40)).toMatchObject({ label: 'ChatGPT spend', usd: 40 });
    expect(workSpendFigure('openai', undefined, null)).toMatchObject({ label: 'ChatGPT spend', usd: null });
    expect(workSpendFigure('openai', undefined, undefined)).toBeNull();
  });

  it('formats dollars as the cards always have', () => {
    expect([formatUsd(0), formatUsd(4.567), formatUsd(1234.4)]).toEqual(['$0.00', '$4.57', '$1234']);
  });
});

describe('ChatGPT with no priced model', () => {
  it('says not priced rather than $0, and names the unpriced models', () => {
    const all = workSpendFigure('all', 0, 0, 3)!;
    expect(all.notPriced).toBe(true);
    expect(all.sub).toContain('ChatGPT not priced');
    expect(all.sub).toContain('3 ChatGPT models have no rate yet');
    expect(workSpendFigure('openai', undefined, 0, 1)).toMatchObject({ notPriced: true });
    expect(workSpendFigure('all', 5, 0, 2)?.notPriced).toBe(false);
    expect(workSpendFigure('all', 5, 4, 0)?.sub).toContain("OpenAI's USD (token-based) contract rates");
  });
});
