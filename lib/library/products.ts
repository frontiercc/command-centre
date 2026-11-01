// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Which products an S&C Board entry is used in, from its uses: Claude
// (Cowork, Code and Chat), ChatGPT (Chat and Work) and Codex. A skill or
// connector name can be used in more than one; an entry with no uses yet
// (an official skill, or one submitted by hand) has none.
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';

export type BoardProduct = 'Claude' | 'ChatGPT' | 'Codex';
const ORDER: BoardProduct[] = ['Claude', 'ChatGPT', 'Codex'];

export function productOf(source: string | null | undefined): BoardProduct {
  if (source === 'chatgpt_chat' || source === 'chatgpt_work') return 'ChatGPT';
  if (source === 'codex') return 'Codex';
  return 'Claude';
}

interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[] }>;
}

/** Products per entry name, from skill uses (skills) and connector calls (connectors). */
export async function entryProducts(entries: Array<{ name: string; type: string }>): Promise<Map<string, BoardProduct[]>> {
  const out = new Map<string, BoardProduct[]>();
  const skills = [...new Set(entries.filter(e => e.type !== 'connector').map(e => e.name))];
  const connectors = [...new Set(entries.filter(e => e.type === 'connector').map(e => e.name))];
  const raw = (await getTypedClient()) as unknown as RawFacade;
  const collect = (rows: unknown[]) => {
    const seen = new Map<string, Set<BoardProduct>>();
    for (const r of rows as Array<{ name: string; source: string | null }>) {
      const set = seen.get(r.name) ?? new Set<BoardProduct>();
      set.add(productOf(r.source));
      seen.set(r.name, set);
    }
    for (const [name, set] of seen) out.set(name, ORDER.filter(p => set.has(p)));
  };
  const list = (names: string[]) => sql.join(names.map(n => sql`${n}`), sql`, `);
  if (skills.length) {
    collect((await raw.execute(sql`
      SELECT DISTINCT skill_name AS name, source FROM cowork_skill_invocations WHERE skill_name IN (${list(skills)})`)).rows);
  }
  if (connectors.length) {
    collect((await raw.execute(sql`
      SELECT DISTINCT mcp_server AS name, source FROM cowork_mcp_invocations WHERE mcp_server IN (${list(connectors)})`)).rows);
  }
  return out;
}
