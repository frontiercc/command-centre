// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mocks ────────────────────────────────────────────────────────────────

// Mock the Anthropic SDK — mirrors test/pulse/classifier.test.ts
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
    if (key === 'useCasesExtractModel') return 'claude-haiku-4-5-20251001';
    return '';
  }),
  getAllConfig: vi.fn(() => ({ useCasesEnabled: true })),
}));

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  canAccessPulseAdmin: (role?: string) => role === 'admin' || role === 'manager',
}));

// Mock mammoth (used by the extract route's .docx path via dynamic import).
vi.mock('mammoth', () => ({
  default: { extractRawText: vi.fn(async () => ({ value: 'extracted docx transcript text' })) },
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

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com' };
});

// ─── extractUseCases (unit) ─────────────────────────────────────────────

describe('extractUseCases', () => {
  it('returns [] without calling the client for an empty transcript', async () => {
    const { extractUseCases } = await import('../lib/usecases/extract');
    const mockCreate = await getMockCreate();

    const result = await extractUseCases('   ');
    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('parses a fixed JSON array into candidates with sourceExcerpt + both origins', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(
      makeTextResponse(
        JSON.stringify([
          {
            title: 'Contract redline assistant',
            description: 'Use Claude to draft first-pass redlines on vendor contracts.',
            departments: ['Legal'],
            surfaces: ['cowork'],
            keywords: ['contract', 'redline'],
            sourceExcerpt: 'we want to build an AI tool that drafts contract redlines',
            origin: 'planned',
          },
          {
            title: 'Meeting notes cleanup',
            description: 'People manually reformat meeting notes every week; Claude could do this.',
            sourceExcerpt: 'I spend an hour every Friday tidying up the notes from standups',
            origin: 'ideated',
          },
        ])
      )
    );

    const { extractUseCases } = await import('../lib/usecases/extract');
    const result = await extractUseCases('some transcript text');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
    });
    // No temperature — newer models reject it with a 400 (extract model is configurable).
    expect(mockCreate.mock.calls[0][0].temperature).toBeUndefined();

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      title: 'Contract redline assistant',
      origin: 'planned',
      sourceExcerpt: 'we want to build an AI tool that drafts contract redlines',
      departments: ['Legal'],
      surfaces: ['cowork'],
      keywords: ['contract', 'redline'],
    });
    expect(result[1]).toMatchObject({
      title: 'Meeting notes cleanup',
      origin: 'ideated',
      sourceExcerpt: 'I spend an hour every Friday tidying up the notes from standups',
    });
  });

  it('returns [] when the model output is malformed JSON', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeTextResponse('not valid json at all'));

    const { extractUseCases } = await import('../lib/usecases/extract');
    const result = await extractUseCases('some transcript text');
    expect(result).toEqual([]);
  });

  it('returns [] when the model returns a JSON object instead of an array', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeTextResponse(JSON.stringify({ oops: 'not an array' })));

    const { extractUseCases } = await import('../lib/usecases/extract');
    const result = await extractUseCases('some transcript text');
    expect(result).toEqual([]);
  });

  it('drops individual malformed items but keeps valid ones', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(
      makeTextResponse(
        JSON.stringify([
          { title: 'Missing sourceExcerpt', description: 'desc', origin: 'planned' },
          {
            title: 'Valid one',
            description: 'desc',
            sourceExcerpt: 'quoted text',
            origin: 'ideated',
          },
        ])
      )
    );

    const { extractUseCases } = await import('../lib/usecases/extract');
    const result = await extractUseCases('some transcript text');
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Valid one');
  });

  it('strips markdown code fences from the model response', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(
      makeTextResponse(
        '```json\n' +
          JSON.stringify([
            {
              title: 'Fenced candidate',
              description: 'desc',
              sourceExcerpt: 'quoted text',
              origin: 'planned',
            },
          ]) +
          '\n```'
      )
    );

    const { extractUseCases } = await import('../lib/usecases/extract');
    const result = await extractUseCases('some transcript text');
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Fenced candidate');
  });

  it('falls back to the default model when useCasesExtractModel is unset (raw "")', async () => {
    const { getConfigValue } = await import('@/lib/config');
    (getConfigValue as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'anthropicAiApiKey') return 'sk-test-key';
      // Simulate the never-saved case: config returns raw '' rather than a default.
      if (key === 'useCasesExtractModel') return '';
      return '';
    });

    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeTextResponse(JSON.stringify([])));

    const { extractUseCases } = await import('../lib/usecases/extract');
    await extractUseCases('some transcript text');

    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
    });
  });
});

// ─── extractUseCasesFromPdf (unit) ──────────────────────────────────────

describe('extractUseCasesFromPdf', () => {
  it('returns [] without calling the client for empty base64', async () => {
    const { extractUseCasesFromPdf } = await import('../lib/usecases/extract');
    const mockCreate = await getMockCreate();
    expect(await extractUseCasesFromPdf('   ')).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('sends a base64 PDF document block (no temperature) and parses candidates', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(
      makeTextResponse(
        JSON.stringify([
          { title: 'From PDF', description: 'desc', sourceExcerpt: 'quoted', origin: 'planned' },
        ])
      )
    );

    const { extractUseCasesFromPdf } = await import('../lib/usecases/extract');
    const result = await extractUseCasesFromPdf('QUJD'); // base64 of "ABC"

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('From PDF');

    const content = mockCreate.mock.calls[0][0].messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' },
    });
    expect(mockCreate.mock.calls[0][0].temperature).toBeUndefined();
  });
});

// ─── POST /api/use-cases/extract (route gate matrix) ────────────────────

describe('POST /api/use-cases/extract', () => {
  it('returns 404 when use cases are disabled', async () => {
    const { getAllConfig } = await import('@/lib/config');
    (getAllConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({ useCasesEnabled: false });

    const { POST } = await import('../app/api/use-cases/extract/route');
    const res = await POST(jsonRequest('/api/use-cases/extract', 'POST', { transcript: 'hello' }));
    expect(res.status).toBe(404);
  });

  it('returns 401 when not authenticated', async () => {
    sessionResult = { authenticated: false };
    const { POST } = await import('../app/api/use-cases/extract/route');
    const res = await POST(jsonRequest('/api/use-cases/extract', 'POST', { transcript: 'hello' }));
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin/manager role', async () => {
    sessionResult = { authenticated: true, role: 'viewer', userId: 'v1' };
    const { POST } = await import('../app/api/use-cases/extract/route');
    const res = await POST(jsonRequest('/api/use-cases/extract', 'POST', { transcript: 'hello' }));
    expect(res.status).toBe(403);
  });

  it('returns 400 when transcript is missing', async () => {
    const { POST } = await import('../app/api/use-cases/extract/route');
    const res = await POST(jsonRequest('/api/use-cases/extract', 'POST', {}));
    expect(res.status).toBe(400);
  });

  it('returns 200 with candidates when enabled and authorised', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(
      makeTextResponse(
        JSON.stringify([
          {
            title: 'Contract redline assistant',
            description: 'desc',
            sourceExcerpt: 'quoted text',
            origin: 'planned',
          },
        ])
      )
    );

    const { POST } = await import('../app/api/use-cases/extract/route');
    const res = await POST(jsonRequest('/api/use-cases/extract', 'POST', { transcript: 'transcript text' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].title).toBe('Contract redline assistant');
  });

  it('allows manager role', async () => {
    sessionResult = { authenticated: true, role: 'manager', userId: 'm1' };
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeTextResponse(JSON.stringify([])));

    const { POST } = await import('../app/api/use-cases/extract/route');
    const res = await POST(jsonRequest('/api/use-cases/extract', 'POST', { transcript: 'transcript text' }));
    expect(res.status).toBe(200);
  });

  it('extracts from an uploaded PDF (fileBase64 + .pdf)', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(
      makeTextResponse(
        JSON.stringify([
          { title: 'PDF candidate', description: 'desc', sourceExcerpt: 'q', origin: 'planned' },
        ])
      )
    );
    const fileBase64 = Buffer.from('%PDF-1.4 fake pdf bytes', 'utf8').toString('base64');
    const { POST } = await import('../app/api/use-cases/extract/route');
    const res = await POST(
      jsonRequest('/api/use-cases/extract', 'POST', { fileBase64, fileName: 'discovery-call.pdf', mediaType: 'application/pdf' })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates[0].title).toBe('PDF candidate');
    // PDF goes through as a native document block, not <transcript> text.
    expect(mockCreate.mock.calls[0][0].messages[0].content[0].type).toBe('document');
  });

  it('extracts from an uploaded DOCX via mammoth', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(
      makeTextResponse(
        JSON.stringify([
          { title: 'DOCX candidate', description: 'desc', sourceExcerpt: 'q', origin: 'ideated' },
        ])
      )
    );
    const fileBase64 = Buffer.from('PK fake docx zip bytes', 'utf8').toString('base64');
    const { POST } = await import('../app/api/use-cases/extract/route');
    const res = await POST(
      jsonRequest('/api/use-cases/extract', 'POST', {
        fileBase64,
        fileName: 'workshop-notes.docx',
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates[0].title).toBe('DOCX candidate');
    // DOCX is converted to text upstream, so it arrives as a <transcript> string.
    expect(typeof mockCreate.mock.calls[0][0].messages[0].content).toBe('string');
  });

  it('returns 400 for an unsupported uploaded file type', async () => {
    const fileBase64 = Buffer.from('some binary', 'utf8').toString('base64');
    const { POST } = await import('../app/api/use-cases/extract/route');
    const res = await POST(
      jsonRequest('/api/use-cases/extract', 'POST', { fileBase64, fileName: 'diagram.png', mediaType: 'image/png' })
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for an empty uploaded file', async () => {
    const { POST } = await import('../app/api/use-cases/extract/route');
    const res = await POST(
      jsonRequest('/api/use-cases/extract', 'POST', { fileBase64: '', fileName: 'empty.pdf', mediaType: 'application/pdf' })
    );
    expect(res.status).toBe(400);
  });
});
