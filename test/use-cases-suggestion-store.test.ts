// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';

let cleanup: () => Promise<void>;

let store: typeof import('@/lib/usecases/suggestion-store');

beforeAll(async () => {
  const testDb = await createTestDatabase();
  cleanup = testDb.cleanup;

  store = await import('@/lib/usecases/suggestion-store');
});

afterAll(async () => cleanup());

describe('suggestion store (migration 058)', () => {
  it('computeSignalKey is order-independent and deterministic', () => {
    const { computeSignalKey } = store;
    const a = computeSignalKey({ skills: ['b', 'a'], connectors: ['x'], taskTypes: [] });
    const b = computeSignalKey({ skills: ['a', 'b'], connectors: ['x'], taskTypes: [] });
    expect(a).toBe(b);
    expect(a).not.toBe(computeSignalKey({ skills: ['a'], connectors: ['x'], taskTypes: [] }));
  });

  it('upsert inserts an open row and listOpenSuggestions returns it', async () => {
    await store.upsertOpenSuggestion({
      signalKey: 'k1', title: 'Research briefs', description: 'desc',
      matchingRule: { skills: ['deep-research'], connectors: ['notion'], taskTypes: [], departments: ['Marketing'] },
      evidence: { distinctUsers: 9, sessionCount: 40, departments: ['Marketing'] }, nowS: 1000,
    });
    const open = await store.listOpenSuggestions();
    expect(open).toHaveLength(1);
    expect(open[0].title).toBe('Research briefs');
    expect(open[0].matchingRule.skills).toEqual(['deep-research']);
    expect(open[0].evidence.distinctUsers).toBe(9);
  });

  it('upsert does NOT reopen a dismissed/added row but refreshes an open one', async () => {
    const base = { signalKey: 'k2', matchingRule: { skills: ['s'], connectors: [], taskTypes: [], departments: [] }, evidence: { distinctUsers: 3, sessionCount: 3, departments: [] } };
    await store.upsertOpenSuggestion({ ...base, title: 'v1', description: null, nowS: 1 });
    const id = (await store.listOpenSuggestions()).find(s => s.signalKey === 'k2')!.id;
    await store.setSuggestionStatus(id, 'dismissed');
    await store.upsertOpenSuggestion({ ...base, title: 'v2', description: null, nowS: 2 }); // same key, now dismissed
    expect((await store.listOpenSuggestions()).find(s => s.signalKey === 'k2')).toBeUndefined(); // stayed dismissed
    expect((await store.getSuggestionById(id))!.status).toBe('dismissed');
    expect((await store.getSuggestionById(id))!.title).toBe('v1'); // not overwritten
    expect((await store.resolvedSignalKeys()).has('k2')).toBe(true);
  });

  it('setSuggestionStatus can mark a row added', async () => {
    await store.upsertOpenSuggestion({
      signalKey: 'k3', title: 'Added one', description: null,
      matchingRule: { skills: [], connectors: [], taskTypes: [], departments: [] },
      evidence: { distinctUsers: 1, sessionCount: 1, departments: [] }, nowS: 5,
    });
    const id = (await store.listOpenSuggestions()).find(s => s.signalKey === 'k3')!.id;
    await store.setSuggestionStatus(id, 'added');
    expect((await store.getSuggestionById(id))!.status).toBe('added');
    expect((await store.resolvedSignalKeys()).has('k3')).toBe(true);
    expect((await store.listOpenSuggestions()).find(s => s.signalKey === 'k3')).toBeUndefined();
  });
});
