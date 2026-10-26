// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Split into its own file (separate from test/use-cases-ideate.test.ts) because
// it uses createTestDatabase() — a real connection stored on the process-level
// singleton (see lib/db/client.ts). Mixing that with plain route
// tests in the same file/process causes the route tests to hit a closed
// connection once this suite's afterAll cleanup runs. Vitest isolates test
// FILES into separate workers, so a dedicated file avoids the collision
// (same pattern as test/use-cases-match.test.ts vs test/use-cases-routes.test.ts).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { seedUserSql } from './helpers/seed';

let sql: TestSql;
let cleanup: () => Promise<void>;
let gatherOrgGrounding: () => Promise<import('../lib/usecases/ideate').OrgGrounding>;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const mod = await import('../lib/usecases/ideate');
  gatherOrgGrounding = mod.gatherOrgGrounding;

  await seedUserSql(sql, 'user-1');
  await seedUserSql(sql, 'user-2');
  await seedUserSql(sql, 'user-3');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec('DELETE FROM cowork_skill_invocations');
  await sql.exec('DELETE FROM cowork_mcp_invocations');
  await sql.exec('DELETE FROM pulse_classifications');
  await sql.exec('DELETE FROM cowork_messages');
  await sql.exec('DELETE FROM code_session_classifications');
  await sql.exec('DELETE FROM code_session_stats');
  await sql.exec("UPDATE users SET department = NULL");
});

async function insertSkillInvocation(id: string, userId: string, skillName: string, occurredAt: number) {
  await sql.run(`
    INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at)
    VALUES (?, ?, ?, ?, ?)
  `, [id, userId, `session-${id}`, skillName, occurredAt]);
}

async function insertMcpInvocation(id: string, userId: string, mcpServer: string, occurredAt: number) {
  await sql.run(`
    INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [id, userId, `session-${id}`, mcpServer, 'some_tool', occurredAt]);
}

async function insertPulseClassification(coworkMessageId: string, userId: string, taskType: string, occurredAt: number) {
  await sql.run(`
    INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, content_preview, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [coworkMessageId, `session-${coworkMessageId}`, userId, 'cowork_user_message', 'cowork', 'irrelevant', occurredAt]);
  await sql.run(`
    INSERT INTO pulse_classifications
      (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [coworkMessageId, userId, 2, taskType, 0.9, 'test-model', occurredAt]);
}

async function insertCodeClassification(sessionId: string, userId: string, workType: string, occurredAt: number) {
  await sql.run(`
    INSERT INTO code_session_stats (session_id, user_id, first_at, last_at, computed_at)
    VALUES (?, ?, ?, ?, ?)
  `, [sessionId, userId, occurredAt, occurredAt, occurredAt]);
  await sql.run(`
    INSERT INTO code_session_classifications
      (session_id, user_id, work_type, tier, confidence, classifier_model, status, classified_at)
    VALUES (?, ?, ?, ?, ?, ?, 'classified', ?)
  `, [sessionId, userId, workType, 2, 0.9, 'test-model', occurredAt]);
}

const now = Math.floor(Date.now() / 1000);

describe('gatherOrgGrounding', () => {
  it('returns expected shape from seeded skill/mcp/pulse/users rows', async () => {
    await insertSkillInvocation('sk-1', 'user-1', 'writing-plans', now);
    await insertSkillInvocation('sk-2', 'user-2', 'writing-plans', now);
    await insertSkillInvocation('sk-3', 'user-1', 'debugging', now);

    // docusign invoked once; slack invoked heavily (9x) -- docusign is the
    // clearly underused connector relative to slack.
    await insertMcpInvocation('mcp-1', 'user-1', 'docusign', now);
    for (let i = 0; i < 9; i++) {
      await insertMcpInvocation(`mcp-slack-${i}`, i % 2 === 0 ? 'user-2' : 'user-3', 'slack', now);
    }
    await insertMcpInvocation('mcp-workspace', 'user-3', 'workspace', now);
    await insertMcpInvocation('mcp-cowork', 'user-1', 'cowork', now);
    await insertMcpInvocation('mcp-citc', 'user-1', 'Claude_in_Chrome', now);

    await insertPulseClassification('m-1', 'user-1', 'legal_review', now);
    await insertPulseClassification('m-2', 'user-2', 'legal_review', now);
    await insertPulseClassification('m-3', 'user-3', 'code_generation', now);

    await sql.run('UPDATE users SET department = ? WHERE id = ?', ['Legal', 'user-1']);
    await sql.run('UPDATE users SET department = ? WHERE id = ?', ['Engineering', 'user-2']);

    const grounding = await gatherOrgGrounding();

    expect(grounding.topSkills).toContain('writing-plans');
    expect(grounding.topSkills).toContain('debugging');
    expect(grounding.topSkills.length).toBeLessThanOrEqual(10);

    // docusign (1 invocation) is far below slack (9 invocations) -- underused.
    expect(grounding.underusedConnectors).toContain('docusign');
    expect(grounding.underusedConnectors).not.toContain('slack');
    // system connectors excluded even though present
    expect(grounding.underusedConnectors).not.toContain('workspace');
    expect(grounding.underusedConnectors).not.toContain('cowork');
    expect(grounding.underusedConnectors).not.toContain('Claude_in_Chrome');

    expect(grounding.topTaskTypes).toContain('legal_review');
    expect(grounding.topTaskTypes).toContain('code_generation');

    expect(grounding.departments.sort()).toEqual(['Engineering', 'Legal']);
  });

  it('returns empty arrays when there is no telemetry', async () => {
    const grounding = await gatherOrgGrounding();
    expect(grounding.topSkills).toEqual([]);
    expect(grounding.underusedConnectors).toEqual([]);
    expect(grounding.topTaskTypes).toEqual([]);
    expect(grounding.codeWorkTypes).toEqual([]);
    expect(grounding.departments).toEqual([]);
  });

  it('includes Code work types from classified code sessions', async () => {
    await insertCodeClassification('cs-1', 'user-1', 'feature', now);
    await insertCodeClassification('cs-2', 'user-2', 'feature', now);
    await insertCodeClassification('cs-3', 'user-1', 'bugfix', now);

    const grounding = await gatherOrgGrounding();
    expect(grounding.codeWorkTypes).toContain('feature');
    expect(grounding.codeWorkTypes).toContain('bugfix');
    expect(grounding.codeWorkTypes.length).toBeLessThanOrEqual(10);
  });

  it('excludes system MCP servers entirely even when they are the only connectors present', async () => {
    await insertMcpInvocation('mcp-1', 'user-1', 'workspace', now);
    await insertMcpInvocation('mcp-2', 'user-1', 'cowork', now);
    await insertMcpInvocation('mcp-3', 'user-1', 'Claude_in_Chrome', now);

    const grounding = await gatherOrgGrounding();
    expect(grounding.underusedConnectors).toEqual([]);
  });
});
