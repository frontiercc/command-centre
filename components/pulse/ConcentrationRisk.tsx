// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Panel, SubHead, Tag, Muted } from '@/components/precision/ui';

interface ConcentrationRiskEntry {
  user_id: string;
  display_name: string | null;
  sole_workflows: number;
}

// Priority 7 — drill-down: user → sole task types
interface ConcentrationDetail {
  user_id: string;
  display_name: string | null;
  task_types: string[];
}

interface SkillConcentrationEntry {
  user_id: string;
  display_name: string | null;
  skills: string[];
}

interface ConcentrationRiskProps {
  risks: ConcentrationRiskEntry[];
  ors: number | null;
  detail?: ConcentrationDetail[];
  skillConcentration?: SkillConcentrationEntry[];
}

export default function ConcentrationRisk({ risks, ors, skillConcentration }: ConcentrationRiskProps) {
  const hasRisk = risks.length > 0;
  const hasSkillConcentration = skillConcentration && skillConcentration.length > 0;
  const orsLow = ors !== null && ors < 0.7;

  return (
    <Panel
      title="Concentration risk"
      badge={hasRisk ? <Tag tone="warn">{risks.length} flagged</Tag> : undefined}
      flush
    >
      {!hasRisk ? (
        <div className="p-4">
          <Muted>No concentration risk detected. Tier 3 workflows are distributed across the team.</Muted>
        </div>
      ) : (
        <>
          <p className="m-0 px-4 pt-3 pb-2 text-[14px] text-[#333333]">
            {risks.length === 1 ? 'One team member is' : `${risks.length} team members are`} the sole runner
            of 3 or more Tier 3 workflows.
          </p>
          <ul className="m-0 p-0 list-none">
            {risks.map(r => (
              <li key={r.user_id} className="px-4 py-2.5 border-t border-[#F2F2F2] flex items-center justify-between gap-3">
                <span className="text-[14px] font-medium text-[#0A0A0A] truncate">
                  {r.display_name ?? r.user_id}
                </span>
                <span className="text-[13px] font-medium text-[#B54708] tabular-nums shrink-0">
                  {r.sole_workflows} sole workflow{r.sole_workflows === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Sole practitioners by skill — from cowork_skill_invocations */}
      {hasSkillConcentration && (
        <div className="px-4 py-3 border-t border-[#EAEAEA]">
          <SubHead>Sole practitioners by skill</SubHead>
          <div className="flex flex-col gap-2.5">
            {skillConcentration!.map(d => (
              <div key={d.user_id}>
                <p className="m-0 mb-1 text-[14px] font-medium text-[#0A0A0A]">
                  {d.display_name ?? d.user_id}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {d.skills.map(s => (
                    <Tag key={s} tone="warn">{s}</Tag>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {orsLow && (
        <div className="px-4 py-3 border-t border-[#EAEAEA]">
          <SubHead>Skills lead actions</SubHead>
          <ul className="m-0 pl-4 list-disc text-[14px] leading-5 text-[#333333] flex flex-col gap-1 marker:text-[#B3B3B3]">
            <li>Identify the top 2 Tier 3 workflows and pair the sole runner with a second team member to shadow.</li>
            <li>Complete the shared storage checklist item in the team assessment.</li>
            <li>Schedule a walkthrough of the highest-risk workflow this sprint.</li>
            <li>Document trigger conditions for each at-risk workflow in the skill library.</li>
          </ul>
        </div>
      )}
    </Panel>
  );
}
