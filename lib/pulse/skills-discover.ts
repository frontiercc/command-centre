// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. The cache reads/writes are NOT registered
// AppConfig keys (skills_discover_cache / skills_discover_cached_at are internal-only, job-written rows with
// no encryption and no UI exposure), so routing through lib/config.ts's
// setConfigValue would require adding them to its typed key registry — out of
// this task's scope. Instead this applies lib/config.ts's OWN blessed
// pattern verbatim, locally: getTypedClient() + schema.config,
// onConflictDoUpdate for the upsert (preserving the exact ON CONFLICT
// clause), app-clock timestamp. The
// two-row write stays two sequentially-awaited statements (no withTx) — the
// original db.transaction() here was a same-process batching convenience,
// not a correctness requirement (getDiscoverCache already reads the two rows
// with two independent, non-transactional SELECTs), so this does not invent
// new atomicity that wasn't actually relied upon.
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from '@/lib/anthropic/client';
import { getOrgBriefingModel } from '@/lib/anthropic/model';
import { eq, sql } from 'drizzle-orm';
import { getConfigValue } from '@/lib/config';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export interface DiscoveredSkill {
  name: string;
  description: string;
  source_url: string;
  category: 'skill' | 'connector' | 'official';
  published_at: string | null;
}

const CACHE_KEY = 'skills_discover_cache';
const CACHE_AT_KEY = 'skills_discover_cached_at';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export async function getDiscoverCache(): Promise<{
  items: DiscoveredSkill[];
  cached_at: string | null;
  is_stale: boolean;
}> {
  const client = await getTypedClient();
  const t = schema.config;

  const cacheRows = await client.select({ value: t.value }).from(t).where(eq(t.key, CACHE_KEY)).limit(1);
  const cachedAtRows = await client.select({ value: t.value }).from(t).where(eq(t.key, CACHE_AT_KEY)).limit(1);

  const cached_at = cachedAtRows[0]?.value ?? null;
  const is_stale = !cached_at || Date.now() - new Date(cached_at).getTime() > SEVEN_DAYS_MS;

  let items: DiscoveredSkill[] = [];
  if (cacheRows[0]?.value) {
    try { items = JSON.parse(cacheRows[0].value); } catch { /* ignore */ }
  }

  return { items, cached_at, is_stale };
}

async function setDiscoverCache(items: DiscoveredSkill[]): Promise<void> {
  const client = await getTypedClient();
  const t = schema.config;
  const now = new Date().toISOString();
  const nowS = Math.floor(Date.now() / 1000); // app clock

  async function upsert(key: string, value: string): Promise<void> {
    await client
      .insert(t)
      .values({ key, value, updated_at: nowS })
      .onConflictDoUpdate({
        target: t.key,
        set: { value: sql`excluded.value`, updated_at: sql`excluded.updated_at` },
      });
  }

  await upsert(CACHE_KEY, JSON.stringify(items));
  await upsert(CACHE_AT_KEY, now);
}

function discoverPrompt(now: Date): string {
  const today = now.toISOString().slice(0, 10);
  const year = now.getUTCFullYear();
  return `The current date is ${today}. Search the web for recently published Claude Code skills and MCP connectors. Search for:
- New Claude Code slash command skills on GitHub (e.g. "claude code skills plugin github ${year}")
- Official Anthropic Claude skills announcements
- New community MCP servers and connectors (e.g. "new model context protocol server ${year}")

Return ONLY a JSON array (no other text, no markdown fences) of up to 15 items with this exact structure:
[
  {
    "name": "short-identifier or display name",
    "description": "One sentence describing what it does and who it helps.",
    "source_url": "https://the-actual-url",
    "category": "skill or connector or official",
    "published_at": "YYYY-MM-DD or YYYY-MM or null if unknown"
  }
]

Only include items that appear to be from the last 3 months. If you cannot find recent items, return an empty array [].`;
}

export async function runSkillsDiscover(): Promise<DiscoveredSkill[]> {
  const apiKey = await getConfigValue('anthropicAiApiKey');
  if (!apiKey) throw new Error('No AI API key configured');

  const client = createAnthropicClient(apiKey);
  // The organisation briefing model, chosen in Admin → Work Pulse.
  const model = await getOrgBriefingModel();
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: discoverPrompt(new Date()) }];

  for (let turn = 0; turn < 8; turn++) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      tools: [{ type: 'web_search_20260209' as const, name: 'web_search' }],
      messages,
    });

    if (response.stop_reason === 'end_turn') {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('');

      try {
        const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        // The model can put a sentence before the list, so read from the first [ to the last ].
        const start = cleaned.indexOf('[');
        const end = cleaned.lastIndexOf(']');
        const parsed = JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned);
        if (Array.isArray(parsed)) {
          const items = parsed as DiscoveredSkill[];
          await setDiscoverCache(items);
          return items;
        }
      } catch { /* ignore parse errors */ }
      return [];
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map(b => ({
          type: 'tool_result' as const,
          tool_use_id: b.id,
          content: '',
        }));

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }
  }

  return [];
}
