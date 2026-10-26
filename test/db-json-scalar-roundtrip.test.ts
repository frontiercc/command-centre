// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Regression test for the jsonToText scalar-string edge case (task 3.1c
// review fix, lib/db/json.ts). A jsonb column that holds a bare JSON STRING
// SCALAR (e.g. the jsonb value `"foo"`, as opposed to an object like
// `{"foo":1}`): postgres's jsonb codec parses it to the plain JS string `foo`
// (no quotes) on read. Before the fix, jsonToText's `typeof v === 'string' ->
// passthrough` branch returned that UNQUOTED string instead of the encoded
// JSON text the caller stored. This test proves the encoded string (quotes
// included) round-trips unchanged.
//
// HARNESS RULE (copied from queries-alerts-pg.test.ts): queries.ts reaches
// the database through getClient(), which binds to DATABASE_URL on first
// use, so the module-under-test is DYNAMIC-imported AFTER
// createTestDbClient() has set DATABASE_URL + reset modules.
import { describe, it, expect } from 'vitest';
async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { cleanup } = await createTestDbClient('postgres');
  try {
    // Dynamic import AFTER the DATABASE_URL env + module reset (harness rule).
    const { insertAlert, getAlertById } = await import('@/lib/db/queries');

    // raw_evidence holds a bare JSON string SCALAR — the exact edge case
    // jsonToText's fix covers.
    const scalarJson = JSON.stringify('a plain scalar string value');
    await insertAlert({
      id: 'alert-scalar-1',
      user_id: null,
      alert_type: 'risk',
      severity: 'low',
      title: 'Scalar',
      explanation: 'exp',
      raw_evidence: scalarJson,
    });

    const row = await getAlertById('alert-scalar-1');
    // Must round-trip to the EXACT same encoded string — quotes included — not the unquoted decoded value.
    expect(row?.raw_evidence).toBe(scalarJson);
    expect(typeof row?.raw_evidence).toBe('string');
    expect(JSON.parse(row!.raw_evidence!)).toBe('a plain scalar string value');

    // Sanity check the pre-existing object-shaped path still works too
    // (the only shape exercised by queries-alerts-pg.test.ts).
    const objectJson = JSON.stringify({ pii_type: 'email' });
    await insertAlert({
      id: 'alert-object-1',
      user_id: null,
      alert_type: 'policy',
      severity: 'high',
      title: 'Object',
      explanation: 'exp',
      raw_evidence: objectJson,
    });
    const objectRow = await getAlertById('alert-object-1');
    expect(objectRow?.raw_evidence).toBe(objectJson);
  } finally {
    await cleanup();
  }
}

describe('jsonToText scalar-string round trip', () => {
  it(
    'round-trips a bare JSON string scalar raw_evidence value unchanged — proves the fix in lib/db/json.ts',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
