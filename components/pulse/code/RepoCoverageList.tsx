// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Panel, BarRow, SubHead, Muted } from '@/components/precision/ui';
import { formatTokens } from '@/components/pulse/code/CodeStatStrip';

export interface ActiveRepo {
  repo: string;
  sessions: number;
  tokens: number;
  commits?: number;
}

export interface DarkRepo {
  repo: string;
  last_seen: number;
}

export default function RepoCoverageList({ active, dark, githubTotals }: { active: ActiveRepo[]; dark?: DarkRepo[]; githubTotals?: Record<string, number> }) {
  const max = active[0]?.sessions ?? 1;
  return (
    <Panel title="Repo coverage" subtitle="30 days" flush>
      {active.length === 0 ? (
        <div className="p-4"><Muted>No repository activity captured yet.</Muted></div>
      ) : (
        <div className="py-1">
          {active.map((r, i) => (
            <BarRow
              key={r.repo}
              rank={i + 1}
              label={r.repo}
              title={r.repo}
              pct={Math.round((r.sessions / max) * 100)}
              tone="measured"
              value={
                <>
                  {r.sessions} session{r.sessions === 1 ? '' : 's'}
                  {(r.commits ?? 0) > 0 && (
                    <span className="text-[#1A7F37] font-medium">
                      {' · '}
                      {githubTotals?.[r.repo] !== undefined
                        // Not "X of Y": session commits count any branch, GitHub counts the default
                        // branch only, so the first can exceed the second.
                        ? `${r.commits} AI-assisted commits · ${githubTotals[r.repo]} on GitHub`
                        : `${r.commits} commit${r.commits === 1 ? '' : 's'}`}
                    </span>
                  )}
                  {' · '}{formatTokens(r.tokens ?? 0)} tokens
                </>
              }
            />
          ))}
        </div>
      )}
      {dark && dark.length > 0 && (
        <div className="px-4 pt-3 pb-3.5 border-t border-[#F2F2F2]">
          <SubHead>Gone quiet: no activity in 30 days</SubHead>
          <div className="flex flex-wrap gap-1.5">
            {dark.map(r => (
              <span key={r.repo} className="font-mono text-[12px] leading-4 px-1.5 rounded-[6px] border border-[#EAEAEA] text-[#4D4D4D]">
                {r.repo}
              </span>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
