// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres migration 0027 seeds the four Anthropic marketplace connectors on
// the S&C Board (the Postgres baseline never did).
// A fresh hub gets the four published cards; re-running the migration on a
// hub that already has cards fills only an empty description / install guide
// (or 044's own stale "Add via claude.ai → Integrations"), never an admin's
// text, and never touches a same-named entry that is not a connector.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '..', 'lib/db/migrations-pg/0027_anthropic_marketplace_connectors.sql'),
  'utf8',
);
const NEW_GUIDE = 'Add it in Claude under Settings → Connectors. On a Team or Enterprise plan, an organisation owner may need to enable it first.';

let sql: TestSql;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ sql, cleanup } = await createTestDatabase());
});
afterAll(async () => cleanup());

type Row = { name: string; type: string; source: string; is_published: number; description: string | null; install_guide: string | null };
const card = (name: string) =>
  sql.get<Row>('SELECT name, type, source, is_published, description, install_guide FROM skill_library_entries WHERE name = ?', [name]);

describe('0027 Anthropic marketplace connectors', () => {
  it('a fresh hub has the four published Anthropic connector cards with a description and install guide', async () => {
    for (const name of ['Gmail', 'Slack', 'Salesforce', 'Google Drive']) {
      const row = await card(name);
      expect(row, name).toBeDefined();
      expect(row!.type).toBe('connector');
      expect(row!.source).toBe('anthropic');
      expect(row!.is_published).toBe(1);
      expect(row!.description).toBeTruthy();
      expect(row!.install_guide).toBe(NEW_GUIDE);
    }
  });

  it('re-running fills only empty or stale fields and keeps an admin’s text', async () => {
    await sql.run("UPDATE skill_library_entries SET description = 'Our own Gmail notes', install_guide = 'Ask IT' WHERE name = 'Gmail'");
    await sql.run("UPDATE skill_library_entries SET description = NULL, install_guide = '' WHERE name = 'Slack'");
    await sql.run("UPDATE skill_library_entries SET install_guide = 'Add via claude.ai → Integrations' WHERE name = 'Salesforce'");
    await sql.exec(MIGRATION);

    const gmail = await card('Gmail');
    expect(gmail!.description).toBe('Our own Gmail notes');
    expect(gmail!.install_guide).toBe('Ask IT');
    const slack = await card('Slack');
    expect(slack!.description).toBeTruthy();
    expect(slack!.install_guide).toBe(NEW_GUIDE);
    expect((await card('Salesforce'))!.install_guide).toBe(NEW_GUIDE);
  });

  it('never touches a same-named entry that is not a connector', async () => {
    await sql.run("UPDATE skill_library_entries SET type = 'skill', description = NULL, install_guide = NULL WHERE name = 'Google Drive'");
    await sql.exec(MIGRATION);
    const drive = await card('Google Drive');
    expect(drive!.type).toBe('skill');
    expect(drive!.description).toBeNull();
    expect(drive!.install_guide).toBeNull();
  });
});
