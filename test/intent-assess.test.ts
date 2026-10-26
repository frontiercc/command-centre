// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}));

vi.mock('@/lib/config', () => ({
  getConfigValue: vi.fn((key: string) => {
    if (key === 'anthropicAiApiKey') return 'test-key';
    if (key === 'acceptableUsePolicy') return 'No bulk data extraction without approval.';
    return '';
  }),
}));

vi.mock('@/lib/ingestion/scheduler', () => ({
  queueAiCall: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { assessIntent } from '../lib/intent/assess';
import type { IntentMatch } from '../lib/intent/types';

beforeEach(() => mockCreate.mockReset());

function mockHaikuResponse(assessment: Record<string, unknown>) {
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify(assessment) }],
  });
}

describe('assessIntent', () => {
  const sampleMatch: IntentMatch[] = [{
    categoryId: 'data_exfiltration',
    categoryName: 'Data Exfiltration',
    matchedPhrases: ['extract all'],
    defaultSeverity: 'high',
  }];

  it('calls Haiku with correct model and returns parsed assessment', async () => {
    mockHaikuResponse({
      severity: 'high',
      reasoning: 'User requesting bulk extraction of customer data.',
      recommended_action: 'Review with line manager',
    });

    const result = await assessIntent('extract all contacts from Salesforce', sampleMatch);

    expect(result).toEqual({
      severity: 'high',
      reasoning: 'User requesting bulk extraction of customer data.',
      recommendedAction: 'Review with line manager',
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // Verify model is Haiku
    expect(mockCreate.mock.calls[0][0].model).toBe('claude-haiku-4-5-20251001');
    // Verify max_tokens is conservative
    expect(mockCreate.mock.calls[0][0].max_tokens).toBeLessThanOrEqual(512);
    // Verify deterministic output for audit consistency
    expect(mockCreate.mock.calls[0][0].temperature).toBeUndefined();
  });

  it('includes intent matches and policy in the prompt', async () => {
    mockHaikuResponse({
      severity: 'medium',
      reasoning: 'Moderate risk.',
      recommended_action: 'Monitor.',
    });

    await assessIntent('extract all contacts from Salesforce', sampleMatch);

    const userPrompt = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(userPrompt).toContain('extract all contacts from Salesforce');
    expect(userPrompt).toContain('data_exfiltration');
    expect(userPrompt).toContain('extract all');
  });

  it('returns fallback on malformed AI response', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'not valid json' }],
    });

    const result = await assessIntent('extract all contacts', sampleMatch);

    expect(result.severity).toBe('medium');
    expect(result.reasoning).toContain('Manual review');
  });

  it('returns fallback when no AI key is configured', async () => {
    const { getConfigValue } = await import('@/lib/config');
    (getConfigValue as ReturnType<typeof vi.fn>).mockReturnValue('');

    const result = await assessIntent('extract all contacts', sampleMatch);

    expect(result.reasoning).toContain('AI assessment unavailable');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
