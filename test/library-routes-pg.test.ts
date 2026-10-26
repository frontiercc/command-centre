// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres regression test for the Skills & Connectors
// Library route handlers' OWN inline queries (async Drizzle). Proves on
// REAL Postgres:
//   - GET /api/library (browse): the five join-derived gamification-signal
//     counts (invocation_count/user_count/vote_count/user_voted/week_count/
//     prev_week_count) come back as STRINGS on pg and are Number()-coerced
//     correctly; the `q` name/description search is case-insensitive (ILIKE).
//   - POST /api/library (submit): a brand-new entry's id comes back via
//     .returning() (not .lastInsertRowid); resubmitting an unclaimed entry
//     updates it in place (same id); resubmitting an already-published entry
//     409s.
//   - GET /api/library/[id] (detail): stats aggregates coerce correctly and
//     is_author is server-computed from the session, not the client.
//   - PATCH /api/library/[id]: a real UPDATE ... RETURNING.
//   - POST /api/library/[id]/vote: the toggle round-trip (vote → unvote) and
//     the FK-safety user auto-upsert (INSERT OR IGNORE → onConflictDoNothing)
//     for a voter who has no pre-existing `users` row.
//
// Harness mirrors test/pulse-routes-pg.test.ts: one runSpec() run against
// Postgres (the shared test server when CCC_TEST_PG_URL is set, else a
// testcontainer). Auth is mocked; everything else hits the REAL DB via a
// fresh dynamic import (the database client binds to DATABASE_URL on first use, so every
// module under test is imported AFTER the DB env is established).
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockSession: { authenticated: boolean; role?: string; email?: string; userId?: string; department?: string } = {
  authenticated: true,
  role: 'admin',
  email: 'me@test.com',
  userId: 'u2',
};

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: async () => mockSession,
  };
});

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 3600;

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const h = await createTestDbClient('postgres');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = h.client;
  const cleanup = h.cleanup;

  try {
    const { schema } = await import('@/lib/db/schema');

    await client.insert(schema.users).values([
      { id: 'u1', email: 'u1@test.com', display_name: 'Ada Lovelace', department: 'Engineering' },
      { id: 'u2', email: 'u2@test.com', display_name: 'Grace Hopper', department: 'Engineering' },
      // Second department — exercises the dept_breakdown multi-row/ordering
      // path (not just the caller's own department).
      { id: 'u3', email: 'u3@test.com', display_name: 'Marie Curie', department: 'Marketing' },
      // Fourth — Legal department, with zero skill/connector invocations (so
      // it never appears in dept_breakdown/leaderboard, which both require
      // > 0 usage). Used below as the "someone in Legal" caller for the
      // department-visibility test: the visibility gate is keyed off the
      // UNION of session.department and the caller's own department looked
      // up from `users` by session.userId (callerDepts; the users-table
      // lookup alone is also the source for `user_dept`/dept_picks) — not a
      // client-supplied value — so proving inclusion needs a caller whose
      // actual users-table department really is Legal (or whose
      // session.department is, per the union tests further below).
      { id: 'u4', email: 'u4@test.com', display_name: 'Rosalind Franklin', department: 'Legal' },
    ]);

    // ── skill_library_entries: a published skill (author u1), an unclaimed
    // connector whose description matches a case-varied search term ──
    const insertedEntries = await client
      .insert(schema.skillLibraryEntries)
      .values([
        { name: 'brand-review', type: 'skill', surface: 'cowork', source: 'org', is_published: 1, author_user_id: 'u1', description: 'Reviews brand copy', created_at: NOW - 30 * DAY, updated_at: NOW - DAY },
        { name: 'slack-connector', type: 'connector', surface: 'cowork', source: 'org', is_published: 0, description: 'Connects to Slack workspaces', created_at: NOW - 30 * DAY, updated_at: NOW - 30 * DAY },
      ])
      .returning();
    const brandReviewId = insertedEntries.find((r: { name: string }) => r.name === 'brand-review').id;
    const slackId = insertedEntries.find((r: { name: string }) => r.name === 'slack-connector').id;

    // A third entry, restricted to Legal — proves department-visibility:
    // the caller (u2, Engineering) must not see it; someone in Legal, or an
    // admin/manager/viewer, must.
    const [legalEntry] = await client.insert(schema.skillLibraryEntries).values({
      name: 'legal-contract-review', type: 'skill', surface: 'cowork', source: 'org',
      is_published: 1, author_user_id: 'u1', description: 'Reviews contract redlines',
      department: 'Legal', created_at: NOW - DAY, updated_at: NOW - DAY,
    }).returning();
    const legalEntryId = legalEntry.id;

    // ── cowork_skill_invocations: brand-review used by u1 (x2, this week) +
    // u2 (x1, prior week) — drives invocation_count/user_count/week_count/
    // prev_week_count/trend_pct ──
    await client.insert(schema.coworkSkillInvocations).values([
      { id: 'si1', user_id: 'u1', session_id: 's1', skill_name: 'brand-review', occurred_at: NOW - DAY, invocation_type: 'user_typed' },
      { id: 'si2', user_id: 'u1', session_id: 's1', skill_name: 'brand-review', occurred_at: NOW - 2 * DAY, invocation_type: 'agent_chained' },
      { id: 'si3', user_id: 'u2', session_id: 's2', skill_name: 'brand-review', occurred_at: NOW - 10 * DAY, invocation_type: 'user_typed' },
      // u3 (Marketing) invokes a skill with no library entry — feeds
      // dept_breakdown's Marketing row without polluting brand-review's own
      // invocation_count/user_count (already asserted at 3/2 above) or
      // dept_picks (scoped to the caller u2's own department, Engineering).
      { id: 'si4', user_id: 'u3', session_id: 's3', skill_name: 'unlisted-marketing-skill', occurred_at: NOW - DAY, invocation_type: 'user_typed' },
    ]);

    // cowork_mcp_invocations: one connector use per department, to exercise
    // dept_breakdown's connector_uses column (previously untested — all prior
    // seed data had zero rows in this table).
    await client.insert(schema.coworkMcpInvocations).values([
      { id: 'mi1', user_id: 'u1', session_id: 's1', mcp_server: 'jira', mcp_tool: 'create_issue', occurred_at: NOW - DAY },
      { id: 'mi2', user_id: 'u3', session_id: 's3', mcp_server: 'github', mcp_tool: 'read_file', occurred_at: NOW - DAY },
    ]);

    // ── skill_library_votes: u2 already voted for brand-review ──
    await client.insert(schema.skillLibraryVotes).values([
      { entry_id: brandReviewId, voter_user_id: 'u2', voted_at: NOW - DAY },
    ]);

    // A user with NO department, whose invocation of legal-contract-review
    // is the only one that exists — needed so skills_to_try's own INNER
    // JOIN candidate set actually contains legal-contract-review (the
    // skills_to_try test, below): without a real invocation existing for it, the join
    // alone would already exclude it, making a department-leak assertion
    // vacuous rather than actually proving the department condition works.
    // No department keeps this user out of dept_breakdown (which requires
    // department IS NOT NULL AND != '') so it can't perturb the
    // dept_breakdown/leaderboard-ordering assertions elsewhere in this spec.
    await client.insert(schema.users).values([{ id: 'u5', email: 'u5@test.com', display_name: 'Unaffiliated Contributor' }]);
    await client.insert(schema.coworkSkillInvocations).values([
      { id: 'si5', user_id: 'u5', session_id: 's5', skill_name: 'legal-contract-review', occurred_at: NOW - DAY, invocation_type: 'user_typed' },
    ]);

    // ═══════════════════════════ GET /api/library (browse) ═══════════════════════════
    const { GET: libraryGET, POST: libraryPOST } = await import('../app/api/library/route');

    // Scoped to source=org so any source='anthropic' catalog entries (the
    // Postgres migration 0027 seeds four) can never
    // pollute the `total`/listing assertions below. Every other aggregate
    // this test checks (stats/capability/unclaimed_count) is already
    // source='org'-scoped in the route itself.
    const browseRes = await libraryGET(makeRequest('/api/library?source=org'));
    expect(browseRes.status).toBe(200);
    const browseBody = await browseRes.json();

    const brandEntry = browseBody.entries.find((x: { name: string }) => x.name === 'brand-review');
    expect(brandEntry).toBeDefined();
    // Gamification signal coercion — every one must be a real JS number, not a
    // string (the pg bug this conversion targets: bigint/COUNT come back as
    // strings from a raw postgres read).
    expect(typeof brandEntry.invocation_count).toBe('number');
    expect(brandEntry.invocation_count).toBe(3);
    expect(brandEntry.user_count).toBe(2);
    expect(brandEntry.vote_count).toBe(1);
    expect(brandEntry.user_voted).toBe(1); // caller (u2) has voted
    expect(brandEntry.week_count).toBe(2); // si1 + si2, both within 7 days
    expect(brandEntry.prev_week_count).toBe(1); // si3, 8-14 days ago
    expect(typeof brandEntry.created_at).toBe('number');
    expect(typeof brandEntry.updated_at).toBe('number');

    // Department visibility — caller is u2 (Engineering, role admin in this
    // mock, so org-overview bypass applies and they see it anyway). Prove
    // the restriction actually excludes a non-org-overview, wrong-department
    // caller, and includes a same-department caller.
    expect(browseBody.entries.find((x: { name: string }) => x.name === 'legal-contract-review')).toBeDefined();

    mockSession.role = 'cowork'; mockSession.department = 'Engineering';
    const wrongDeptRes = await libraryGET(makeRequest('/api/library?source=org'));
    const wrongDeptBody = await wrongDeptRes.json();
    expect(wrongDeptBody.entries.find((x: { name: string }) => x.name === 'legal-contract-review')).toBeUndefined();
    // Unclaimed entries stay visible regardless of department.
    expect(wrongDeptBody.entries.find((x: { name: string }) => x.name === 'slack-connector')).toBeDefined();

    // skills_to_try is a SEPARATE query from the main
    // listing above, with its own WHERE clause — it must not leak a
    // department-restricted entry's full content (name/description/
    // install_guide) just because the main listing correctly hides it. The
    // caller here (u2) has never invoked legal-contract-review, but si5/u5
    // (seeded above) gives the query's INNER JOIN a real candidate row, so
    // this assertion actually exercises the department condition rather
    // than being satisfied by the pre-existing NOT-IN self-exclusion.
    expect(wrongDeptBody.skills_to_try.map((x: { name: string }) => x.name)).not.toContain('legal-contract-review');

    // The headline stats/capability aggregates must be internally consistent
    // with the filtered listing above — a department-restricted entry the
    // caller cannot see must not inflate these counts either.
    // Visible-to-u2 set is brand-review (claimed skill, dept NULL)
    // + slack-connector (unclaimed connector) — legal-contract-review (dept
    // Legal) is excluded from all three.
    expect(wrongDeptBody.stats.skill_count).toBe(1);
    expect(wrongDeptBody.capability.total).toBe(2);
    expect(wrongDeptBody.capability.claimed).toBe(1);

    mockSession.userId = 'u4'; mockSession.role = 'cowork'; mockSession.department = 'Legal';
    const rightDeptRes = await libraryGET(makeRequest('/api/library?source=org'));
    const rightDeptBody = await rightDeptRes.json();
    expect(rightDeptBody.entries.find((x: { name: string }) => x.name === 'legal-contract-review')).toBeDefined();

    // "The caller's department" is the UNION of
    // session.department (admin_users) and the caller's users-table
    // department — before this fix, the browse route's gate checked ONLY
    // the users-table department and the detail route's gate checked ONLY
    // session.department, so a caller whose two sources disagree got
    // inconsistent (wrong) answers from the two routes. The scenario above
    // (rightDeptRes) sets BOTH sources to 'Legal', which can't distinguish
    // "union" from "either route's original single-source check alone" —
    // these two cases deliberately set the sources to DIFFERENT values and
    // prove each route grants access via EITHER source alone.
    const { GET: detailGETForUnionCheck } = await import('../app/api/library/[id]/route');

    // u4's users-table department really is 'Legal' (seeded above); session
    // claims a DIFFERENT department ('Marketing'). The users-table source
    // alone must be sufficient on BOTH routes, even though session
    // disagrees — this is the case that would have caught the detail
    // route's original session-only bug.
    mockSession.userId = 'u4'; mockSession.role = 'cowork'; mockSession.department = 'Marketing';
    const unionViaUsersTableRes = await libraryGET(makeRequest('/api/library?source=org'));
    const unionViaUsersTableBody = await unionViaUsersTableRes.json();
    expect(unionViaUsersTableBody.entries.find((x: { name: string }) => x.name === 'legal-contract-review')).toBeDefined();
    const unionDetailViaUsersTableRes = await detailGETForUnionCheck(makeRequest(`/api/library/${legalEntryId}`), { params: Promise.resolve({ id: String(legalEntryId) }) });
    expect(unionDetailViaUsersTableRes.status).toBe(200);

    // skills_to_try is built off its OWN raw
    // query with its own WHERE clause — it must use the same callerDepts
    // union as the main listing/detail routes above, not `userDept` alone.
    // u4 (this scenario) never invoked either skill, so both are real
    // INNER-JOIN candidates for "Skills to try". Proves inclusion via the
    // users-table source (this is the case the pre-fix `userDept`-only
    // comparison already handled correctly, since it agrees with the
    // union here) AND, via brand-review (department IS NULL, org-wide),
    // that the IS-NULL branch isn't accidentally droppable by this change.
    expect(unionViaUsersTableBody.skills_to_try.map((x: { name: string }) => x.name)).toContain('legal-contract-review');
    expect(unionViaUsersTableBody.skills_to_try.map((x: { name: string }) => x.name)).toContain('brand-review');

    // u3's users-table department is 'Marketing' (seeded above); session
    // claims 'Legal' instead. session.department alone must be sufficient
    // on BOTH routes, even though the users-table row disagrees — this is
    // the case that would have caught the browse route's original
    // users-table-only bug.
    mockSession.userId = 'u3'; mockSession.role = 'cowork'; mockSession.department = 'Legal';
    const unionViaSessionRes = await libraryGET(makeRequest('/api/library?source=org'));
    const unionViaSessionBody = await unionViaSessionRes.json();
    expect(unionViaSessionBody.entries.find((x: { name: string }) => x.name === 'legal-contract-review')).toBeDefined();
    const unionDetailViaSessionRes = await detailGETForUnionCheck(makeRequest(`/api/library/${legalEntryId}`), { params: Promise.resolve({ id: String(legalEntryId) }) });
    expect(unionDetailViaSessionRes.status).toBe(200);

    // Same scenario, but for skills_to_try specifically: this is exactly
    // the disagreeing-source case the pre-fix `userDept`-only comparison
    // would have gotten WRONG (u3's users-table department is 'Marketing',
    // not 'Legal' — the old single-source check would have excluded
    // legal-contract-review here even though the main listing/detail routes
    // already included it via session.department). Now it must be included
    // via session.department alone.
    expect(unionViaSessionBody.skills_to_try.map((x: { name: string }) => x.name)).toContain('legal-contract-review');

    // Restore the session used by the rest of this spec.
    mockSession.userId = 'u2'; mockSession.role = 'admin'; mockSession.department = undefined;

    // department=mine restricts the listing to the caller's own department's
    // restricted entries plus org-wide ones — a persistent filter, not just
    // a carousel slide.
    // NOTE: `department=mine` is keyed off the same callerDepts union
    // (session.department UNION the users-table lookup by session.userId)
    // as the security visibility gate above — so this case (both sources
    // set to 'Legal') doesn't by itself distinguish "union" from "either
    // source alone"; it just needs userId to actually be a Legal-department
    // user (u4) for the assertion to be meaningful, mirroring the pattern at
    // line ~201. The dual-source disagreement is exercised separately by the
    // union tests above.
    mockSession.userId = 'u4'; mockSession.role = 'cowork'; mockSession.department = 'Legal';
    const mineRes = await libraryGET(makeRequest('/api/library?source=org&department=mine'));
    const mineBody = await mineRes.json();
    expect(mineBody.entries.map((x: { name: string }) => x.name).sort()).toEqual(['brand-review', 'legal-contract-review', 'slack-connector'].sort());

    mockSession.userId = 'u2'; mockSession.role = 'cowork'; mockSession.department = 'Engineering';
    const mineEngRes = await libraryGET(makeRequest('/api/library?source=org&department=mine'));
    const mineEngBody = await mineEngRes.json();
    expect(mineEngBody.entries.map((x: { name: string }) => x.name)).not.toContain('legal-contract-review');

    // Restore the session used by the rest of this spec.
    mockSession.userId = 'u2'; mockSession.role = 'admin'; mockSession.department = undefined;

    // Totals/stats/capability now include the third (Legal) org/published
    // skill entry seeded above — this call's caller (admin) bypasses the
    // visibility gate via org-overview, so it counts everywhere org-scoped
    // aggregates aren't otherwise filtered.
    expect(browseBody.total).toBe(3);
    expect(browseBody.unclaimed_count).toBe(1);
    expect(browseBody.stats.skill_count).toBe(2);
    expect(browseBody.stats.connector_count).toBe(1);
    expect(browseBody.capability.claimed).toBe(2);
    expect(browseBody.capability.total).toBe(3);

    // Leaderboard — u1 (2 skill invocations) outranks u2 (1).
    expect(browseBody.leaderboard[0].user_id).toBe('u1');
    expect(browseBody.leaderboard[0].skill_count).toBe(2);
    expect(browseBody.user_rank).not.toBeNull();
    expect(browseBody.user_rank.skill_count).toBe(1); // caller is u2

    // dept_picks — caller (u2, dept Engineering) sees org-wide top picks used
    // within their own department. Only the PUBLISHED brand-review qualifies
    // (unpublished slack-connector is excluded via e.is_published = 1); u3's
    // Marketing-dept usage never enters this row since it's scoped to the
    // caller's department. This is the query the portability fix rewrote
    // `GROUP BY e.name` -> `GROUP BY e.id, e.name, e.type, e.description,
    // e.install_guide` for — reverting that throws on strict Postgres (every
    // non-aggregated e.* SELECT column must appear in GROUP BY there).
    expect(browseBody.user_dept).toBe('Engineering');
    expect(browseBody.dept_picks).toHaveLength(1);
    expect(browseBody.dept_picks[0]).toMatchObject({
      id: brandReviewId,
      name: 'brand-review',
      type: 'skill',
      description: 'Reviews brand copy',
      install_guide: null,
      invocation_count: 3,
      user_count: 2,
    });

    // dept_breakdown — org-wide per-department usage, NOT scoped to the
    // caller, so both departments appear. Engineering (u1 + u2: 3 skill uses
    // + u1's 1 connector use) outranks Marketing (u3 alone: 1 skill + 1
    // connector use). This proves the `HAVING COALESCE(SUM(...)) +
    // COALESCE(SUM(...)) > 0` rewrite (replacing the SELECT-list alias
    // `total_uses`, which Postgres cannot reference in HAVING) both admits
    // every non-empty department and computes the right totals/ordering.
    expect(browseBody.dept_breakdown).toEqual([
      { department: 'Engineering', user_count: 2, skill_uses: 3, connector_uses: 1, total_uses: 4 },
      { department: 'Marketing', user_count: 1, skill_uses: 1, connector_uses: 1, total_uses: 2 },
    ]);

    // Case-insensitive search: uppercase query must still find
    // the lowercase description.
    const searchRes = await libraryGET(makeRequest('/api/library?q=SLACK'));
    const searchBody = await searchRes.json();
    expect(searchBody.entries.map((x: { name: string }) => x.name)).toContain('slack-connector');

    const searchNameRes = await libraryGET(makeRequest('/api/library?q=BRAND-REVIEW'));
    const searchNameBody = await searchNameRes.json();
    expect(searchNameBody.entries.map((x: { name: string }) => x.name)).toEqual(['brand-review']);

    // ═══════════════════════════ POST /api/library (submit) ═══════════════════════════
    // New entry — .returning() gives back a real id (never lastInsertRowid).
    const newRes = await libraryPOST(new NextRequest('http://localhost/api/library', {
      method: 'POST',
      body: JSON.stringify({ name: 'new-skill', type: 'skill', description: 'Brand new' }),
    }));
    expect(newRes.status).toBe(201);
    const newBody = await newRes.json();
    expect(typeof newBody.id).toBe('number');
    expect(newBody.name).toBe('new-skill');
    expect(newBody.is_published).toBe(1);

    // Resubmitting the unclaimed slack-connector claims it in place (same id).
    const claimRes = await libraryPOST(new NextRequest('http://localhost/api/library', {
      method: 'POST',
      body: JSON.stringify({ name: 'slack-connector', type: 'connector', install_guide: 'claude install slack' }),
    }));
    expect(claimRes.status).toBe(200);
    const claimBody = await claimRes.json();
    expect(claimBody.id).toBe(slackId);
    expect(claimBody.is_published).toBe(1);
    expect(claimBody.install_guide).toBe('claude install slack');

    // Resubmitting the already-published brand-review conflicts.
    const conflictRes = await libraryPOST(new NextRequest('http://localhost/api/library', {
      method: 'POST',
      body: JSON.stringify({ name: 'brand-review' }),
    }));
    expect(conflictRes.status).toBe(409);

    // ═══════════════════════════ GET /api/library/[id] (detail) ═══════════════════════════
    const { GET: detailGET, PATCH: detailPATCH } = await import('../app/api/library/[id]/route');

    const detailRes = await detailGET(makeRequest(`/api/library/${brandReviewId}`), { params: Promise.resolve({ id: String(brandReviewId) }) });
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json();
    expect(detailBody.stats.total_invocations).toBe(3);
    expect(detailBody.stats.week_count).toBe(2);
    expect(detailBody.stats.prev_week_count).toBe(1);
    expect(detailBody.stats.distinct_users).toBe(2);
    expect(detailBody.stats.vote_count).toBe(1);
    expect(detailBody.stats.user_voted).toBe(true);
    expect(detailBody.stats.agent_chained_pct).toBe(Math.round((1 / 3) * 100));
    // is_author server-computed: caller is u2, author is u1.
    expect(detailBody.is_author).toBe(false);
    expect(detailBody.top_users.find((x: { user_id: string }) => x.user_id === 'u1').cnt).toBe(2);

    // Department visibility on the detail route — a wrong-department,
    // non-org-overview caller gets 404 (indistinguishable from "not found"),
    // an admin/manager/viewer or same-department caller still gets 200.
    mockSession.role = 'cowork'; mockSession.department = 'Engineering';
    const hiddenDetailRes = await detailGET(makeRequest(`/api/library/${legalEntryId}`), { params: Promise.resolve({ id: String(legalEntryId) }) });
    expect(hiddenDetailRes.status).toBe(404);

    mockSession.role = 'cowork'; mockSession.department = 'Legal';
    const visibleDetailRes = await detailGET(makeRequest(`/api/library/${legalEntryId}`), { params: Promise.resolve({ id: String(legalEntryId) }) });
    expect(visibleDetailRes.status).toBe(200);

    // Restore the session used by the rest of this spec.
    mockSession.role = 'admin'; mockSession.department = undefined;

    // ═══════════════════════════ PATCH /api/library/[id] ═══════════════════════════
    const patchRes = await detailPATCH(new NextRequest(`http://localhost/api/library/${brandReviewId}`, {
      method: 'PATCH',
      body: JSON.stringify({ description: 'Updated description' }),
    }), { params: Promise.resolve({ id: String(brandReviewId) }) });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.description).toBe('Updated description');
    expect(typeof patchBody.updated_at).toBe('number');

    // ═══════════════════ PATCH authorization: non-author, non-admin/manager ═══════════════════
    // A completely different user, with no admin/manager role, must NOT be
    // able to edit an entry they don't own — this was previously missing
    // entirely (any authenticated user could PATCH any entry).
    mockSession.userId = 'u3'; mockSession.role = 'viewer';
    const forbiddenPatchRes = await detailPATCH(new NextRequest(`http://localhost/api/library/${brandReviewId}`, {
      method: 'PATCH',
      body: JSON.stringify({ description: 'Hijacked description' }),
    }), { params: Promise.resolve({ id: String(brandReviewId) }) });
    expect(forbiddenPatchRes.status).toBe(403);

    // The author themself can still edit, independent of role.
    mockSession.userId = 'u1'; mockSession.role = 'viewer';
    const authorPatchRes = await detailPATCH(new NextRequest(`http://localhost/api/library/${brandReviewId}`, {
      method: 'PATCH',
      body: JSON.stringify({ description: 'Author update' }),
    }), { params: Promise.resolve({ id: String(brandReviewId) }) });
    expect(authorPatchRes.status).toBe(200);

    // department: an author who is not admin/manager cannot set it.
    const authorDeptRes = await detailPATCH(new NextRequest(`http://localhost/api/library/${brandReviewId}`, {
      method: 'PATCH',
      body: JSON.stringify({ department: 'Marketing' }),
    }), { params: Promise.resolve({ id: String(brandReviewId) }) });
    expect(authorDeptRes.status).toBe(403);

    // department: an admin/manager can set it, even as a non-author.
    mockSession.userId = 'u2'; mockSession.role = 'manager';
    const managerDeptRes = await detailPATCH(new NextRequest(`http://localhost/api/library/${brandReviewId}`, {
      method: 'PATCH',
      body: JSON.stringify({ department: 'Marketing' }),
    }), { params: Promise.resolve({ id: String(brandReviewId) }) });
    expect(managerDeptRes.status).toBe(200);
    const managerDeptBody = await managerDeptRes.json();
    expect(managerDeptBody.department).toBe('Marketing');

    // Restore the session used by the rest of this spec.
    mockSession.userId = 'u2'; mockSession.role = 'admin';

    // ═══════════════════════════ POST /api/library/[id]/vote ═══════════════════════════
    const { POST: voteRoute } = await import('../app/api/library/[id]/vote/route');

    // A brand-new voter with no pre-existing `users` row — the FK-safety
    // auto-upsert (onConflictDoNothing) must let this through.
    mockSession.userId = 'voter-new@test.com';
    const voteRes = await voteRoute(new NextRequest(`http://localhost/api/library/${slackId}/vote`, { method: 'POST' }), { params: Promise.resolve({ id: String(slackId) }) });
    expect(voteRes.status).toBe(200);
    const voteBody = await voteRes.json();
    expect(voteBody.voted).toBe(true);
    expect(voteBody.count).toBe(1);

    const usersRows = await client.select({ id: schema.users.id }).from(schema.users).where((await import('drizzle-orm')).eq(schema.users.id, 'voter-new@test.com'));
    expect(usersRows).toHaveLength(1);

    // Toggle off — same voter votes again, un-voting.
    const unvoteRes = await voteRoute(new NextRequest(`http://localhost/api/library/${slackId}/vote`, { method: 'POST' }), { params: Promise.resolve({ id: String(slackId) }) });
    const unvoteBody = await unvoteRes.json();
    expect(unvoteBody.voted).toBe(false);
    expect(unvoteBody.count).toBe(0);

    mockSession.userId = 'u2'; // restore
  } finally {
    await cleanup();
  }
}

describe('library routes (postgres)', () => {
  it(
    'return correctly-aggregated JSON with COUNT-string coercion, ILIKE case-insensitive search, RETURNING writes, and onConflictDoNothing user auto-upsert on real postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
