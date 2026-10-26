// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The zip and the first-download side effects for "Turn this into a skill".
 * The zip is the exact shape the claude.ai
 * organisation library upload accepts: a folder named after the skill with
 * SKILL.md inside. The first download does two things, once: adds the skill
 * name to the use case's matching rule (so tracking starts the day it is
 * used) and creates the claimed S&C Board entry (Option A).
 * Author resolution follows the PSR-baselines lesson: resolve the users row
 * by the admin session's EMAIL first, only then insert a fresh row keyed by
 * the session's userId — never assume session.userId is a valid new users.id
 * while also writing session.email.
 */
import { Writable } from 'node:stream';
import archiver from 'archiver';
import { eq } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getUseCase, updateUseCase, type UseCase } from '@/lib/usecases/queries';
import { bootstrapUseCase } from '@/lib/usecases/tracker';
import { markDownloaded, type SkillDraftRecord } from '@/lib/usecases/skill-draft-store';

export interface Actor { userId: string; email: string }

export const INSTALL_GUIDE_TEXT =
  'Open this skill’s card on the S&C Board and click Download skill (admins and managers). Upload the zip in Organisation settings → Plugins & skills.';

export function buildFrontmatter(draft: SkillDraftRecord, department: string | null, sourceTitle: string): string {
  const status = draft.editedAt ? 'owner-reviewed' : 'draft-for-owner-review';
  return [
    '---',
    `name: ${draft.skillName}`,
    `description: ${JSON.stringify(draft.description)}`,
    'metadata:',
    '  drafted-by: command-centre',
    `  department: ${department ?? 'org-wide'}`,
    `  source-process: ${JSON.stringify(sourceTitle)}`,
    `  status: ${status}`,
    '---',
  ].join('\n');
}

export async function buildSkillZip(draft: SkillDraftRecord, department: string | null, sourceTitle: string): Promise<Buffer> {
  const skillMd = `${buildFrontmatter(draft, department, sourceTitle)}\n\n${draft.bodyMd.trim()}\n`;
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(writable);
    writable.on('finish', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    archive.append(skillMd, { name: `${draft.skillName}/SKILL.md` });
    void archive.finalize();
  });
}

/** Users row for the acting admin: by email first, else the use case owner, else insert keyed by the session's userId. */
async function resolveAuthorUserId(actor: Actor, fallbackOwner: string | null, nowS: number): Promise<string> {
  const client = await getTypedClient();
  const u = schema.users;
  const byEmail = await client.select({ id: u.id }).from(u).where(eq(u.email, actor.email)).limit(1);
  if (byEmail[0]) return byEmail[0].id;
  if (fallbackOwner) {
    const owner = await client.select({ id: u.id }).from(u).where(eq(u.id, fallbackOwner)).limit(1);
    if (owner[0]) return owner[0].id;
  }
  // Scoped to the id conflict only: an unscoped DO NOTHING would also swallow an
  // email collision (the PSR-baselines bug). A concurrent insert of the same email
  // under a different id therefore raises a unique-constraint error (the same
  // accepted-deviation class as the Board-name race below); a retry converges,
  // because the email lookup above then finds the row.
  await client.insert(u).values({
    id: actor.userId, email: actor.email, display_name: actor.email.split('@')[0],
    source: 'admin', first_seen_at: nowS, last_seen_at: nowS,
  } as never).onConflictDoNothing({ target: u.id });
  const reread = await client.select({ id: u.id }).from(u).where(eq(u.email, actor.email)).limit(1);
  return reread[0] ? reread[0].id : actor.userId;
}

/** The skill name is already a claimed S&C Board entry this use case does not own. */
export class BoardNameTakenError extends Error {
  constructor(public readonly skillName: string) {
    super(`"${skillName}" is already a claimed S&C Board entry owned by someone else`);
    this.name = 'BoardNameTakenError';
  }
}

export async function boardNameConflict(skillName: string, useCaseId: string): Promise<'none' | 'unclaimed' | 'own' | 'other'> {
  const client = await getTypedClient();
  const e = schema.skillLibraryEntries;
  const rows = await client.select({ id: e.id, is_published: e.is_published }).from(e).where(eq(e.name, skillName)).limit(1);
  if (!rows[0]) return 'none';
  if (Number(rows[0].is_published) === 0) return 'unclaimed';
  const t = schema.useCaseSkillDrafts;
  const own = await client.select({ id: t.library_entry_id }).from(t).where(eq(t.use_case_id, useCaseId)).limit(1);
  return own[0] && Number(own[0].id) === Number(rows[0].id) ? 'own' : 'other';
}

/**
 * Called on EVERY download with a freshly read use case and draft, so it must be
 * safe to repeat. Not wrapped in a transaction deliberately: the Board state is
 * decided before any write, a repeat call after a completed first download
 * returns before touching anything, and a call interrupted part-way converges on
 * retry (the rule add and the entry write are both idempotent, and markDownloaded
 * only stamps a row whose downloaded_at is still null). A concurrent first
 * download can still hit the unique name on the insert and surface as a 500;
 * that is accepted, since swallowing it and re-selecting would adopt whatever
 * entry won the race, which may not be ours.
 */
export async function applyFirstDownloadEffects(uc: UseCase, draft: SkillDraftRecord, actor: Actor, nowS: number): Promise<{ libraryEntryId: number; ruleUpdated: boolean }> {
  // 0. Already done: a repeat download changes nothing.
  if (draft.downloadedAt !== null && draft.libraryEntryId !== null) {
    return { libraryEntryId: draft.libraryEntryId, ruleUpdated: false };
  }

  const client = await getTypedClient();
  const e = schema.skillLibraryEntries;
  const department = uc.departments[0] ?? null;

  // 1. Decide the Board state before any write. A name claimed by someone else
  //    (another author, or an auto-published Anthropic entry) is never adopted.
  const state = await boardNameConflict(draft.skillName, uc.id);
  if (state === 'other') throw new BoardNameTakenError(draft.skillName);

  // 2. Matching rule.
  let ruleUpdated = false;
  if (!uc.skills.includes(draft.skillName)) {
    await updateUseCase(uc.id, { skills: [...uc.skills, draft.skillName] });
    ruleUpdated = true;
    bootstrapUseCase(uc.id).catch(err => {
      console.error(`[UseCases] skill-draft bootstrap failed for ${uc.id}:`, err instanceof Error ? err.message : err);
    });
  }

  // 3. Board entry — create, claim an unclaimed one, or refresh our own.
  let libraryEntryId: number;
  if (state === 'own') {
    // Our own entry: refresh only the drafted text. Author, department, source
    // URL and published state were set on the first download and stay as they are.
    const existing = await client.select({ id: e.id }).from(e).where(eq(e.name, draft.skillName)).limit(1);
    libraryEntryId = Number(existing[0].id);
    await client.update(e).set({ description: draft.description, install_guide: INSTALL_GUIDE_TEXT, updated_at: nowS } as never).where(eq(e.id, existing[0].id));
  } else {
    const authorId = await resolveAuthorUserId(actor, uc.ownerUserId, nowS);
    const set = {
      type: 'skill', surface: 'cowork', source: 'org', is_published: 1,
      author_user_id: authorId, description: draft.description, install_guide: INSTALL_GUIDE_TEXT,
      source_url: `/use-cases/${uc.id}`, department, updated_at: nowS,
    };
    if (state === 'none') {
      await client.insert(e).values({ name: draft.skillName, created_at: nowS, ...set } as never);
      const inserted = await client.select({ id: e.id }).from(e).where(eq(e.name, draft.skillName)).limit(1);
      libraryEntryId = Number(inserted[0].id);
    } else {
      // 'unclaimed': claim it rather than duplicating.
      const existing = await client.select({ id: e.id }).from(e).where(eq(e.name, draft.skillName)).limit(1);
      libraryEntryId = Number(existing[0].id);
      await client.update(e).set(set as never).where(eq(e.id, existing[0].id));
    }
  }

  // 4. Stamp the draft (only the first time).
  await markDownloaded(uc.id, libraryEntryId, nowS);
  return { libraryEntryId, ruleUpdated };
}

export async function renameCodifiedSkill(uc: UseCase, draft: SkillDraftRecord, oldName: string, newName: string): Promise<void> {
  if (draft.downloadedAt === null) return; // nothing codified yet: no rule entry, no Board entry
  if (oldName === newName) return;
  const fresh = (await getUseCase(uc.id)) ?? uc;
  const skills = fresh.skills.filter(s => s !== oldName);
  if (!skills.includes(newName)) skills.push(newName);
  await updateUseCase(uc.id, { skills });
  bootstrapUseCase(uc.id).catch(err => {
    console.error(`[UseCases] skill-rename bootstrap failed for ${uc.id}:`, err instanceof Error ? err.message : err);
  });
  if (draft.libraryEntryId !== null) {
    const client = await getTypedClient();
    const e = schema.skillLibraryEntries;
    await client.update(e).set({ name: newName, updated_at: Math.floor(Date.now() / 1000) } as never).where(eq(e.id, draft.libraryEntryId));
  }
}

/**
 * After download the Board entry is the published face of the draft, so an
 * owner edit or a regenerate carries the description across. Touches only
 * description + updated_at; a draft never downloaded has no Board row.
 */
export async function syncBoardDescription(draft: SkillDraftRecord, nowS: number): Promise<void> {
  if (draft.libraryEntryId === null) return;
  const client = await getTypedClient();
  const e = schema.skillLibraryEntries;
  await client.update(e).set({ description: draft.description, updated_at: nowS } as never).where(eq(e.id, draft.libraryEntryId));
}
