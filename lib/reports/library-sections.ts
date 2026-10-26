// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Deterministic Skills & Connectors section for the governance report.
//
// Framed as governance rather than catalogue: what tooling is in production,
// who owns it, where it is concentrated, and what moves data outward. A list of
// skill names is browsing material; ownership gaps and key-person dependencies
// are decisions someone has to make.
//
// All figures here are MEASURED — counts of observed invocations and registry
// rows. No classifier is involved.
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { classifyMcpTool } from '@/lib/pulse/mcp-classify';

export interface ToolUsage {
  name: string;
  invocations: number;
  users: number;
  departments: number;
}

export interface ScBoardFacts {
  hasData: boolean;
  newEntries: Array<{ name: string; type: string; createdAt: number }>;
  unclaimed: Array<{ name: string; type: string }>;
  totalEntries: number;
  topSkills: ToolUsage[];
  topConnectors: ToolUsage[];
  connectorReads: number;
  connectorWrites: number;
  connectorUnknown: number;
  singleUserTools: string[];
  crossDeptTools: string[];
}

function int(n: number): string {
  return n.toLocaleString('en-GB');
}

function usageTable(rows: ToolUsage[], emptyMessage: string): string {
  if (rows.length === 0) return emptyMessage;
  return `| Name | Invocations | Users | Departments |
|---|---|---|---|
${rows.map(r => `| ${r.name} | ${int(r.invocations)} | ${int(r.users)} | ${int(r.departments)} |`).join('\n')}`;
}

export function renderScBoardSection(f: ScBoardFacts): string {
  if (!f.hasData) {
    return `## Skills & Connectors

No skills or connectors have been observed in telemetry for this period.`;
  }

  const newBlock = f.newEntries.length === 0
    ? 'No new skills or connectors appeared during this period.'
    : `${int(f.newEntries.length)} new entr${f.newEntries.length === 1 ? 'y' : 'ies'} appeared during this period: ${f.newEntries.map(e => `${e.name} (${e.type})`).join(', ')}.`;

  const unclaimedBlock = f.unclaimed.length === 0
    ? `All ${int(f.totalEntries)} registered entries have a named owner.`
    : `**${int(f.unclaimed.length)} of ${int(f.totalEntries)} registered entries have no named owner**, meaning tooling is in use with nobody accountable for it: ${f.unclaimed.slice(0, 20).map(e => `${e.name} (${e.type})`).join(', ')}${f.unclaimed.length > 20 ? ', and others' : ''}.`;

  const totalConnectorCalls = f.connectorReads + f.connectorWrites + f.connectorUnknown;
  const dataMovement = totalConnectorCalls === 0
    ? 'No connector invocations were recorded in this period.'
    : `Connector calls split ${int(f.connectorReads)} read, ${int(f.connectorWrites)} write, ${int(f.connectorUnknown)} unclassified. Write calls are the ones that change state in an external system and are the more material of the three for review.`;

  const keyPerson = f.singleUserTools.length === 0
    ? 'No tool in use depends on a single person.'
    : `${int(f.singleUserTools.length)} tool${f.singleUserTools.length === 1 ? '' : 's'} were used by exactly one person, which is a key-person dependency if the work matters: ${f.singleUserTools.slice(0, 15).join(', ')}${f.singleUserTools.length > 15 ? ', and others' : ''}.`;

  const spread = f.crossDeptTools.length === 0
    ? 'No tool is in use across more than one department.'
    : `${int(f.crossDeptTools.length)} tool${f.crossDeptTools.length === 1 ? ' is' : 's are'} in use across more than one department, which is the closest available signal of something having become standard practice: ${f.crossDeptTools.slice(0, 15).join(', ')}${f.crossDeptTools.length > 15 ? ', and others' : ''}.`;

  return `## Skills & Connectors

### New this period

${newBlock}

### Ownership

${unclaimedBlock}

### Most used skills

${usageTable(f.topSkills, 'No skill invocations were recorded in this period.')}

### Most used connectors

${usageTable(f.topConnectors, 'No connector invocations were recorded in this period.')}

${dataMovement}

### Concentration

${keyPerson}

${spread}`;
}

export async function buildScBoardSection(periodStart: string, periodEnd: string): Promise<string> {
  const db = await getTypedClient();
  const startS = Math.floor(new Date(periodStart).getTime() / 1000);
  const endS = Math.floor(new Date(periodEnd).getTime() / 1000) + 86_399;

  const sle = schema.skillLibraryEntries;
  const csi = schema.coworkSkillInvocations;
  const cmi = schema.coworkMcpInvocations;
  const u = schema.users;

  const [entries, newEntries, skillRows, connectorRows, toolKinds] = await Promise.all([
    db.select({ name: sle.name, type: sle.type, author: sle.author_user_id }).from(sle),
    db
      .select({ name: sle.name, type: sle.type, createdAt: sle.created_at })
      .from(sle)
      .where(and(gte(sle.created_at, startS), sql`${sle.created_at} <= ${endS}`))
      .orderBy(desc(sle.created_at))
      .limit(25),
    db
      .select({
        name: csi.skill_name,
        invocations: sql<number | string>`count(*)`,
        users: sql<number | string>`count(distinct ${csi.user_id})`,
        departments: sql<number | string>`count(distinct ${u.department})`,
      })
      .from(csi)
      .leftJoin(u, eq(u.id, csi.user_id))
      .where(and(gte(csi.occurred_at, startS), lte(csi.occurred_at, endS)))
      .groupBy(csi.skill_name)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({
        name: cmi.mcp_server,
        invocations: sql<number | string>`count(*)`,
        users: sql<number | string>`count(distinct ${cmi.user_id})`,
        departments: sql<number | string>`count(distinct ${u.department})`,
      })
      .from(cmi)
      .leftJoin(u, eq(u.id, cmi.user_id))
      .where(and(gte(cmi.occurred_at, startS), lte(cmi.occurred_at, endS)))
      .groupBy(cmi.mcp_server)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({ tool: cmi.mcp_tool, count: sql<number | string>`count(*)` })
      .from(cmi)
      .where(and(gte(cmi.occurred_at, startS), lte(cmi.occurred_at, endS)))
      .groupBy(cmi.mcp_tool),
  ]);

  let reads = 0, writes = 0, unknown = 0;
  for (const row of toolKinds) {
    const n = Number(row.count);
    const kind = classifyMcpTool(row.tool);
    if (kind === 'read') reads += n;
    else if (kind === 'write') writes += n;
    else unknown += n;
  }

  const toUsage = (r: { name: string; invocations: number | string; users: number | string; departments: number | string }): ToolUsage => ({
    name: r.name,
    invocations: Number(r.invocations),
    users: Number(r.users),
    departments: Number(r.departments),
  });

  const skills = skillRows.map(toUsage);
  const connectors = connectorRows.map(toUsage);
  const all = [...skills, ...connectors];

  return renderScBoardSection({
    hasData: entries.length > 0 || all.length > 0,
    newEntries: newEntries.map(e => ({ name: e.name, type: e.type, createdAt: e.createdAt })),
    unclaimed: entries.filter(e => !e.author).map(e => ({ name: e.name, type: e.type })),
    totalEntries: entries.length,
    topSkills: skills.slice(0, 10),
    topConnectors: connectors.slice(0, 10),
    connectorReads: reads,
    connectorWrites: writes,
    connectorUnknown: unknown,
    singleUserTools: all.filter(t => t.users === 1).map(t => t.name),
    crossDeptTools: all.filter(t => t.departments > 1).map(t => t.name),
  });
}
