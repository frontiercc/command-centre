// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';

// ─── Mocks ────────────────────────────────────────────────────────────────

// Mock the Anthropic SDK — mirrors test/use-cases-extract.test.ts
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
    if (key === 'useCasesIdeateModel') return 'claude-sonnet-5';
    return '';
  }),
  getAllConfig: vi.fn(() => ({ useCasesEnabled: true })),
}));

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  canAccessPulseAdmin: (role?: string) => role === 'admin' || role === 'manager',
}));

async function getMockCreate() {
  const mod = await import('@anthropic-ai/sdk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod as any).__mockCreate as ReturnType<typeof vi.fn>;
}

function makeTextResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  });
}

// The route grounds the model in org telemetry (gatherOrgGrounding reads the
// database), so give it an empty migrated test database rather than
// whatever default database the environment points at.
let cleanupDb: () => Promise<void>;
beforeAll(async () => {
  ({ cleanup: cleanupDb } = await createTestDatabase());
});
afterAll(async () => cleanupDb());

beforeEach(() => {
  vi.clearAllMocks();
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com' };
});

// ─── ideateTurn (unit) ───────────────────────────────────────────────────

describe('ideateTurn', () => {
  const grounding = {
    topSkills: ['writing-plans', 'debugging'],
    underusedConnectors: ['docusign'],
    topTaskTypes: ['legal_review'],
    codeWorkTypes: ['feature', 'bugfix'],
    departments: ['Legal', 'Engineering'],
  };

  it('returns reply + parsed candidates from a mocked model response', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(
      makeTextResponse(
        JSON.stringify({
          reply: 'Given your team leans on writing-plans and Legal does a lot of legal_review, what if we automated contract intake?',
          candidates: [
            {
              title: 'Contract intake triage',
              description: 'Use Claude to triage incoming contracts by risk before Legal review.',
              keywords: ['contract', 'triage'],
              sourceExcerpt: 'Legal does a lot of legal_review',
            },
          ],
        })
      )
    );

    const { ideateTurn } = await import('../lib/usecases/ideate');
    const result = await ideateTurn([{ role: 'user', content: 'What could we automate in Legal?' }], 'telemetry', grounding);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      model: 'claude-sonnet-5',
    });
    // No temperature — claude-sonnet-5 (and opus-4.x) reject it with a 400.
    expect(mockCreate.mock.calls[0][0].temperature).toBeUndefined();

    expect(result.reply).toContain('writing-plans');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      title: 'Contract intake triage',
      description: 'Use Claude to triage incoming contracts by risk before Legal review.',
      keywords: ['contract', 'triage'],
      sourceExcerpt: 'Legal does a lot of legal_review',
    });
  });

  it('grounds the system prompt in the passed org data (names skills/connectors/task types/departments)', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeTextResponse(JSON.stringify({ reply: 'ok', candidates: [] })));

    const { ideateTurn } = await import('../lib/usecases/ideate');
    await ideateTurn([{ role: 'user', content: 'hello' }], 'telemetry', grounding);

    const call = mockCreate.mock.calls[0][0];
    const system = call.system as string;
    expect(system).toContain('writing-plans');
    expect(system).toContain('docusign');
    expect(system).toContain('legal_review');
    expect(system).toContain('Legal');
    expect(system.toLowerCase()).toContain('do not');
  });

  it('malformed model output falls back to { reply, candidates: [] }', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeTextResponse('not valid json at all'));

    const { ideateTurn } = await import('../lib/usecases/ideate');
    const result = await ideateTurn([{ role: 'user', content: 'hi' }], 'telemetry', grounding);

    expect(result.candidates).toEqual([]);
    expect(typeof result.reply).toBe('string');
  });

  it('drops malformed individual candidates but keeps the reply and valid ones', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(
      makeTextResponse(
        JSON.stringify({
          reply: 'here are some ideas',
          candidates: [
            { title: 'Missing description' },
            { title: 'Valid one', description: 'a valid candidate' },
          ],
        })
      )
    );

    const { ideateTurn } = await import('../lib/usecases/ideate');
    const result = await ideateTurn([{ role: 'user', content: 'hi' }], 'telemetry', grounding);

    expect(result.reply).toBe('here are some ideas');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].title).toBe('Valid one');
  });

  it('strips markdown code fences from the model response', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(
      makeTextResponse(
        '```json\n' +
          JSON.stringify({ reply: 'fenced reply', candidates: [] }) +
          '\n```'
      )
    );

    const { ideateTurn } = await import('../lib/usecases/ideate');
    const result = await ideateTurn([{ role: 'user', content: 'hi' }], 'telemetry', grounding);
    expect(result.reply).toBe('fenced reply');
  });

  it('passes conversation history to the model', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeTextResponse(JSON.stringify({ reply: 'ok', candidates: [] })));

    const { ideateTurn } = await import('../lib/usecases/ideate');
    const history: { role: 'user' | 'assistant'; content: string }[] = [
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'second message' },
    ];
    await ideateTurn(history, 'telemetry', grounding);

    const call = mockCreate.mock.calls[0][0];
    expect(call.messages).toHaveLength(3);
    expect(call.messages[0]).toMatchObject({ role: 'user', content: 'first message' });
    expect(call.messages[2]).toMatchObject({ role: 'user', content: 'second message' });
  });

  it('falls back to the default model when useCasesIdeateModel is unset (raw "")', async () => {
    const { getConfigValue } = await import('@/lib/config');
    (getConfigValue as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'anthropicAiApiKey') return 'sk-test-key';
      // Simulate the never-saved case: config returns raw '' rather than a default.
      if (key === 'useCasesIdeateModel') return '';
      return '';
    });

    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeTextResponse(JSON.stringify({ reply: 'ok', candidates: [] })));

    const { ideateTurn } = await import('../lib/usecases/ideate');
    await ideateTurn([{ role: 'user', content: 'hi' }], 'telemetry', grounding);

    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      model: 'claude-sonnet-5',
    });
  });
});

// Note: gatherOrgGrounding (DB-backed, via createTestDatabase) has its own file —
// test/use-cases-ideate-grounding.test.ts — see the comment there for why.

// ─── POST /api/use-cases/ideate (route gate matrix) ─────────────────────

describe('POST /api/use-cases/ideate', () => {
  it('returns 404 when use cases are disabled', async () => {
    const { getAllConfig } = await import('@/lib/config');
    (getAllConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({ useCasesEnabled: false });

    const { POST } = await import('../app/api/use-cases/ideate/route');
    const res = await POST(jsonRequest('/api/use-cases/ideate', 'POST', { history: [] }));
    expect(res.status).toBe(404);
  });

  it('returns 401 when not authenticated', async () => {
    sessionResult = { authenticated: false };
    const { POST } = await import('../app/api/use-cases/ideate/route');
    const res = await POST(jsonRequest('/api/use-cases/ideate', 'POST', { history: [] }));
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin/manager role', async () => {
    sessionResult = { authenticated: true, role: 'viewer', userId: 'v1' };
    const { POST } = await import('../app/api/use-cases/ideate/route');
    const res = await POST(jsonRequest('/api/use-cases/ideate', 'POST', { history: [] }));
    expect(res.status).toBe(403);
  });

  it('returns 400 when history is missing', async () => {
    const { POST } = await import('../app/api/use-cases/ideate/route');
    const res = await POST(jsonRequest('/api/use-cases/ideate', 'POST', {}));
    expect(res.status).toBe(400);
  });

  it('returns 400 when history is an empty array', async () => {
    const { POST } = await import('../app/api/use-cases/ideate/route');
    const res = await POST(jsonRequest('/api/use-cases/ideate', 'POST', { history: [] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('history required');
  });

  it('returns 200 with reply + candidates when enabled and authorised', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(
      makeTextResponse(JSON.stringify({ reply: 'Here is an idea', candidates: [] }))
    );

    const { POST } = await import('../app/api/use-cases/ideate/route');
    const res = await POST(
      jsonRequest('/api/use-cases/ideate', 'POST', { history: [{ role: 'user', content: 'hi' }] })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply).toBe('Here is an idea');
    expect(body.candidates).toEqual([]);
  });

  it('allows manager role', async () => {
    sessionResult = { authenticated: true, role: 'manager', userId: 'm1' };
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeTextResponse(JSON.stringify({ reply: 'ok', candidates: [] })));

    const { POST } = await import('../app/api/use-cases/ideate/route');
    const res = await POST(
      jsonRequest('/api/use-cases/ideate', 'POST', { history: [{ role: 'user', content: 'hi' }] })
    );
    expect(res.status).toBe(200);
  });
});

// ─── POST /api/use-cases/ideate — mode ───────────────────────────────────

describe('ideate route — mode', () => {
  beforeEach(() => { sessionResult = { authenticated: true, role: 'admin', userId: 'u1', email: 'a@b.co' }; });

  it('telemetry mode instructs opening with data analysis', async () => {
    const create = await getMockCreate();
    create.mockResolvedValue(makeTextResponse('{"reply":"hi","candidates":[]}'));
    const { POST } = await import('@/app/api/use-cases/ideate/route');
    const res = await POST(jsonRequest('/api/use-cases/ideate', 'POST', {
      mode: 'telemetry', history: [{ role: 'user', content: 'Show me what my usage suggests' }],
    }));
    expect(res.status).toBe(200);
    const system = create.mock.calls[0][0].system as string;
    expect(system).toContain('from telemetry');
    expect(system).toContain('Do NOT invent'); // no-generic rule present in both modes
  });

  it('scratch mode instructs opening with questions, still grounded', async () => {
    const create = await getMockCreate();
    create.mockResolvedValue(makeTextResponse('{"reply":"hi","candidates":[]}'));
    const { POST } = await import('@/app/api/use-cases/ideate/route');
    const res = await POST(jsonRequest('/api/use-cases/ideate', 'POST', {
      mode: 'scratch', history: [{ role: 'user', content: 'brainstorm with me' }],
    }));
    expect(res.status).toBe(200);
    const system = create.mock.calls[0][0].system as string;
    expect(system).toContain('from scratch');
    expect(system).toContain('Do NOT invent');
  });

  it('defaults to telemetry when mode omitted', async () => {
    const create = await getMockCreate();
    create.mockResolvedValue(makeTextResponse('{"reply":"hi","candidates":[]}'));
    const { POST } = await import('@/app/api/use-cases/ideate/route');
    await POST(jsonRequest('/api/use-cases/ideate', 'POST', { history: [{ role: 'user', content: 'hi' }] }));
    const system = create.mock.calls[0][0].system as string;
    expect(system).toContain('from telemetry');
  });
});
