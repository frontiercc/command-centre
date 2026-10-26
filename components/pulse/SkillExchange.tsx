// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Panel, Tag, Bar, Muted } from '@/components/precision/ui';

export interface SkillExchangeItem {
  skill_name: string;
  adopter_count: number;
  total_active_members: number;
  adoption_rate: number;
  concentration_risk: boolean;
  first_used_by: string;
  invocation_types?: string[];
}

interface SkillExchangeProps {
  skills: SkillExchangeItem[];
}

function InvocationTypeBadge({ type }: { type: string }) {
  return <Tag>{type === 'agent_chained' ? 'Agent chained' : 'User typed'}</Tag>;
}

export default function SkillExchange({ skills }: SkillExchangeProps) {
  return (
    <Panel title="Skill exchange" subtitle="Who on the team uses each skill" flush={skills.length > 0}>
      {skills.length === 0 ? (
        <Muted>
          No team skills logged yet. Skills appear here when team members invoke Claude Code skills during Cowork sessions.
        </Muted>
      ) : (
        <ul className="m-0 p-0 list-none">
          {skills.map((skill, i) => (
            <li key={i} className="px-4 py-2.5 border-t border-[#F2F2F2] first:border-t-0 flex flex-col gap-1.5">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <span className="text-[14px] font-medium text-[#0A0A0A] truncate">{skill.skill_name}</span>
                {skill.concentration_risk && <Tag tone="warn">Concentration risk</Tag>}
                {(skill.invocation_types ?? []).map(type => (
                  <InvocationTypeBadge key={type} type={type} />
                ))}
              </div>
              <div className="flex items-center gap-2">
                <div className="w-24"><Bar pct={Math.round(skill.adoption_rate * 100)} tone="measured" height={4} /></div>
                <span className="text-[13px] text-[#666666] tabular-nums">
                  {skill.adopter_count} of {skill.total_active_members}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
