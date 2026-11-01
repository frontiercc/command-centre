// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The server side of lib/sources/connected-shared.ts: works out which vendors
// are connected from the keys saved and the data already stored.
//
// The Anthropic API key (anthropicAiApiKey) is deliberately not a Claude
// connection: it is the engine for tiers, Work Mix, briefings and alerts, and
// an OpenAI-only install needs it too.
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { getConfigValue } from '@/lib/config';
import { vendorClause } from '@/lib/dashboard/product-sql';
import type { ConnectedProducts } from './connected-shared';

export type { ConnectedProducts } from './connected-shared';
export { isOpenAiOnly } from './connected-shared';

interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[] }>;
}

const CLAUDE_KEYS = ['complianceAccessKey', 'anthropicAdminApiKey', 'anthropicAnalyticsApiKey'] as const;

export async function getConnectedProducts(): Promise<ConnectedProducts> {
  const keys = await Promise.all([...CLAUDE_KEYS, 'openaiAdminApiKey' as const].map((k) => getConfigValue(k)));
  const claudeKey = keys.slice(0, CLAUDE_KEYS.length).some((v) => !!v);
  const openaiKey = !!keys[CLAUDE_KEYS.length];
  if (claudeKey && openaiKey) return { claude: true, openai: true };

  const client = (await getTypedClient()) as unknown as RawFacade;
  const exists = async (q: unknown): Promise<boolean> => {
    try {
      const res = await client.execute(q);
      return res.rows.length > 0;
    } catch {
      return false;
    }
  };
  const [claudeRows, chatRows, metricRows, openaiRows] = await Promise.all([
    claudeKey ? true : exists(sql`SELECT 1 FROM cowork_messages WHERE ${sql.raw(vendorClause('claude'))} LIMIT 1`),
    claudeKey ? true : exists(sql`SELECT 1 FROM chat_messages LIMIT 1`),
    claudeKey ? true : exists(sql`SELECT 1 FROM code_otel_metrics LIMIT 1`),
    openaiKey ? true : exists(sql`SELECT 1 FROM cowork_messages WHERE ${sql.raw(vendorClause('openai'))} LIMIT 1`),
  ]);
  return { claude: claudeRows || chatRows || metricRows, openai: openaiRows };
}
