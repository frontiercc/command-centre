// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> +
// query-builder inArray/groupBy for every aggregate (MIN/MAX/COUNT). Every
// raw-SQL COUNT/MAX aggregate is Number()-coerced (bigint comes
// back as a STRING on Postgres; MAX(tier) on an integer column is safe on
// both, coerced anyway for consistency with the rest of this file).
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { getAdminSession, canAccessCoworkPulse, canAccessCorePlatform, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Role first, then input: a caller outside the role set is refused (403)
  // whatever the query string says.
  if (!canAccessCoworkPulse(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const dept = request.nextUrl.searchParams.get('dept');
  const userId = request.nextUrl.searchParams.get('userId');

  if (!dept && !userId) {
    return NextResponse.json({ error: 'dept or userId required' }, { status: 400 });
  }

  const client = await getTypedClient();

  // Admins and managers may ask about any department or person — the same
  // reach /api/pulse/me gives them. Everyone else may ask only about their own
  // department, or about themselves (the /pulse/me call). An org-wide viewer
  // with no department may ask about any department.
  if (!canAccessPulseAdmin(session.role)) {
    if (dept) {
      const ownDept = session.department || null;
      const allowed = ownDept ? dept === ownDept : canAccessCorePlatform(session.role);
      if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    } else {
      // "Me" is resolved exactly as /api/pulse/me does: the linked cowork
      // user first, then a users row with the same email.
      const linked = await client
        .select({ id: schema.adminUsers.linked_cowork_user_id })
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.email, session.email!))
        .limit(1);
      let me = linked[0]?.id ?? null;
      if (!me) {
        const byEmail = await client
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, session.email!))
          .limit(1);
        me = byEmail[0]?.id ?? null;
      }
      if (!me || me !== userId) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }
  }

  const THIRTY_DAYS = 30 * 24 * 60 * 60;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - THIRTY_DAYS;

  const au = schema.adminUsers;
  const u = schema.users;
  const csi = schema.coworkSkillInvocations;
  const cm = schema.coworkMessages;
  const pc = schema.pulseClassifications;

  // Resolve member list — all users in department, OR single user fallback
  let memberRows: Array<{ id: string; email: string | null; display_name: string | null }>;
  if (dept) {
    memberRows = await client
      .select({ id: u.id, email: u.email, display_name: u.display_name })
      .from(au)
      .innerJoin(u, eq(u.id, au.linked_cowork_user_id))
      .where(and(eq(au.department, dept), isNotNull(au.linked_cowork_user_id)));
  } else {
    memberRows = await client.select({ id: u.id, email: u.email, display_name: u.display_name }).from(u).where(eq(u.id, userId!));
  }

  if (memberRows.length === 0) {
    return NextResponse.json({ skills: [], summary: { total_distinct_skills: 0, skills_shared_by_2plus: 0, skill_propagation_rate: null, concentration_risks: [] } });
  }

  const memberIds = memberRows.map(r => r.id);
  const memberMap = new Map(memberRows.map(r => [r.id, r.email]));

  // Active members: any cowork session in last 30d
  const activeRows = await client
    .selectDistinct({ user_id: csi.user_id })
    .from(csi)
    .where(and(inArray(csi.user_id, memberIds), gte(csi.occurred_at, windowStart)));

  const totalActiveMembers = activeRows.length;

  // All skill invocations by team members in last 30d, with first-use info
  const skillRows = await client
    .select({
      skill_name: csi.skill_name,
      user_id: csi.user_id,
      first_used_at: sql<number | string>`MIN(${csi.occurred_at})`,
    })
    .from(csi)
    .where(and(inArray(csi.user_id, memberIds), gte(csi.occurred_at, windowStart)))
    .groupBy(csi.skill_name, csi.user_id);

  // Invocation type breakdown per skill — determines badge shown in Skills Exchange
  const typeRows = await client
    .select({
      skill_name: csi.skill_name,
      invocation_type: csi.invocation_type,
      cnt: sql<number | string>`COUNT(*)`,
    })
    .from(csi)
    .where(and(inArray(csi.user_id, memberIds), gte(csi.occurred_at, windowStart)))
    .groupBy(csi.skill_name, csi.invocation_type);

  // Build a map of skill_name → set of invocation types seen
  const skillTypeMap = new Map<string, Set<string>>();
  for (const row of typeRows) {
    const types = skillTypeMap.get(row.skill_name) ?? new Set<string>();
    types.add(row.invocation_type || 'user_typed');
    skillTypeMap.set(row.skill_name, types);
  }

  // Group by skill name
  const skillMap = new Map<string, {
    adopters: Map<string, number>; // user_id → first_used_at
    globalFirst: number;
    globalFirstUser: string;
  }>();

  for (const row of skillRows) {
    const firstUsedAt = Number(row.first_used_at);
    if (!skillMap.has(row.skill_name)) {
      skillMap.set(row.skill_name, {
        adopters: new Map(),
        globalFirst: firstUsedAt,
        globalFirstUser: row.user_id,
      });
    }
    const entry = skillMap.get(row.skill_name)!;
    entry.adopters.set(row.user_id, firstUsedAt);
    if (firstUsedAt < entry.globalFirst) {
      entry.globalFirst = firstUsedAt;
      entry.globalFirstUser = row.user_id;
    }
  }

  // Get tier context for skills (highest tier session where each skill was used)
  const tierRows = await client
    .select({ skill_name: csi.skill_name, tier_at_use: sql<number | string | null>`MAX(${pc.tier})` })
    .from(csi)
    .innerJoin(cm, eq(cm.session_id, csi.session_id))
    .innerJoin(pc, eq(pc.cowork_message_id, cm.id))
    .where(and(inArray(csi.user_id, memberIds), gte(csi.occurred_at, windowStart), eq(pc.classifier_status, 'classified')))
    .groupBy(csi.skill_name);

  const tierMap = new Map(tierRows.map(r => [r.skill_name, r.tier_at_use !== null && r.tier_at_use !== undefined ? Number(r.tier_at_use) : null]));

  // Build skill entries
  const skills = Array.from(skillMap.entries()).map(([skill_name, data]) => {
    const adopters = Array.from(data.adopters.keys()).map(id => memberMap.get(id) ?? id);
    const adopter_count = adopters.length;
    const adoption_rate = totalActiveMembers > 0 ? adopter_count / totalActiveMembers : 0;
    const invocation_types = Array.from(skillTypeMap.get(skill_name) ?? ['user_typed']);
    return {
      skill_name,
      tier_at_use: tierMap.get(skill_name) ?? null,
      first_used_by: memberMap.get(data.globalFirstUser) ?? data.globalFirstUser,
      first_used_at: data.globalFirst,
      adopters,
      adopter_count,
      total_active_members: totalActiveMembers,
      adoption_rate: Math.round(adoption_rate * 1000) / 1000,
      concentration_risk: adopter_count === 1,
      invocation_types,
    };
  }).sort((a, b) => b.adopter_count - a.adopter_count);

  // Summary
  const total_distinct_skills = skills.length;
  const skills_shared_by_2plus = skills.filter(s => s.adopter_count >= 2).length;
  const skill_propagation_rate = total_distinct_skills > 0
    ? Math.round((skills_shared_by_2plus / total_distinct_skills) * 1000) / 1000
    : null;
  const concentration_risks = skills
    .filter(s => s.concentration_risk)
    .map(s => s.skill_name);

  return NextResponse.json({
    skills,
    summary: {
      total_distinct_skills,
      skills_shared_by_2plus,
      skill_propagation_rate,
      concentration_risks,
    },
  });
}
