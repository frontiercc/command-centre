// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// A skill codified by "Turn this into a skill" is stored on the S&C Board under
// its plain name (skill_library_entries.name, linked from
// use_case_skill_drafts.library_entry_id). Once someone uploads it to the
// claude.ai organisation library, its skill_activated telemetry may arrive
// either as that plain name or marketplace-prefixed
// ("acme-library:variance-commentary"), the way Anthropic's own arrive as
// "anthropic-skills:docx". Every Board usage query matches skill_name = e.name
// exactly, so a prefixed form would read 0 uses on the codified entry and
// auto-register a duplicate unclaimed one.
//
// This is the SINGLE normalisation point, applied at ingest by both OTel
// receivers, so that everything downstream reading cowork_skill_invocations —
// the Board card, the use case tracker, spread, Activate, FinOps leverage and
// the "Powers these workflows" card — agrees without each one learning about
// prefixes. The prefix itself is NOT kept: once normalised, the invocation row
// no longer records which marketplace form the event arrived in. This absorbs
// ANY marketplace prefix, not just acme-library: — a name codified from
// "sales:call-summary" counts on an org skill named "call-summary" too, and
// the prefix it actually arrived under is not retained.
//
// Deliberately narrow: only a name whose bare suffix matches a CODIFIED Board
// entry (one a draft links to) is rewritten. Anything else, including a name
// on the known-Anthropic allowlist (callers check isKnownAnthropicSkill on the
// raw name first), is stored exactly as today.
import { eq, sql } from 'drizzle-orm';
import type { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

type TxClient = Awaited<ReturnType<typeof getTypedClient>>;

/** The suffix after the LAST ':' — null when there is no colon or the suffix is empty. */
export function bareSkillName(raw: string): string | null {
  const i = raw.lastIndexOf(':');
  if (i === -1) return null;
  const bare = raw.slice(i + 1);
  return bare.length > 0 ? bare : null;
}

/**
 * Resolve a raw skill.name to the name its invocation should be stored under.
 * `codified: true` means the name matched a codified Board entry, so the caller
 * stores the bare name and must NOT auto-register a Board entry for it. The
 * bare suffix is matched case-insensitively (parity with the use-case
 * tracker's suffix-aware signalMatches) — the row is stored under the Board
 * entry's own exact `name`, not the raw suffix's casing.
 */
export async function resolveCodifiedSkillName(
  tx: TxClient,
  raw: string,
): Promise<{ name: string; codified: boolean }> {
  const bare = bareSkillName(raw);
  if (bare === null) return { name: raw, codified: false };
  const rows = await tx
    .select({ name: schema.skillLibraryEntries.name })
    .from(schema.skillLibraryEntries)
    .innerJoin(schema.useCaseSkillDrafts, eq(schema.useCaseSkillDrafts.library_entry_id, schema.skillLibraryEntries.id))
    .where(sql`lower(${schema.skillLibraryEntries.name}) = lower(${bare})`)
    .limit(1);
  return rows.length > 0 ? { name: rows[0].name, codified: true } : { name: raw, codified: false };
}
