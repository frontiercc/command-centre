// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// A skill codified by "Turn this into a skill" lives on the S&C Board under its
// plain name. Once uploaded to the claude.ai organisation library its
// skill_activated telemetry may arrive marketplace-prefixed
// ("acme-library:variance-commentary"). Both receivers must store that under
// the Board name — otherwise the codified entry reads 0 uses and a duplicate
// unclaimed entry appears. Non-codified and Anthropic names are untouched.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { bareSkillName } from '@/lib/library/codified-skill-name';

let sql: TestSql;
let cleanup: () => Promise<void>;
let processOtlpLogs: (p: unknown) => Promise<{ errors: string[] }>;
let processCodeOtlpLogs: (p: unknown) => Promise<{ errors: string[] }>;
let codifiedId: number;
let orgDocxId: number;

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  processOtlpLogs = (await import('@/lib/otel/cowork-receiver')).processOtlpLogs;
  processCodeOtlpLogs = (await import('@/lib/otel/code-receiver')).processCodeOtlpLogs;
});

afterAll(async () => cleanup());

function payload(service: 'cowork' | 'claude-code', skillName: string) {
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: service } },
          { key: 'user.email', value: { stringValue: 'codified@example.com' } },
          { key: 'user.id', value: { stringValue: 'usr_codified' } },
          { key: 'organization.id', value: { stringValue: 'org_test' } },
        ],
      },
      scopeLogs: [{
        logRecords: [{
          attributes: [
            { key: 'event.name', value: { stringValue: 'claude_code.skill_activated' } },
            { key: 'session.id', value: { stringValue: 'sess_codified' } },
            { key: 'prompt.id', value: { stringValue: 'prompt_codified' } },
            { key: 'skill.name', value: { stringValue: skillName } },
          ],
          timeUnixNano: '1750000000000000000',
        }],
      }],
    }],
  };
}

async function seedDraft(useCaseId: string, entryId: number, skillName: string) {
  await sql.run(`INSERT INTO use_cases (id, title, status) VALUES (?, ?, 'confirmed')`, [useCaseId, `UC ${skillName}`]);
  await sql.run(`INSERT INTO use_case_skill_drafts
    (use_case_id, skill_name, description, body_md, owner_questions_json, citations_json, corpus_stats_json, thin, model, generated_at, downloaded_at, library_entry_id)
    VALUES (?, ?, 'd', 'b', '[]', '{}', '{}', 0, 'm', 1, 2, ?)`, [useCaseId, skillName, entryId]);
}

async function entryCount(): Promise<number> {
  return ((await sql.get('SELECT COUNT(*) AS c FROM skill_library_entries')) as { c: number }).c;
}

async function invocations(): Promise<string[]> {
  return ((await sql.all("SELECT skill_name FROM cowork_skill_invocations WHERE session_id = 'sess_codified'")) as { skill_name: string }[])
    .map((r) => r.skill_name);
}

beforeEach(async () => {
  // A record re-sent with an identical payload is now skipped as already
  // processed (lib/otel/event-key.ts); tests reuse payloads, so clear it first.
  await sql.exec('DELETE FROM otel_ingested_events');
  await sql.exec("DELETE FROM cowork_skill_invocations WHERE session_id = 'sess_codified'");
  await sql.exec('DELETE FROM use_case_skill_drafts');
  await sql.exec('DELETE FROM use_cases');
  await sql.exec('DELETE FROM skill_library_entries');
  // RETURNING id gives the new entry's serial id.
  const ins = async (name: string) => Number(((await sql.get(
    `INSERT INTO skill_library_entries (name, type, surface, source, is_published, author_user_id, description)
    VALUES (?, 'skill', 'cowork', 'org', 1, NULL, 'claimed') RETURNING id`, [name])) as { id: number }).id);
  codifiedId = await ins('variance-commentary');
  await seedDraft('uc-variance', codifiedId, 'variance-commentary');
  // A codified org skill that happens to share an Anthropic bare name.
  orgDocxId = await ins('docx');
  await seedDraft('uc-docx', orgDocxId, 'docx');
  // A plain org entry NOT produced by a draft.
  await ins('report');
});

describe('bareSkillName', () => {
  it('takes the suffix after the last colon, null when there is none or it is empty', () => {
    expect(bareSkillName('a:b:c')).toBe('c');
    expect(bareSkillName('plain')).toBeNull();
    expect(bareSkillName(':x')).toBe('x');
    expect(bareSkillName('x:')).toBeNull();
  });
});

describe.each([
  ['cowork receiver', 'cowork' as const, () => processOtlpLogs],
  ['code receiver', 'claude-code' as const, () => processCodeOtlpLogs],
])('%s', (_label, service, fn) => {
  it('stores a prefixed name for a codified skill under its Board name, creating no entry', async () => {
    const before = await entryCount();
    const r = await fn()(payload(service, 'acme-library:variance-commentary'));
    expect(r.errors).toEqual([]);
    expect(await invocations()).toEqual(['variance-commentary']);
    expect(await entryCount()).toBe(before);
    expect(await sql.get("SELECT COUNT(*) AS c FROM skill_library_entries WHERE name LIKE '%:variance-commentary'")).toEqual({ c: 0 });
  });

  it('stores the plain codified name as-is and leaves the claimed entry alone', async () => {
    const before = await entryCount();
    await fn()(payload(service, 'variance-commentary'));
    expect(await invocations()).toEqual(['variance-commentary']);
    expect(await entryCount()).toBe(before);
    expect(await sql.get('SELECT source, is_published, description FROM skill_library_entries WHERE id = ?', [codifiedId]))
      .toEqual({ source: 'org', is_published: 1, description: 'claimed' });
  });

  it('keeps a prefixed name for a NON-codified entry raw and auto-registers it unclaimed', async () => {
    await fn()(payload(service, 'x:report'));
    expect(await invocations()).toEqual(['x:report']);
    expect(await sql.get("SELECT source, is_published FROM skill_library_entries WHERE name = 'x:report'"))
      .toEqual({ source: 'org', is_published: 0 });
  });

  it('never normalises an Anthropic-prefixed name, even when a codified org entry shares the bare name', async () => {
    await fn()(payload(service, 'anthropic-skills:docx'));
    expect(await invocations()).toEqual(['anthropic-skills:docx']);
    expect(await sql.get("SELECT source, is_published FROM skill_library_entries WHERE name = 'anthropic-skills:docx'"))
      .toEqual({ source: 'anthropic', is_published: 1 });
    expect(await sql.get('SELECT name, source, is_published, description FROM skill_library_entries WHERE id = ?', [orgDocxId]))
      .toEqual({ name: 'docx', source: 'org', is_published: 1, description: 'claimed' });
  });

  // The likely real form: Claude Code's own skill listing shows org-library
  // skills under the anthropic-skills: namespace too (e.g.
  // anthropic-skills:command-centre-release-note). That prefix is not on the
  // known-Anthropic allowlist, so it must resolve exactly like any other
  // marketplace prefix — codified suffix wins, stored bare, no new entry.
  it('resolves an anthropic-skills:-prefixed name for a codified skill under its Board name, creating no entry', async () => {
    const before = await entryCount();
    const r = await fn()(payload(service, 'anthropic-skills:variance-commentary'));
    expect(r.errors).toEqual([]);
    expect(await invocations()).toEqual(['variance-commentary']);
    expect(await entryCount()).toBe(before);
    expect(await sql.get("SELECT COUNT(*) AS c FROM skill_library_entries WHERE name = 'anthropic-skills:variance-commentary'"))
      .toEqual({ c: 0 });
  });

  // Case-insensitive match, for parity with the use-case tracker's
  // suffix-aware signalMatches — stored under the Board entry's exact name.
  it('matches the bare suffix case-insensitively, storing under the Board entry\'s exact name', async () => {
    await fn()(payload(service, 'mkt:Variance-Commentary'));
    expect(await invocations()).toEqual(['variance-commentary']);
  });
});
