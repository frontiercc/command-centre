// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Names for alert text. An alert's title and explanation must never carry a
 * raw user id: Claude Code's OTel id is a 64-character hash, and the Slack
 * sweep sends the stored text as it is (only the Alerts page swaps a name in
 * on read), so a high spend spike would reach Slack
 * as "<64-character id> spent $127.53…".
 *
 * The name is looked up the way the Alerts page does (getAlerts in
 * lib/db/queries.ts: linked admin account's display name, then the users
 * row's), with the email as the last resort.
 */
import { eq, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export const UNKNOWN_PERSON = 'An unknown user';

export async function personLabel(userId: string): Promise<string> {
  const client = await getTypedClient();
  const u = schema.users;
  const au = schema.adminUsers;
  const rows = await client
    .select({ label: sql<string | null>`COALESCE(${au.display_name}, ${u.display_name}, ${u.email})` })
    .from(u)
    .leftJoin(au, eq(au.linked_cowork_user_id, u.id))
    .where(eq(u.id, userId))
    .limit(1);
  return rows[0]?.label || UNKNOWN_PERSON;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces every known user id in model-written text with the person's name.
 * Matches the full id and any shortened form the model may write (the first
 * 8 or more characters, optionally followed by an ellipsis).
 */
export async function replaceUserIdsWithNames(text: string, userIds: Iterable<string>): Promise<string> {
  let out = text;
  for (const id of new Set(userIds)) {
    if (!id || id.length < 8) continue;
    const pattern = new RegExp(`${escapeRegExp(id.slice(0, 8))}[0-9A-Za-z-]*(?:\\.\\.\\.|…)?`, 'g');
    // A hit is the id, a shortened id, or the id followed by a hyphenated word.
    const hits = (out.match(pattern) ?? [])
      .map(h => {
        const core = h.replace(/(\.\.\.|…)$/, '');
        if (id.startsWith(core)) return h;
        if (core.startsWith(id)) return id;
        return null;
      })
      .filter((h): h is string => h !== null)
      .sort((a, b) => b.length - a.length);
    if (hits.length === 0) continue;
    const name = await personLabel(id);
    for (const h of hits) out = out.split(h).join(name);
  }
  return out;
}
