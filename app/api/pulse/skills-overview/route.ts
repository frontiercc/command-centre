// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> +
// query-builder groupBy + notInArray for the NOT IN literal list. Every
// COUNT/COUNT(DISTINCT) aggregate is Number()-coerced (bigint
// comes back as a STRING on Postgres).
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, gte, notInArray, sql } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

const EXCLUDED_CONNECTORS = ['workspace', 'cowork'];

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 24 * 3600;

  const au = schema.adminUsers;
  const u = schema.users;
  const csi = schema.coworkSkillInvocations;
  const cmi = schema.coworkMcpInvocations;

  // Resolve the current user's cowork user_id
  let userId: string | null = null;
  const linkedRows = await client
    .select({ linked_cowork_user_id: au.linked_cowork_user_id })
    .from(au)
    .where(eq(au.email, session.email!))
    .limit(1);
  const linked = linkedRows[0];
  if (linked?.linked_cowork_user_id) {
    userId = linked.linked_cowork_user_id;
  } else {
    const byEmailRows = await client.select({ id: u.id }).from(u).where(eq(u.email, session.email!)).limit(1);
    userId = byEmailRows[0]?.id ?? null;
  }

  // Org top skills (30 days)
  const topSkillsRows = await client
    .select({
      skill_name: csi.skill_name,
      usage_count: sql<number | string>`COUNT(*)`,
      user_count: sql<number | string>`COUNT(DISTINCT ${csi.user_id})`,
    })
    .from(csi)
    .where(gte(csi.occurred_at, thirtyDaysAgo))
    .groupBy(csi.skill_name)
    .orderBy(sql`COUNT(*) DESC`)
    .limit(10);
  const topSkills = topSkillsRows.map(r => ({ skill_name: r.skill_name, usage_count: Number(r.usage_count), user_count: Number(r.user_count) }));

  // Org top connectors (30 days, exclude system defaults)
  const topConnectorsRows = await client
    .select({
      mcp_server: cmi.mcp_server,
      usage_count: sql<number | string>`COUNT(*)`,
      user_count: sql<number | string>`COUNT(DISTINCT ${cmi.user_id})`,
    })
    .from(cmi)
    .where(and(gte(cmi.occurred_at, thirtyDaysAgo), notInArray(cmi.mcp_server, EXCLUDED_CONNECTORS)))
    .groupBy(cmi.mcp_server)
    .orderBy(sql`COUNT(*) DESC`)
    .limit(10);
  const topConnectors = topConnectorsRows.map(r => ({ mcp_server: r.mcp_server, usage_count: Number(r.usage_count), user_count: Number(r.user_count) }));

  // User's own skills and connectors (30 days)
  let mySkills: Array<{ skill_name: string; usage_count: number }> = [];
  let myConnectors: Array<{ mcp_server: string; usage_count: number }> = [];

  if (userId) {
    const mySkillsRows = await client
      .select({ skill_name: csi.skill_name, usage_count: sql<number | string>`COUNT(*)` })
      .from(csi)
      .where(and(eq(csi.user_id, userId), gte(csi.occurred_at, thirtyDaysAgo)))
      .groupBy(csi.skill_name);
    mySkills = mySkillsRows.map(r => ({ skill_name: r.skill_name, usage_count: Number(r.usage_count) }));

    const myConnectorsRows = await client
      .select({ mcp_server: cmi.mcp_server, usage_count: sql<number | string>`COUNT(*)` })
      .from(cmi)
      .where(and(eq(cmi.user_id, userId), gte(cmi.occurred_at, thirtyDaysAgo), notInArray(cmi.mcp_server, EXCLUDED_CONNECTORS)))
      .groupBy(cmi.mcp_server);
    myConnectors = myConnectorsRows.map(r => ({ mcp_server: r.mcp_server, usage_count: Number(r.usage_count) }));
  }

  // Compute gap: org top items the current user hasn't used
  const mySkillSet = new Set(mySkills.map(s => s.skill_name));
  const myConnectorSet = new Set(myConnectors.map(c => c.mcp_server));

  const skillGap = topSkills.filter(s => !mySkillSet.has(s.skill_name));
  const connectorGap = topConnectors.filter(c => !myConnectorSet.has(c.mcp_server));

  return NextResponse.json({
    topSkills,
    topConnectors,
    mySkills,
    myConnectors,
    skillGap,
    connectorGap,
  });
}
