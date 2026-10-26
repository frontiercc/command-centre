// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

describe('computeSeats (pure)', () => {
  it('computes unused + estUnusedUsd when priced', async () => {
    const { computeSeats } = await import('@/lib/finance/seats');
    expect(computeSeats(100, 60, 50)).toEqual({
      licensed: 100,
      activeUsers30d: 60,
      unused: 40,
      monthlyPriceUsd: 50,
      estUnusedUsd: 2000,
    });
  });

  it('clamps unused to 0 when active exceeds licensed, estUnusedUsd 0 when priced', async () => {
    const { computeSeats } = await import('@/lib/finance/seats');
    expect(computeSeats(100, 120, 50)).toEqual({
      licensed: 100,
      activeUsers30d: 120,
      unused: 0,
      monthlyPriceUsd: 50,
      estUnusedUsd: 0,
    });
  });

  it('returns estUnusedUsd: null when price is null', async () => {
    const { computeSeats } = await import('@/lib/finance/seats');
    expect(computeSeats(100, 60, null)).toEqual({
      licensed: 100,
      activeUsers30d: 60,
      unused: 40,
      monthlyPriceUsd: null,
      estUnusedUsd: null,
    });
  });
});

describe('getSeatsSummary', () => {
  let sql: TestSql;
  let cleanup: () => Promise<void>;
  // first_seen_at/last_seen_at for seeded users (bound as a parameter).
  const SEED_NOW = Math.floor(Date.now() / 1000);
  let getSeatsSummary: typeof import('@/lib/finance/seats').getSeatsSummary;
  let setConfigValue: typeof import('@/lib/config').setConfigValue;

  const NOW_S = Math.floor(Date.UTC(2026, 8, 4) / 1000); // 2026-09-04, UTC epoch seconds
  const RECENT = NOW_S - 5 * 86400; // 5 days ago — inside the 30-day window
  const STALE = NOW_S - 90 * 86400; // 90 days ago — outside the 30-day window

  beforeAll(async () => {
    const t = await createTestDatabase();
    sql = t.sql;
    cleanup = t.cleanup;

    const seatsMod = await import('@/lib/finance/seats');
    getSeatsSummary = seatsMod.getSeatsSummary;
    const configMod = await import('@/lib/config');
    setConfigValue = configMod.setConfigValue;

    // Users first (cowork_messages.user_id has a FK to users(id)).
    for (const id of ['wi-s-user-1', 'wi-s-user-2', 'wi-s-user-3']) {
      await sql.run(
        `INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, 'otel', ?, ?)`,
        [id, `${id}@test.com`, id, SEED_NOW, SEED_NOW]);
    }

    // Two distinct active users with recent cowork_messages activity.
    await sql.run(
      `INSERT INTO cowork_messages (id, session_id, user_id, message_type, occurred_at)
       VALUES (?, ?, ?, 'cowork_user_message', ?)`,
      ['wi-s-cw-1', 'wi-s-sess-1', 'wi-s-user-1', RECENT]);
    await sql.run(
      `INSERT INTO cowork_messages (id, session_id, user_id, message_type, occurred_at)
       VALUES (?, ?, ?, 'cowork_user_message', ?)`,
      ['wi-s-cw-2', 'wi-s-sess-2', 'wi-s-user-2', RECENT]);
    // A duplicate-user row (should not double-count) + a stale row (outside window,
    // should not count) for the same "user-1" — proves the 30-day filter and the
    // DISTINCT both hold.
    await sql.run(
      `INSERT INTO cowork_messages (id, session_id, user_id, message_type, occurred_at)
       VALUES (?, ?, ?, 'cowork_user_message', ?)`,
      ['wi-s-cw-3', 'wi-s-sess-1', 'wi-s-user-1', RECENT]);
    await sql.run(
      `INSERT INTO cowork_messages (id, session_id, user_id, message_type, occurred_at)
       VALUES (?, ?, ?, 'cowork_user_message', ?)`,
      ['wi-s-cw-4', 'wi-s-sess-3', 'wi-s-user-3', STALE]);
  });

  afterAll(async () => cleanup());

  it('returns null when licensedSeats is unset', async () => {
    await setConfigValue('licensedSeats', '');
    const result = await getSeatsSummary(NOW_S);
    expect(result).toBeNull();
  });

  it('returns null when licensedSeats is invalid (<= 0 or non-numeric)', async () => {
    await setConfigValue('licensedSeats', '0');
    expect(await getSeatsSummary(NOW_S)).toBeNull();
    await setConfigValue('licensedSeats', 'abc');
    expect(await getSeatsSummary(NOW_S)).toBeNull();
  });

  it('computes activeUsers30d + unused from DISTINCT recent activity when licensedSeats is set', async () => {
    await setConfigValue('licensedSeats', '5');
    await setConfigValue('finopsSeatPriceMonthly', '');
    const result = await getSeatsSummary(NOW_S);
    expect(result).toEqual({
      licensed: 5,
      activeUsers30d: 2,
      unused: 3,
      monthlyPriceUsd: null,
      estUnusedUsd: null,
    });
  });

  it('includes the priced estimate when finopsSeatPriceMonthly is set', async () => {
    await setConfigValue('licensedSeats', '5');
    await setConfigValue('finopsSeatPriceMonthly', '20');
    const result = await getSeatsSummary(NOW_S);
    expect(result).toEqual({
      licensed: 5,
      activeUsers30d: 2,
      unused: 3,
      monthlyPriceUsd: 20,
      estUnusedUsd: 60,
    });
  });
});
