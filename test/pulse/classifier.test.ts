// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// classifyBatch/runClassifierJob call getTypedClient()
// (lib/db/client.ts) directly, so they are tested against a real DB, not a
// mocked one. The
// classifyBatch/history tests below need no DB seeding at all: on a freshly
// migrated, empty test DB every session-context/history read naturally
// returns `[]` — the exact "no prior history" shape the old mock simulated.
// The runClassifierJob tests use real rows via createTestDatabase() + seedUserSql().
import type { TestSql } from '../helpers/sql';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from '../helpers/db';
import { seedUserSql } from '../helpers/seed';
import { classifyBatch, runClassifierJob, type CoworkMessageRow } from '../../lib/pulse/classifier';
import { buildClassifierUserMessage, type UserHistory } from '../../lib/pulse/prompts/tier-classification';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: mockCreate },
    })),
    __mockCreate: mockCreate,
  };
});

vi.mock('../../lib/config', () => ({
  getConfigValue: vi.fn((key: string) => {
    if (key === 'anthropicAiApiKey') return 'sk-test-key';
    if (key === 'pulseClassifierModel') return 'claude-haiku-4-5-20251001';
    return '';
  }),
}));

// Helper to get the mock create function from the mocked module
async function getMockCreate() {
  const mod = await import('@anthropic-ai/sdk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod as any).__mockCreate as ReturnType<typeof vi.fn>;
}

let sql: TestSql;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
});

afterAll(async () => cleanup());

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Sarah, paralegal — 5 events across 5 weeks
const sarahEvents: CoworkMessageRow[] = [
  {
    id: 'sarah-w1-summarise',
    user_id: 'sarah-reeve',
    session_id: 's-001',
    content_full: 'Summarise this contract',
    content_preview: 'Summarise this contract',
    tool_name: null,
    occurred_at: 1740000000,
  },
  {
    id: 'sarah-w1-reformat',
    user_id: 'sarah-reeve',
    session_id: 's-002',
    content_full: 'Reformat these meeting notes',
    content_preview: 'Reformat these meeting notes',
    tool_name: 'write_file',
    occurred_at: 1740000100,
  },
  {
    id: 'sarah-w3-matter-brief',
    user_id: 'sarah-reeve',
    session_id: 's-003',
    content_full:
      'Build a running matter brief that updates daily across the open disclosure index',
    content_preview: null,
    tool_name: 'read_file',
    occurred_at: 1741200000,
  },
  {
    id: 'sarah-w4-hartley',
    user_id: 'sarah-reeve',
    session_id: 's-004',
    content_full:
      'Draft a response to external counsel on the Hartley disclosure question. ' +
      'Use the precedent from Reynolds case last March.',
    content_preview: null,
    tool_name: 'read_file',
    occurred_at: 1741900000,
  },
  {
    id: 'sarah-w5-bundle',
    user_id: 'sarah-reeve',
    session_id: 's-005',
    content_full: 'Run the bundle index across the five Hartley filings overnight',
    content_preview: null,
    tool_name: null,
    occurred_at: 1742500000,
  },
];

// Marcus, communications executive — 3 events
const marcusEvents: CoworkMessageRow[] = [
  {
    id: 'marcus-w1-press',
    user_id: 'marcus-jones',
    session_id: 'm-001',
    content_full: 'Reformat this press release',
    content_preview: null,
    tool_name: 'write_file',
    occurred_at: 1740000200,
  },
  {
    id: 'marcus-w4-competitor',
    user_id: 'marcus-jones',
    session_id: 'm-002',
    content_full:
      'Pull together a competitor briefing covering the three statements from this week',
    content_preview: null,
    tool_name: null,
    occurred_at: 1741900200,
  },
  {
    id: 'marcus-w5-overnight',
    user_id: 'marcus-jones',
    session_id: 'm-003',
    content_full:
      'Set up an overnight workflow to produce a daily competitor briefing for the exec team at 8am',
    content_preview: null,
    tool_name: null,
    occurred_at: 1742500200,
  },
];

// Priya, supply chain analyst — 3 events
const priyaEvents: CoworkMessageRow[] = [
  {
    id: 'priya-w1-reconcile',
    user_id: 'priya-kapoor',
    session_id: 'p-001',
    content_full: 'Reconcile this supplier data extract',
    content_preview: null,
    tool_name: null,
    occurred_at: 1740000300,
  },
  {
    id: 'priya-w4-scorecard',
    user_id: 'priya-kapoor',
    session_id: 'p-002',
    content_full:
      'Generate the monthly scorecard narrative with explanations for the three biggest variances',
    content_preview: null,
    tool_name: null,
    occurred_at: 1741900300,
  },
  {
    id: 'priya-w5-supplier-risk',
    user_id: 'priya-kapoor',
    session_id: 'p-003',
    content_full:
      'Produce a supplier risk assessment covering the fifteen suppliers by spend, looking forward',
    content_preview: null,
    tool_name: null,
    occurred_at: 1742500300,
  },
];

// ─── Expected API responses per persona ──────────────────────────────────────

function makeSarahApiResponse() {
  return JSON.stringify([
    {
      event_id: 'sarah-w1-summarise',
      tier: 1,
      task_type: 'summarisation',
      frontier_push_candidate: false,
      capability_creation_candidate: false,
      confidence: 0.95,
    },
    {
      event_id: 'sarah-w1-reformat',
      tier: 1,
      task_type: 'formatting',
      frontier_push_candidate: false,
      capability_creation_candidate: false,
      confidence: 0.95,
    },
    {
      event_id: 'sarah-w3-matter-brief',
      tier: 2,
      task_type: 'synthesis',
      frontier_push_candidate: true,
      capability_creation_candidate: false,
      confidence: 0.88,
    },
    {
      event_id: 'sarah-w4-hartley',
      tier: 3,
      task_type: 'capability_creation',
      frontier_push_candidate: true,
      capability_creation_candidate: true,
      confidence: 0.82,
    },
    {
      event_id: 'sarah-w5-bundle',
      tier: 3,
      task_type: 'autonomous_workflow',
      frontier_push_candidate: false,
      capability_creation_candidate: false,
      confidence: 0.9,
    },
  ]);
}

function makeMarcusApiResponse() {
  return JSON.stringify([
    {
      event_id: 'marcus-w1-press',
      tier: 1,
      task_type: 'formatting',
      frontier_push_candidate: false,
      capability_creation_candidate: false,
      confidence: 0.95,
    },
    {
      event_id: 'marcus-w4-competitor',
      tier: 2,
      task_type: 'synthesis',
      frontier_push_candidate: true,
      capability_creation_candidate: false,
      confidence: 0.87,
    },
    {
      event_id: 'marcus-w5-overnight',
      tier: 3,
      task_type: 'autonomous_workflow',
      frontier_push_candidate: true,
      capability_creation_candidate: true,
      confidence: 0.85,
    },
  ]);
}

function makePriyaApiResponse() {
  return JSON.stringify([
    {
      event_id: 'priya-w1-reconcile',
      tier: 1,
      task_type: 'transcription',
      frontier_push_candidate: false,
      capability_creation_candidate: false,
      confidence: 0.9,
    },
    {
      event_id: 'priya-w4-scorecard',
      tier: 2,
      task_type: 'structured_report',
      frontier_push_candidate: true,
      capability_creation_candidate: false,
      confidence: 0.88,
    },
    {
      event_id: 'priya-w5-supplier-risk',
      tier: 3,
      task_type: 'capability_creation',
      frontier_push_candidate: true,
      capability_creation_candidate: true,
      confidence: 0.84,
    },
  ]);
}

// ─── Helper to build a mocked Anthropic response ─────────────────────────────

function makeApiResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    model: 'claude-haiku-4-5-20251001',
    stop_reason: 'end_turn',
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('classifyBatch — Sarah, paralegal', () => {
  beforeEach(async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(makeApiResponse(makeSarahApiResponse()));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('classifies week-1 summarise as Tier 1, summarisation', async () => {
    const results = await classifyBatch(sarahEvents, 'claude-haiku-4-5-20251001');
    const r = results.find(x => x.cowork_message_id === 'sarah-w1-summarise')!;
    expect(r.tier).toBe(1);
    expect(r.task_type).toBe('summarisation');
    expect(r.frontier_push_candidate).toBe(false);
    expect(r.capability_creation_candidate).toBe(false);
    expect(r.classifier_status).toBe('classified');
  });

  it('classifies week-1 reformat as Tier 1, formatting', async () => {
    const results = await classifyBatch(sarahEvents, 'claude-haiku-4-5-20251001');
    const r = results.find(x => x.cowork_message_id === 'sarah-w1-reformat')!;
    expect(r.tier).toBe(1);
    expect(r.task_type).toBe('formatting');
    expect(r.frontier_push_candidate).toBe(false);
    expect(r.capability_creation_candidate).toBe(false);
  });

  it('classifies week-3 matter brief as Tier 2, synthesis, frontier_push=true', async () => {
    const results = await classifyBatch(sarahEvents, 'claude-haiku-4-5-20251001');
    const r = results.find(x => x.cowork_message_id === 'sarah-w3-matter-brief')!;
    expect(r.tier).toBe(2);
    expect(r.task_type).toBe('synthesis');
    expect(r.frontier_push_candidate).toBe(true);
    expect(r.capability_creation_candidate).toBe(false);
  });

  it('classifies week-4 Hartley as Tier 3, capability_creation, both candidates=true', async () => {
    const results = await classifyBatch(sarahEvents, 'claude-haiku-4-5-20251001');
    const r = results.find(x => x.cowork_message_id === 'sarah-w4-hartley')!;
    expect(r.tier).toBe(3);
    expect(r.task_type).toBe('capability_creation');
    expect(r.frontier_push_candidate).toBe(true);
    expect(r.capability_creation_candidate).toBe(true);
  });

  it('classifies week-5 bundle index as Tier 3, autonomous_workflow, frontier_push=false', async () => {
    const results = await classifyBatch(sarahEvents, 'claude-haiku-4-5-20251001');
    const r = results.find(x => x.cowork_message_id === 'sarah-w5-bundle')!;
    expect(r.tier).toBe(3);
    expect(r.task_type).toBe('autonomous_workflow');
    expect(r.frontier_push_candidate).toBe(false);
    expect(r.capability_creation_candidate).toBe(false);
  });

  it('sets classifier_model on all results', async () => {
    const results = await classifyBatch(sarahEvents, 'claude-haiku-4-5-20251001');
    for (const r of results) {
      expect(r.classifier_model).toBe('claude-haiku-4-5-20251001');
    }
  });
});

describe('classifyBatch — Marcus, communications executive', () => {
  beforeEach(async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(makeApiResponse(makeMarcusApiResponse()));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('classifies week-1 press release as Tier 1, formatting, no candidates', async () => {
    const results = await classifyBatch(marcusEvents, 'claude-haiku-4-5-20251001');
    const r = results.find(x => x.cowork_message_id === 'marcus-w1-press')!;
    expect(r.tier).toBe(1);
    expect(r.task_type).toBe('formatting');
    expect(r.frontier_push_candidate).toBe(false);
    expect(r.capability_creation_candidate).toBe(false);
  });

  it('classifies week-4 competitor briefing as Tier 2, synthesis, frontier_push=true', async () => {
    const results = await classifyBatch(marcusEvents, 'claude-haiku-4-5-20251001');
    const r = results.find(x => x.cowork_message_id === 'marcus-w4-competitor')!;
    expect(r.tier).toBe(2);
    expect(r.task_type).toBe('synthesis');
    expect(r.frontier_push_candidate).toBe(true);
    expect(r.capability_creation_candidate).toBe(false);
  });

  it('classifies week-5 overnight workflow as Tier 3, autonomous_workflow, both candidates=true', async () => {
    const results = await classifyBatch(marcusEvents, 'claude-haiku-4-5-20251001');
    const r = results.find(x => x.cowork_message_id === 'marcus-w5-overnight')!;
    expect(r.tier).toBe(3);
    expect(r.task_type).toBe('autonomous_workflow');
    expect(r.frontier_push_candidate).toBe(true);
    expect(r.capability_creation_candidate).toBe(true);
  });
});

describe('classifyBatch — Priya, supply chain analyst', () => {
  beforeEach(async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(makeApiResponse(makePriyaApiResponse()));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('classifies week-1 reconciliation as Tier 1, transcription, no candidates', async () => {
    const results = await classifyBatch(priyaEvents, 'claude-haiku-4-5-20251001');
    const r = results.find(x => x.cowork_message_id === 'priya-w1-reconcile')!;
    expect(r.tier).toBe(1);
    expect(r.task_type).toBe('transcription');
    expect(r.frontier_push_candidate).toBe(false);
    expect(r.capability_creation_candidate).toBe(false);
  });

  it('classifies week-4 scorecard as Tier 2, structured_report, frontier_push=true', async () => {
    const results = await classifyBatch(priyaEvents, 'claude-haiku-4-5-20251001');
    const r = results.find(x => x.cowork_message_id === 'priya-w4-scorecard')!;
    expect(r.tier).toBe(2);
    expect(r.task_type).toBe('structured_report');
    expect(r.frontier_push_candidate).toBe(true);
    expect(r.capability_creation_candidate).toBe(false);
  });

  it('classifies week-5 supplier risk assessment as Tier 3, capability_creation, both candidates=true', async () => {
    const results = await classifyBatch(priyaEvents, 'claude-haiku-4-5-20251001');
    const r = results.find(x => x.cowork_message_id === 'priya-w5-supplier-risk')!;
    expect(r.tier).toBe(3);
    expect(r.task_type).toBe('capability_creation');
    expect(r.frontier_push_candidate).toBe(true);
    expect(r.capability_creation_candidate).toBe(true);
  });
});

describe('classifyBatch — failure handling', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns failed status for all rows when API returns invalid JSON', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(makeApiResponse('this is not json'));

    const results = await classifyBatch([sarahEvents[0]], 'claude-haiku-4-5-20251001');
    expect(results).toHaveLength(1);
    expect(results[0].classifier_status).toBe('failed');
    expect(results[0].classifier_error).toContain('JSON parse error');
  });

  it('marks a specific row as failed when API omits it from the response', async () => {
    const mockCreate = await getMockCreate();
    // Return only the first event, omit the second
    mockCreate.mockResolvedValue(
      makeApiResponse(
        JSON.stringify([
          {
            event_id: 'sarah-w1-summarise',
            tier: 1,
            task_type: 'summarisation',
            frontier_push_candidate: false,
            capability_creation_candidate: false,
            confidence: 0.95,
          },
        ])
      )
    );

    const twoEvents = [sarahEvents[0], sarahEvents[1]];
    const results = await classifyBatch(twoEvents, 'claude-haiku-4-5-20251001');
    expect(results).toHaveLength(2);
    const first = results.find(r => r.cowork_message_id === 'sarah-w1-summarise')!;
    const second = results.find(r => r.cowork_message_id === 'sarah-w1-reformat')!;
    expect(first.classifier_status).toBe('classified');
    expect(second.classifier_status).toBe('failed');
    expect(second.classifier_error).toBe('Event not returned by API');
  });

  it('strips markdown fences from API response before parsing', async () => {
    const mockCreate = await getMockCreate();
    const json = makePriyaApiResponse();
    mockCreate.mockResolvedValue(makeApiResponse('```json\n' + json + '\n```'));

    const results = await classifyBatch(priyaEvents, 'claude-haiku-4-5-20251001');
    expect(results.every(r => r.classifier_status === 'classified')).toBe(true);
  });

  it('falls back to content_preview when content_full is null', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(
      makeApiResponse(
        JSON.stringify([
          {
            event_id: 'preview-only',
            tier: 1,
            task_type: 'summarisation',
            frontier_push_candidate: false,
            capability_creation_candidate: false,
            confidence: 0.8,
          },
        ])
      )
    );

    const row: CoworkMessageRow = {
      id: 'preview-only',
      user_id: 'u-1',
      session_id: null,
      content_full: null,
      content_preview: 'Preview text',
      tool_name: null,
      occurred_at: 1740000000,
    };

    const results = await classifyBatch([row], 'claude-haiku-4-5-20251001');
    expect(results[0].classifier_status).toBe('classified');
    // Verify that the user message built from the event contains the preview text
    const callArgs = mockCreate.mock.calls[0][0];
    const userMsg = callArgs.messages[0].content as string;
    expect(userMsg).toContain('Preview text');
  });
});

// The tier has always been validated; task_type never was, so whatever the
// model returned was stored verbatim. Every surface that groups by task_type —
// Work Mix, the session output rate breakdown, the FinOps activity axis — then
// carries a category the rubric never defined. An unrecognised value is a
// FAILED classification: visible in Classifier Health, retryable, never an
// invented category, and deliberately never coerced to a plausible default.
describe('classifyBatch — task_type taxonomy guard', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function apiItem(eventId: string, taskType: unknown) {
    return {
      event_id: eventId,
      tier: 2,
      task_type: taskType,
      frontier_push_candidate: false,
      capability_creation_candidate: false,
      confidence: 0.9,
    };
  }

  it('fails a row whose task_type is not in the taxonomy, naming the value', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(makeApiResponse(JSON.stringify([apiItem('sarah-w1-summarise', 'unknown')])));

    const results = await classifyBatch([sarahEvents[0]], 'claude-haiku-4-5-20251001');
    expect(results[0].classifier_status).toBe('failed');
    expect(results[0].classifier_error).toContain('task_type not in taxonomy');
    // The offending value is named so an admin can see what the model invented.
    expect(results[0].classifier_error).toContain('unknown');
  });

  it('fails free text the model invented rather than storing it as a category', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(makeApiResponse(JSON.stringify([apiItem('sarah-w1-summarise', 'Client reporting')])));

    const results = await classifyBatch([sarahEvents[0]], 'claude-haiku-4-5-20251001');
    expect(results[0].classifier_status).toBe('failed');
    expect(results[0].classifier_error).toContain('Client reporting');
  });

  it('fails a missing task_type rather than defaulting it', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(makeApiResponse(JSON.stringify([apiItem('sarah-w1-summarise', undefined)])));

    const results = await classifyBatch([sarahEvents[0]], 'claude-haiku-4-5-20251001');
    expect(results[0].classifier_status).toBe('failed');
    expect(results[0].classifier_error).toContain('task_type not in taxonomy');
  });

  it('still accepts a value the configured taxonomy defines', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(makeApiResponse(JSON.stringify([apiItem('sarah-w1-summarise', 'synthesis')])));

    const results = await classifyBatch([sarahEvents[0]], 'claude-haiku-4-5-20251001');
    expect(results[0].classifier_status).toBe('classified');
    expect(results[0].task_type).toBe('synthesis');
    expect(results[0].classifier_error).toBeNull();
  });

  it('fails only the offending row — a valid sibling in the same batch still classifies', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(
      makeApiResponse(
        JSON.stringify([
          apiItem('sarah-w1-summarise', 'summarisation'),
          apiItem('sarah-w1-reformat', 'client_reporting'),
        ])
      )
    );

    const results = await classifyBatch([sarahEvents[0], sarahEvents[1]], 'claude-haiku-4-5-20251001');
    const good = results.find(r => r.cowork_message_id === 'sarah-w1-summarise')!;
    const bad = results.find(r => r.cowork_message_id === 'sarah-w1-reformat')!;
    expect(good.classifier_status).toBe('classified');
    expect(bad.classifier_status).toBe('failed');
  });
});

describe('runClassifierJob — failure counter', () => {
  beforeEach(async () => {
    await sql.exec(`
      DELETE FROM pulse_classifications;
      DELETE FROM cowork_messages;
      DELETE FROM users;
    `);
    await seedUserSql(sql, 'u-1');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('increments attempt count when the API call throws', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockRejectedValue(new Error('Network error'));

    await sql.run(`
      INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, content_preview, occurred_at)
      VALUES ('msg-1', 'sess-1', 'u-1', 'cowork_user_message', 'cowork', 'Test content', 1740000000)
    `);

    await runClassifierJob();

    // A real pulse_classifications row should now exist with attempts=1,
    // status='failed' — the API-call-level failure path (incrementAttemptCounts).
    const row = (await sql.get(`SELECT classifier_attempts, classifier_status, classifier_error FROM pulse_classifications WHERE cowork_message_id = 'msg-1'`)) as { classifier_attempts: number; classifier_status: string; classifier_error: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.classifier_attempts).toBe(1);
    expect(row!.classifier_status).toBe('failed');
    expect(row!.classifier_error).toBe('API call failed');
  });

  it('marks classifier_status failed once attempts reach MAX_ATTEMPTS (5)', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockRejectedValue(new Error('Network error'));

    await sql.run(`
      INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, content_preview, occurred_at)
      VALUES ('msg-2', 'sess-2', 'u-1', 'cowork_user_message', 'cowork', 'Test content', 1740000000)
    `);
    // Pre-seed 4 prior attempts — the 5th (from this run) should flip status to 'failed'.
    await sql.run(`
      INSERT INTO pulse_classifications (
        cowork_message_id, user_id, tier, task_type, classifier_confidence,
        classifier_model, classifier_status, classifier_attempts, classifier_error, classified_at
      ) VALUES ('msg-2', 'u-1', 1, 'summarisation', 0, 'unknown', 'pending', 4, null, 1740000000)
    `);

    await runClassifierJob();

    const row = (await sql.get(`SELECT classifier_attempts, classifier_status FROM pulse_classifications WHERE cowork_message_id = 'msg-2'`)) as { classifier_attempts: number; classifier_status: string };
    expect(row.classifier_attempts).toBe(5);
    expect(row.classifier_status).toBe('failed');
  });

  it('does not query rows that have already failed max attempts (SQL uses >= 5)', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(makeApiResponse('[]'));

    await sql.run(`
      INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, content_preview, occurred_at)
      VALUES ('msg-3', 'sess-3', 'u-1', 'cowork_user_message', 'cowork', 'Test content', 1740000000)
    `);
    await sql.run(`
      INSERT INTO pulse_classifications (
        cowork_message_id, user_id, tier, task_type, classifier_confidence,
        classifier_model, classifier_status, classifier_attempts, classifier_error, classified_at
      ) VALUES ('msg-3', 'u-1', 1, 'summarisation', 0, 'unknown', 'failed', 5, 'API call failed', 1740000000)
    `);

    await runClassifierJob();

    // With no eligible rows (the only message has already exhausted MAX_ATTEMPTS), the API should never be called
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('buildClassifierUserMessage', () => {
  it('includes all event IDs in the user message', () => {
    const events = sarahEvents.slice(0, 2).map(r => ({
      id: r.id,
      user_id: r.user_id,
      session_id: r.session_id,
      content: r.content_full ?? r.content_preview ?? '',
      tool_name: r.tool_name,
      occurred_at: r.occurred_at,
    }));
    const history = new Map<string, UserHistory>([
      [
        'sarah-reeve',
        {
          user_id: 'sarah-reeve',
          prior_tiers_observed: [],
          prior_task_types_observed: [],
          prior_capability_creation_events: 0,
        },
      ],
    ]);
    const msg = buildClassifierUserMessage(events, history);
    expect(msg).toContain('sarah-w1-summarise');
    expect(msg).toContain('sarah-w1-reformat');
    expect(msg).toContain('USER HISTORY');
    expect(msg).toContain('EVENTS');
  });

  it('includes prior history for a user who has prior classifications', () => {
    const events = [sarahEvents[2]].map(r => ({
      id: r.id,
      user_id: r.user_id,
      session_id: r.session_id,
      content: r.content_full ?? r.content_preview ?? '',
      tool_name: r.tool_name,
      occurred_at: r.occurred_at,
    }));
    const history = new Map<string, UserHistory>([
      [
        'sarah-reeve',
        {
          user_id: 'sarah-reeve',
          prior_tiers_observed: [1],
          prior_task_types_observed: ['summarisation', 'formatting'],
          prior_capability_creation_events: 0,
        },
      ],
    ]);
    const msg = buildClassifierUserMessage(events, history);
    expect(msg).toContain('prior_tiers_observed: [1]');
    expect(msg).toContain('summarisation, formatting');
  });

  it('uses empty history for users with no prior classifications', () => {
    const events = [marcusEvents[0]].map(r => ({
      id: r.id,
      user_id: r.user_id,
      session_id: r.session_id,
      content: r.content_full ?? r.content_preview ?? '',
      tool_name: r.tool_name,
      occurred_at: r.occurred_at,
    }));
    // Pass empty history map — function should default to empty arrays
    const msg = buildClassifierUserMessage(events, new Map());
    expect(msg).toContain('prior_tiers_observed: []');
    expect(msg).toContain('prior_task_types_observed: []');
  });
});
