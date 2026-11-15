// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * "Work only one person does": the kinds of work, and the skills, that exactly one person in the
 * department has used, so a manager can pair someone with them. Plain statements written here from the figures, one chart colour, amber only where it is
 * a risk. Nothing is judged here beyond the tiers the classifier already set.
 */
import { Frame } from '@/components/pulse/WorkPulseOverview';
import type { TierNames } from '@/lib/pulse/tier-names';

interface ConcentrationRiskEntry {
  user_id: string;
  display_name: string | null;
  sole_workflows: number;
}

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
  names?: TierNames;
}

const AMBER = '#B54708';
// The route sends each kind already worded (kindLabel), as Team Coaching words it.
const kindWords = (ts: string[]) => ts.join(', ');

export default function ConcentrationRisk({ risks, detail, skillConcentration }: ConcentrationRiskProps) {
  const byUser = new Map((detail ?? []).map(d => [d.user_id, d]));
  const soleSkills = (skillConcentration ?? []).filter(s => s.skills.length > 0);
  const people = risks.length;
  const answer = people === 0 && soleSkills.length === 0
    ? <>Nothing: every kind of work and every skill here is used by more than one person.</>
    : people === 0
      ? <><b>{soleSkills.length === 1 ? 'One person is' : `${soleSkills.length} people are`}</b> the only user of a skill. No kind of work is down to one person.</>
      : <><b>{people === 1 ? 'One person is' : `${people} people are`}</b> the only one here doing a kind of work. If they left, it would stop.</>;
  return (
    <Frame
      title="Work only one person does"
      judged
      period="Last 30 days"
      answer={answer}
      note="Counts the kinds of work done often enough to matter, at any depth, and the skills, that exactly one person here has used: the same rule as Team Coaching."
    >
      {risks.map(r => {
        const d = byUser.get(r.user_id);
        return (
          <div key={r.user_id} className="py-1.5 border-b border-[#F2F2F2] last:border-b-0">
            <p className="m-0 flex items-baseline gap-2 text-[13px]">
              <span className="font-semibold text-[#0A0A0A] truncate">{r.display_name ?? r.user_id}</span>
              <span className="ml-auto tabular-nums shrink-0" style={{ color: AMBER }}>
                {r.sole_workflows} {r.sole_workflows === 1 ? 'kind of work' : 'kinds of work'}
              </span>
            </p>
            {d && d.task_types.length > 0 && (
              <p className="m-0 mt-0.5 text-[12px] text-[#777777] line-clamp-1">{kindWords(d.task_types)}</p>
            )}
          </div>
        );
      })}
      {soleSkills.length > 0 && (
        <div className="mt-3 pt-2 border-t border-[#EAEAEA]">
          <div className="text-[12px] font-semibold text-[#333333] mb-0.5">Skills only one person uses</div>
          {soleSkills.map(s => (
            <p key={s.user_id} className="m-0 flex items-baseline gap-2 py-1 text-[13px]">
              <span className="text-[#0A0A0A] truncate">{s.display_name ?? s.user_id}</span>
              <span className="ml-auto text-[#777777] truncate">{s.skills.join(', ')}</span>
            </p>
          ))}
        </div>
      )}
    </Frame>
  );
}
