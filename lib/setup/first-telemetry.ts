// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Records when the first real Claude Code or Cowork telemetry reached this
 * install, for the dashboard's "Get started" panel (lib/setup/status.ts).
 *
 * Called only by the OTel ingest route, so sample data, which is written
 * straight into the tables, never sets it. The first arrival is kept: the
 * insert does nothing once the key exists, and each process stops writing
 * after its first success.
 */
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { logError } from '@/lib/api/errors';

export type SetupProduct = 'code' | 'cowork';

export const FIRST_TELEMETRY_KEYS: Record<SetupProduct, string> = {
  code: 'setup_first_code_at',
  cowork: 'setup_first_cowork_at',
};

const noted = new Set<SetupProduct>();

/** Never throws: a failure here must not affect ingest. */
export async function noteFirstTelemetry(product: SetupProduct, nowS = Math.floor(Date.now() / 1000)): Promise<void> {
  if (noted.has(product)) return;
  try {
    const client = await getTypedClient();
    await client
      .insert(schema.config)
      .values({ key: FIRST_TELEMETRY_KEYS[product], value: String(nowS), updated_at: nowS })
      .onConflictDoNothing();
    noted.add(product);
  } catch (err) {
    logError('Setup first telemetry', err);
  }
}

/** Tests only: forget what this process has already written. */
export function resetFirstTelemetryForTests(): void {
  noted.clear();
}
