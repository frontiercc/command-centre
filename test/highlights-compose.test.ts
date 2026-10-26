// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HighlightsWorkItem, HighlightsInput } from '@/lib/highlights/gather';

// Mock the Anthropic SDK — mirrors test/use-cases-emergent-synthesis.test.ts
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: mockCreate },
    })),
    __mockCreate: mockCreate,
  };
});

vi.mock('@/lib/config', () => ({
  getConfigValue: vi.fn((key: string) => {
    if (key === 'anthropicAiApiKey') return 'sk-test-key';
    if (key === 'highlightsModel') return '';
    return '';
  }),
}));

vi.mock('@/lib/ingestion/scheduler', () => ({
  queueAiCall: (fn: () => Promise<unknown>) => fn(),
}));

async function getMockCreate() {
  const mod = await import('@anthropic-ai/sdk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod as any).__mockCreate as ReturnType<typeof vi.fn>;
}

function makeTextResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

const items: HighlightsWorkItem[] = [
  { index: 0, taskType: 'workflow', text: 'Build a client-ready proposal deck from a meeting recording' },
  { index: 1, taskType: 'analysis', text: 'Reconcile the monthly budget variance across three systems' },
];

function makeInput(workItems: HighlightsWorkItem[] = items): HighlightsInput {
  return {
    weekStart: 0,
    weekEnd: 604800,
    headcount: 5,
    workItems,
    engineeringMix: [],
    systems: { totalCalls: 0, distinctSystems: 0, top: [] },
    codeOutput: null,
    tier3Count: workItems.length,
    shoutouts: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── validateComposed (pure unit) ───────────────────────────────────────

describe('validateComposed', () => {
  it('keeps traced, digit-free deliverables and drops the rest', async () => {
    const { validateComposed } = await import('@/lib/highlights/compose');
    const out = validateComposed({
      subject: 'client proposals and budget reconciliation',
      deliverables: [
        { item: 0, sentence: 'A client-ready proposal deck, built from nothing but a meeting recording.' },
        { item: 1, sentence: 'A budget reconciliation covering 3 systems.' },      // digit → dropped
        { item: 7, sentence: 'A fabricated deliverable with no matching item.' },  // untraceable → dropped
        { item: 0, sentence: 'Duplicate of item zero.' },                          // dup item → dropped
      ],
    }, items);
    expect(out).not.toBeNull();
    expect(out!.deliverables).toHaveLength(1);
    expect(out!.deliverables[0]).toEqual({ itemIndex: 0, sentence: 'A client-ready proposal deck, built from nothing but a meeting recording.' });
    expect(out!.subject).toBe('client proposals and budget reconciliation');
  });

  it('returns null when nothing valid survives', async () => {
    const { validateComposed } = await import('@/lib/highlights/compose');
    expect(validateComposed({ subject: 's', deliverables: [{ item: 9, sentence: 'x' }] }, items)).toBeNull();
    expect(validateComposed({ subject: '', deliverables: [{ item: 0, sentence: 'ok' }] }, items)).toBeNull();
    expect(validateComposed('not an object', items)).toBeNull();
    expect(validateComposed({ subject: 's', deliverables: [] }, items)).toBeNull();
  });

  it('returns null when the subject itself contains a digit, even with otherwise-valid deliverables', async () => {
    const { validateComposed } = await import('@/lib/highlights/compose');
    const out = validateComposed({
      subject: '3 client proposals',
      deliverables: [
        { item: 0, sentence: 'A client-ready proposal deck, built from nothing but a meeting recording.' },
      ],
    }, items);
    expect(out).toBeNull();
  });

  it('caps deliverables at six', async () => {
    const { validateComposed } = await import('@/lib/highlights/compose');
    const many: HighlightsWorkItem[] = Array.from({ length: 10 }, (_, i) => ({ index: i, taskType: null, text: `work item ${i}` }));
    const parsed = {
      subject: 's',
      deliverables: many.map(m => ({ item: m.index, sentence: `Deliverable for item number ${m.index}.`.replace(/number \d+/, 'padding') })),
    };
    const out = validateComposed(parsed, many);
    expect(out).not.toBeNull();
    expect(out!.deliverables.length).toBeLessThanOrEqual(6);
    expect(out!.deliverables.every(d => !/\d/.test(d.sentence))).toBe(true);
  });
});

// ─── composeHighlights (end-to-end through the mocked SDK) ──────────────

describe('composeHighlights', () => {
  it('parses a fenced JSON response and returns the validated result', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeTextResponse(
      '```json\n' + JSON.stringify({
        subject: 'client proposals and budget reconciliation',
        deliverables: [
          { item: 0, sentence: 'A client-ready proposal deck, built from nothing but a meeting recording.' },
          { item: 1, sentence: 'A full reconciliation of the monthly budget variance.' },
        ],
      }) + '\n```'
    ));

    const { composeHighlights } = await import('@/lib/highlights/compose');
    const out = await composeHighlights(makeInput());

    expect(out).not.toBeNull();
    expect(out!.subject).toBe('client proposals and budget reconciliation');
    expect(out!.deliverables).toHaveLength(2);
    expect(out!.deliverables[0]).toEqual({ itemIndex: 0, sentence: 'A client-ready proposal deck, built from nothing but a meeting recording.' });
  });

  it('returns null when the API call throws', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockRejectedValueOnce(new Error('network error'));

    const { composeHighlights } = await import('@/lib/highlights/compose');
    const out = await composeHighlights(makeInput());

    expect(out).toBeNull();
  });

  it('returns null without calling the model when there are no work items', async () => {
    const mockCreate = await getMockCreate();

    const { composeHighlights } = await import('@/lib/highlights/compose');
    const out = await composeHighlights(makeInput([]));

    expect(out).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns null when the model output is malformed JSON', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeTextResponse('not valid json'));

    const { composeHighlights } = await import('@/lib/highlights/compose');
    const out = await composeHighlights(makeInput());

    expect(out).toBeNull();
  });
});
