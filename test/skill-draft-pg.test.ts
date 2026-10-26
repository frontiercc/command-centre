// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for "Turn this into a skill" (migration
// 0023/082, lib/usecases/skill-draft-store.ts, skill-corpus.ts, skill-publish.ts,
// plus the tracker's suffix-match path). Five things proven here against a real
// postgres:16 testcontainer:
//   1. Migration 0023 applies: upsertGeneratedDraft -> getSkillDraft round-trips
//      through the store's raw-row shape, and every Number()-coerced field
//      (thin as a boolean, generatedAt/editedAt/downloadedAt/libraryEntryId as
//      numbers-or-null) comes back typed correctly rather than as the string a
//      raw pg bigint/integer column can hand back.
//   2. use_case_skill_drafts.use_case_id REFERENCES use_cases(id) ON DELETE
//      CASCADE — deleting the use case removes the draft row.
//   3. gatherSkillCorpus's raw SQL: cowork_messages.occurred_at is bigint
//      (string over the raw pg driver) — proves the buildCorpusFromRows
//      Number() coercion — plus the people/unreadableSessions counts over a
//      real use_case_week_matches join.
//   4. applyFirstDownloadEffects on PG: the Board insert's identity `id` comes
//      back as a number in libraryEntryId; a second call with a freshly
//      reread draft is a no-op (same id, one row for that name); a second use
//      case whose draft carries the same skill name hits BoardNameTakenError.
//   5. markDownloaded's COALESCE UPDATE never moves an already-set
//      downloaded_at/library_entry_id.
//   6. Tracker suffix match: signalMatches (pure) plus a real
//      cowork_skill_invocations row named "mkt:codified-skill" matching a
//      confirmed use case's `skills: ['codified-skill']` rule through
//      bootstrapUseCase, landing in use_case_week_matches.
//
// HARNESS RULE (copied from test/process-mining-pg.test.ts / test/use-cases-
// tracker-pg.test.ts): every module under test reaches the database through
// getClient(), which binds to DATABASE_URL on first use — so
// schema and every module under test must be DYNAMIC-imported AFTER
// createTestDbClient('postgres') has set DATABASE_URL + reset modules.
// createTestDbClient('postgres') boots the container via startPg(), which
// already applies the full committed lib/db/migrations-pg set (migration
// 0023 included) — no manual DDL is needed here.
//
// Run it with:
//   NODE_OPTIONS=--dns-result-order=ipv4first npx vitest run test/skill-draft-pg.test.ts
import { describe, it, expect } from 'vitest';

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

describe('skill drafts — "Turn this into a skill" (postgres)', () => {
  it(
    'migration 0023 round-trips through the store, cascades on use-case delete, gatherSkillCorpus coerces bigint occurred_at, applyFirstDownloadEffects/markDownloaded behave idempotently on PG, and the tracker suffix-matches a skill invocation into use_case_week_matches',
    async () => {
      const { createTestDbClient } = await import('./helpers/db');
      const { client, cleanup } = await createTestDbClient('postgres');

      try {
        // Dynamic imports AFTER the DATABASE_URL env + module reset (harness rule).
        const { schema } = await import('@/lib/db/schema');
        const { eq, and } = await import('drizzle-orm');
        const { weekStart } = await import('@/lib/pulse/period');
        const store = await import('@/lib/usecases/skill-draft-store');
        const skillCorpus = await import('@/lib/usecases/skill-corpus');
        const publish = await import('@/lib/usecases/skill-publish');
        const tracker = await import('@/lib/usecases/tracker');
        const queries = await import('@/lib/usecases/queries');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = client as any;

        // ════════════════════════════════════════════════════════════════
        // SECTION 1 — migration 0023 round-trip + Number()/boolean coercions.
        // ════════════════════════════════════════════════════════════════
        const uc1 = await queries.createUseCase({ title: 'PG Skill Draft Round-Trip' });

        const draftInput = {
          name: 'pg-roundtrip-skill',
          description: 'Assembles the monthly variance commentary from source rows.',
          body: '# PG Roundtrip Skill\n\nDo the thing.',
          ownerQuestions: ['Is the source sheet always the same shape?', 'Who reviews the output?'],
          citations: { '0': [1, 2], '1': [3] },
          thin: false,
        };
        const statsInput = {
          prompts: 5, distinctPrompts: 4, people: 2, sessions: 3, days: 2,
          followUps: 1, weeksSpanned: 1, unreadableSessions: 0,
          firstAt: NOW - 5 * DAY, lastAt: NOW - DAY,
        };

        await store.upsertGeneratedDraft(uc1.id, draftInput, statsInput, 'claude-haiku-4-5-20251001', NOW);
        const rec1 = await store.getSkillDraft(uc1.id);
        expect(rec1).not.toBeNull();
        expect(rec1!.skillName).toBe('pg-roundtrip-skill');
        expect(rec1!.description).toBe(draftInput.description);
        expect(rec1!.bodyMd).toBe(draftInput.body);
        expect(rec1!.ownerQuestions).toEqual([
          { q: 'Is the source sheet always the same shape?', done: false },
          { q: 'Who reviews the output?', done: false },
        ]);
        expect(rec1!.citations).toEqual(draftInput.citations);
        expect(rec1!.corpusStats).toEqual(statsInput);
        // THE LOAD-BEARING ASSERTIONS: thin is a genuine boolean, and every
        // timestamp/id column comes back as a number or null, never a string —
        // node-postgres's raw driver hands bigint/integer columns back as
        // strings without the store's Number()/===1 coercions.
        expect(rec1!.thin).toBe(false);
        expect(typeof rec1!.thin).toBe('boolean');
        expect(typeof rec1!.generatedAt).toBe('number');
        expect(rec1!.generatedAt).toBe(NOW);
        expect(rec1!.editedAt).toBeNull();
        expect(rec1!.downloadedAt).toBeNull();
        expect(rec1!.libraryEntryId).toBeNull();

        // ════════════════════════════════════════════════════════════════
        // SECTION 2 — cascade: deleting the use case removes the draft row.
        // ════════════════════════════════════════════════════════════════
        await queries.deleteUseCase(uc1.id);
        expect(await store.getSkillDraft(uc1.id)).toBeNull();

        // ════════════════════════════════════════════════════════════════
        // SECTION 3 — gatherSkillCorpus: bigint occurred_at Number()
        // coercion + people/unreadableSessions counts over a real join.
        // ════════════════════════════════════════════════════════════════
        const uc2 = await queries.createUseCase({ title: 'PG Skill Corpus UC' });

        await db.insert(schema.users).values([
          { id: 'pg-corpus-u1', email: 'pg-corpus-u1@test.local', display_name: 'Corpus Anna' },
          { id: 'pg-corpus-u2', email: 'pg-corpus-u2@test.local', display_name: 'Corpus Ben' },
        ]);

        await db.insert(schema.coworkMessages).values([
          {
            id: 'm-pg-corpus-1', session_id: 's-pg-corpus-1', user_id: 'pg-corpus-u1',
            message_type: 'cowork_user_message', surface: 'cowork',
            content_full: 'Please draft the quarterly variance commentary for finance',
            occurred_at: NOW - 2 * DAY,
          },
          {
            id: 'm-pg-corpus-2', session_id: 's-pg-corpus-2', user_id: 'pg-corpus-u2',
            message_type: 'cowork_user_message', surface: 'cowork',
            content_full: 'Summarise the client call notes for delivery',
            occurred_at: NOW - DAY,
          },
          {
            // Readable-content check, retention-stripped: content_full is
            // NULL. Same user as the second session, so `people` stays 2
            // while `unreadableSessions` picks this session up separately.
            id: 'm-pg-corpus-3', session_id: 's-pg-corpus-3', user_id: 'pg-corpus-u2',
            message_type: 'cowork_user_message', surface: 'cowork',
            content_full: null, occurred_at: NOW - 3 * DAY,
          },
        ]);

        const wk = weekStart(NOW);
        await db.insert(schema.useCaseWeekMatches).values([
          { use_case_id: uc2.id, week_start: wk, user_id: 'pg-corpus-u1', session_id: 's-pg-corpus-1' },
          { use_case_id: uc2.id, week_start: wk, user_id: 'pg-corpus-u2', session_id: 's-pg-corpus-2' },
          { use_case_id: uc2.id, week_start: wk, user_id: 'pg-corpus-u2', session_id: 's-pg-corpus-3' },
        ]);

        const corpus = await skillCorpus.gatherSkillCorpus(uc2.id, NOW);
        expect(corpus.stats.people).toBe(2);
        expect(corpus.stats.unreadableSessions).toBe(1);
        expect(corpus.stats.sessions).toBe(2); // only the two readable sessions
        expect(corpus.excerpts.length).toBeGreaterThan(0);
        for (const excerpt of corpus.excerpts) {
          // THE LOAD-BEARING ASSERTION: cowork_messages.occurred_at is bigint;
          // node-postgres's raw driver returns bigint as a STRING — without
          // buildCorpusFromRows' Number() coercion this would be 'string'.
          expect(typeof excerpt.occurredAt).toBe('number');
        }

        // ════════════════════════════════════════════════════════════════
        // SECTION 4 — applyFirstDownloadEffects: identity id as a number,
        // second-call idempotency, and BoardNameTakenError on a name clash.
        // ════════════════════════════════════════════════════════════════
        const uc3 = await queries.createUseCase({ title: 'PG Download Effects UC', departments: ['PG Skill Dept'] });
        const downloadDraftInput = {
          name: 'pg-download-skill',
          description: 'Assembles the weekly status pack from project trackers.',
          body: '# PG Download Skill\n\nDo the thing.',
          ownerQuestions: [],
          citations: {},
          thin: false,
        };
        await store.upsertGeneratedDraft(uc3.id, downloadDraftInput, statsInput, 'claude-haiku-4-5-20251001', NOW);
        const draft3 = (await store.getSkillDraft(uc3.id))!;
        const actor = { userId: 'pg-actor-1', email: 'pg-actor-1@test.local' };

        const effects1 = await publish.applyFirstDownloadEffects(uc3, draft3, actor, NOW);
        // THE LOAD-BEARING ASSERTION: skill_library_entries.id is a
        // generatedByDefaultAsIdentity() integer column — the identity value
        // returned via a re-select must come back as a genuine number.
        expect(typeof effects1.libraryEntryId).toBe('number');
        expect(effects1.ruleUpdated).toBe(true);

        const entryRows = await db
          .select()
          .from(schema.skillLibraryEntries)
          .where(eq(schema.skillLibraryEntries.name, 'pg-download-skill'));
        expect(entryRows).toHaveLength(1);
        expect(Number(entryRows[0].is_published)).toBe(1);
        expect(entryRows[0].author_user_id).toBe('pg-actor-1');

        // Second call: a FRESH draft (re-read, so downloaded_at/library_entry_id
        // are populated) plus the fresh use case (skills now carries the
        // codified name) must be a genuine no-op — same id, one row.
        const draft3Fresh = (await store.getSkillDraft(uc3.id))!;
        const uc3Fresh = (await queries.getUseCase(uc3.id))!;
        expect(draft3Fresh.downloadedAt).not.toBeNull();
        expect(typeof draft3Fresh.downloadedAt).toBe('number');
        expect(draft3Fresh.libraryEntryId).toBe(effects1.libraryEntryId);
        expect(uc3Fresh.skills).toContain('pg-download-skill');

        const effects2 = await publish.applyFirstDownloadEffects(uc3Fresh, draft3Fresh, actor, NOW + 500);
        expect(effects2.libraryEntryId).toBe(effects1.libraryEntryId);
        expect(effects2.ruleUpdated).toBe(false);

        const entryRowsAfter = await db
          .select()
          .from(schema.skillLibraryEntries)
          .where(eq(schema.skillLibraryEntries.name, 'pg-download-skill'));
        expect(entryRowsAfter).toHaveLength(1); // still exactly one Board row

        // A second use case whose draft carries the SAME skill name hits the
        // "claimed by someone else" branch (this use case's own draft link is
        // still null, so it is never mistaken for 'own').
        const uc4 = await queries.createUseCase({ title: 'PG Download Effects UC — name clash', departments: ['PG Skill Dept 2'] });
        await store.upsertGeneratedDraft(uc4.id, downloadDraftInput, statsInput, 'claude-haiku-4-5-20251001', NOW);
        const draft4 = (await store.getSkillDraft(uc4.id))!;
        await expect(publish.applyFirstDownloadEffects(uc4, draft4, actor, NOW)).rejects.toThrow(publish.BoardNameTakenError);

        // ════════════════════════════════════════════════════════════════
        // SECTION 5 — markDownloaded's COALESCE UPDATE never moves an
        // already-set downloaded_at/library_entry_id.
        // ════════════════════════════════════════════════════════════════
        const beforeSecondMark = (await store.getSkillDraft(uc3.id))!;
        await store.markDownloaded(uc3.id, 999, beforeSecondMark.downloadedAt! + 1000);
        const afterSecondMark = (await store.getSkillDraft(uc3.id))!;
        expect(afterSecondMark.downloadedAt).toBe(beforeSecondMark.downloadedAt);
        expect(afterSecondMark.libraryEntryId).toBe(beforeSecondMark.libraryEntryId);
        expect(afterSecondMark.libraryEntryId).not.toBe(999);

        // ════════════════════════════════════════════════════════════════
        // SECTION 6 — a session running the use case's own codified skill
        // (marketplace-prefixed name) is a match through the session judge,
        // without a model call. Content off, so the judge
        // makes no call at all; the skill rule still counts.
        // ════════════════════════════════════════════════════════════════
        expect(tracker.signalMatches(new Set(['codified-skill']), 'mkt:codified-skill')).toBe(true);
        expect(tracker.signalMatches(new Set(['codified-skill']), 'mkt:other-skill')).toBe(false);

        const uc5 = await queries.createUseCase({
          title: 'PG Codified Skill Match UC', description: 'Work done with its own skill.', skills: ['codified-skill'], status: 'confirmed',
        });
        await db.insert(schema.useCaseSkillDrafts).values({
          use_case_id: uc5.id, skill_name: 'codified-skill', description: 'd', body_md: 'b', owner_questions_json: '[]',
          citations_json: '{}', corpus_stats_json: '{}', model: 'm', generated_at: NOW, downloaded_at: NOW,
        });
        await db.insert(schema.users).values({ id: 'pg-suffix-user', email: 'pg-suffix-user@test.local', display_name: 'Suffix User' });
        await db.insert(schema.coworkSessions).values({ id: 'sess-pg-suffix-1', conversation_id: 'sess-pg-suffix-1', user_id: 'pg-suffix-user' });
        await db.insert(schema.coworkSessionStats).values({
          session_id: 'sess-pg-suffix-1', user_id: 'pg-suffix-user', first_event_at: NOW - 2 * DAY, last_event_at: NOW - 2 * DAY + 600, computed_at: NOW,
        });
        await db.insert(schema.coworkSkillInvocations).values({
          id: 'ski-pg-suffix-1', user_id: 'pg-suffix-user', session_id: 'sess-pg-suffix-1',
          skill_name: 'mkt:codified-skill', occurred_at: NOW - 2 * DAY,
        });
        const { setConfigValue } = await import('@/lib/config');
        await setConfigValue('useCasesEnabled', 'true');
        await setConfigValue('useCasesSuggestUseContent', 'false');
        const { runUseCaseJudgeJob } = await import('@/lib/usecases/session-judge');
        await runUseCaseJudgeJob({ nowS: NOW });

        const matchRows = await db
          .select()
          .from(schema.useCaseWeekMatches)
          .where(and(eq(schema.useCaseWeekMatches.use_case_id, uc5.id), eq(schema.useCaseWeekMatches.user_id, 'pg-suffix-user')));
        expect(matchRows.some((r: { session_id: string }) => r.session_id === 'sess-pg-suffix-1')).toBe(true);
      } finally {
        await cleanup();
      }
    },
    180_000,
  );
});
