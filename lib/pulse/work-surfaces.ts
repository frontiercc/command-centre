// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The prompts Work Pulse reads: Cowork (ChatGPT Chat and Work are stored as
// Cowork too) and Claude Chat, which is stored in cowork_messages with
// surface 'chat'. Claude Code ('code') is Developer Pulse's.
import { sql, type SQL } from 'drizzle-orm';
import { getConfigValue } from '@/lib/config';
import { OPENAI_SOURCES } from '@/lib/openai/sources';

export const WORK_PULSE_SURFACES = ['cowork', 'chat'] as const;

/**
 * `<column> IN ('cowork', 'chat')`, for a Drizzle column or a raw column
 * reference such as sql`cm.surface`. `withNull` also takes NULL-surface rows,
 * which older capture wrote for Cowork.
 */
export function isWorkPulseSurface(column: unknown, withNull = false): SQL {
  const list = sql.join(WORK_PULSE_SURFACES.map(s => sql`${s}`), sql`, `);
  return withNull
    ? sql`(${column} IN (${list}) OR ${column} IS NULL)`
    : sql`${column} IN (${list})`;
}

/** Whether the classifier judges ChatGPT prompts (Admin → Work Pulse; default on). */
export async function classifyChatgptOn(): Promise<boolean> {
  return (await getConfigValue('pulseClassifyChatgpt')) !== 'false';
}

/**
 * The prompts the classifier may judge, by source: every source while ChatGPT
 * classification is on, otherwise everything but OpenAI's. Used by the
 * classifier and by every "awaiting classification" count, so a queue never
 * holds prompts the classifier will not pick up.
 */
export function classifiableSource(column: unknown, classifyChatgpt: boolean): SQL {
  if (classifyChatgpt) return sql`TRUE`;
  const list = sql.join(OPENAI_SOURCES.map(s => sql`${s}`), sql`, `);
  return sql`(${column} IS NULL OR ${column} NOT IN (${list}))`;
}
