// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom intent category persistence.
 *
 * Stores admin-defined intent categories as JSON in the config table.
 * Config key: 'intent_custom_categories'
 *
 * Async Drizzle on Postgres via getTypedClient(). getCustomCategories() is
 * awaited by the OTel ingest receivers (lib/otel/cowork-receiver.ts,
 * lib/otel/code-receiver.ts) and the chat/cowork agent-ingest routes.
 *
 * saveCustomCategories uses the same insert().onConflictDoUpdate() +
 * app-clock-timestamp shape lib/config.ts's setConfigValue uses (kept as a
 * standalone write rather than routed through
 * setConfigValue, which only knows the typed AppConfig key set — this key,
 * 'intent_custom_categories', isn't one of them, and threading it through
 * would mean widening AppConfig for a key nothing else reads by that route).
 */
import { eq, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import type { IntentCategory } from './types';

const CONFIG_KEY = 'intent_custom_categories';

export async function getCustomCategories(): Promise<IntentCategory[]> {
  try {
    const db = await getTypedClient();
    const t = schema.config;
    const rows = await db.select({ value: t.value }).from(t).where(eq(t.key, CONFIG_KEY)).limit(1);
    const row = rows[0];
    if (!row) return [];
    return JSON.parse(row.value);
  } catch {
    return [];
  }
}

export async function saveCustomCategories(categories: IntentCategory[]): Promise<void> {
  const db = await getTypedClient();
  const t = schema.config;
  const nowS = Math.floor(Date.now() / 1000); // app clock
  await db
    .insert(t)
    .values({ key: CONFIG_KEY, value: JSON.stringify(categories), updated_at: nowS })
    .onConflictDoUpdate({
      target: t.key,
      set: { value: sql`excluded.value`, updated_at: sql`excluded.updated_at` },
    });
}
