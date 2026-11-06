// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Migration 0040 relabels Google Workspace sessions stored before the receiver
// read agent.vendor: a session that ran execute_apps_script (Google's alone)
// moves from excel / word / powerpoint to sheets / docs / slides, every row of
// it and its session row. A session without Apps Script keeps its Microsoft
// label, and a second run changes nothing.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'db', 'migrations-pg', '0040_google_product.sql'), 'utf8');

async function runSpec(): Promise<void> {
  const { createTestDatabase } = await import('./helpers/db');
  const { sql, cleanup } = await createTestDatabase();
  try {
    const t = Math.floor(Date.now() / 1000) - 3600;
    await sql.run(`INSERT INTO users (id, email, first_seen_at, last_seen_at) VALUES ('u1', 'u1@example.com', ?, ?)`, [t, t]);
    const session = async (id: string, product: string, tools: string[]) => {
      await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id, source, product, started_at) VALUES (?, ?, 'u1', 'otel', ?, ?)`, [id, id, product, t]);
      await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, product, content_full, occurred_at) VALUES (?, ?, 'u1', 'cowork_user_message', 'cowork', 'otel', ?, 'a prompt', ?)`, [`${id}-q`, id, product, t]);
      await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, product, model, occurred_at) VALUES (?, ?, 'u1', 'cowork_api_request', 'cowork', 'otel', ?, 'claude-opus-5-5', ?)`, [`${id}-r`, id, product, t]);
      for (const [i, tool] of tools.entries()) {
        await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, product, content_preview, occurred_at) VALUES (?, ?, 'u1', 'cowork_tool_metadata', 'cowork', 'otel', ?, ?, ?)`, [`${id}-t${i}`, id, product, tool, t]);
      }
    };
    await session('g-sheet', 'excel', ['get_cell_ranges', 'execute_apps_script']);
    await session('g-slide', 'powerpoint', ['execute_apps_script', 'verify_slide_visual']);
    await session('m-sheet', 'excel', ['execute_office_js']);
    await session('m-doc', 'word', ['read_doc_section']);
    await session('cowork', 'excel', []);
    await sql.run(`UPDATE cowork_messages SET product = NULL WHERE session_id = 'cowork'`);
    await sql.run(`UPDATE cowork_sessions SET product = NULL WHERE id = 'cowork'`);

    const products = async () => ({
      messages: Object.fromEntries((await sql.all<{ session_id: string; p: string | null }>(
        `SELECT session_id, string_agg(DISTINCT COALESCE(product, 'null'), ',') AS p FROM cowork_messages GROUP BY session_id`,
      )).map(r => [r.session_id, r.p])),
      sessions: Object.fromEntries((await sql.all<{ id: string; product: string | null }>(
        `SELECT id, product FROM cowork_sessions`,
      )).map(r => [r.id, r.product])),
    });

    await sql.exec(MIGRATION.replaceAll('--> statement-breakpoint', ''));
    const after = await products();
    expect(after.messages).toEqual({ 'g-sheet': 'sheets', 'g-slide': 'slides', 'm-sheet': 'excel', 'm-doc': 'word', cowork: 'null' });
    expect(after.sessions).toEqual({ 'g-sheet': 'sheets', 'g-slide': 'slides', 'm-sheet': 'excel', 'm-doc': 'word', cowork: null });

    await sql.exec(MIGRATION.replaceAll('--> statement-breakpoint', ''));
    expect(await products()).toEqual(after);
  } finally {
    await cleanup();
  }
}

describe('migration 0040: relabel stored Google sessions (postgres)', () => {
  it('moves Apps Script sessions to the Google apps and leaves the rest', async () => {
    await runSpec();
  }, 120_000);
});
