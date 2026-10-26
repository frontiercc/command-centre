// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Delete an S&C Board entry. Admins and managers can delete
 * ANY entry from its card. For an ordinary auto-discovered entry this is
 * delete-only: the card goes, and telemetry re-registers the name unclaimed the
 * next time someone uses it (chosen over a hidden list). For a CODIFIED skill
 * (a use_case_skill_drafts row points at the entry) deleting also undoes the
 * codification: the skill name comes off the use case's matching rule and the
 * draft goes back to "not yet downloaded", so the owner can fix it and
 * download again or Discard it. Recorded usage history is left alone.
 */
import { eq } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getUseCase, updateUseCase } from '@/lib/usecases/queries';
import { resetCodified } from '@/lib/usecases/skill-draft-store';

export interface DeletedEntry {
  id: number;
  name: string;
  /** Set when the entry was a codified skill; the use case whose draft was reset. */
  codified: { useCaseId: string } | null;
}

export async function deleteLibraryEntry(id: number): Promise<DeletedEntry | null> {
  const client = await getTypedClient();
  const e = schema.skillLibraryEntries;
  const t = schema.useCaseSkillDrafts;
  const v = schema.skillLibraryVotes;

  const rows = await client.select({ id: e.id, name: e.name }).from(e).where(eq(e.id, id)).limit(1);
  if (!rows[0]) return null;
  const name = rows[0].name;

  let codified: DeletedEntry['codified'] = null;
  const drafts = await client.select({ use_case_id: t.use_case_id }).from(t).where(eq(t.library_entry_id, id));
  for (const d of drafts) {
    const uc = await getUseCase(d.use_case_id);
    if (uc && uc.skills.includes(name)) {
      await updateUseCase(uc.id, { skills: uc.skills.filter(s => s !== name) });
    }
    await resetCodified(d.use_case_id);
    codified = { useCaseId: d.use_case_id };
  }

  // Votes carry ON DELETE CASCADE; they are deleted explicitly as well, which
  // is harmless and keeps the order visible.
  await client.delete(v).where(eq(v.entry_id, id));
  await client.delete(e).where(eq(e.id, id));
  return { id, name, codified };
}
