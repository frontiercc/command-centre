// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { T, cx } from '@/components/precision/ui';
import { formatTokens, formatCurrency } from '@/components/pulse/code/CodeStatStrip';
import { useSessionRole } from '@/components/shared/useSessionRole';

export interface CodeUserRow {
  user_id: string;
  display_name: string | null;
  email: string | null;
  department: string | null;
  spend_usd: number | null;
  autonomy_ratio: number | null;
  cache_hit_ratio: number | null;
  session_count: number;
  repo_count: number;
  commit_count?: number;
  skill_leverage: number | null;
  input_tokens: number;
  output_tokens: number;
  github_repo_count?: number;
  /** Set on a colleague's row for a viewer who may not see their spend: no figure is sent. */
  spend_hidden?: boolean;
}

type SortKey = 'spend_usd' | 'autonomy_ratio' | 'session_count' | 'repo_count' | 'cache_hit_ratio' | 'commit_count' | 'github_repo_count';

/**
 * Member table. Renders the bare table (no border): place it inside a flush Panel.
 */
/** Which commits the GitHub repos column counts: every commit, or those matched to one tool (lib/pulse/code/github-tool-match.ts). */
const GITHUB_REPOS_HEADER: Record<'all' | 'claude' | 'openai', string> = {
  all: 'Repos (GitHub)',
  claude: 'Repos (GitHub, Claude Code)',
  openai: 'Repos (GitHub, Codex)',
};

export default function CodeUserTable({ users, showDepartment = true, githubBasis = 'all' }: { users: CodeUserRow[]; showDepartment?: boolean; githubBasis?: 'all' | 'claude' | 'openai' }) {
  const [sortKey, setSortKey] = useState<SortKey>('spend_usd');
  const [asc, setAsc] = useState(false);
  // Developer Pulse Users refuses viewers, so a viewer sees names without a link.
  const role = useSessionRole();
  const canOpen = role !== '' && role !== 'viewer';

  const sorted = [...users].sort((a, b) => {
    const av = a[sortKey] ?? -1;
    const bv = b[sortKey] ?? -1;
    return asc ? (av as number) - (bv as number) : (bv as number) - (av as number);
  });

  // On OTel-only instances repo attribution is never captured — every row is 0.
  // A permanently-zero column is noise; hide it rather than repurpose it.
  const showRepos = users.some(u => u.repo_count > 0);
  // GitHub repo activity only ever fills in when the session-
  // derived Repos column is hidden AND at least one member has real data —
  // avoids a redundant/noisy column when session-repo attribution IS working.
  const showGithubRepos = !showRepos && users.some(u => (u.github_repo_count ?? 0) > 0);

  const header = (label: string, key: SortKey) => {
    const active = sortKey === key;
    return (
      <th
        scope="col"
        className={T.thRight}
        aria-sort={active ? (asc ? 'ascending' : 'descending') : 'none'}
      >
        <button
          type="button"
          onClick={() => { if (sortKey === key) setAsc(a => !a); else { setSortKey(key); setAsc(false); } }}
          className={cx('font-medium hover:text-[#0A0A0A]', active && 'text-[#0A0A0A]')}
        >
          {label}{active ? (asc ? ' ↑' : ' ↓') : ''}
        </button>
      </th>
    );
  };

  return (
    <div className="overflow-x-auto">
      <table className={T.table}>
        <thead>
          <tr className={T.headRow}>
            <th scope="col" className={T.th}>User</th>
            {showDepartment && <th scope="col" className={T.th}>Department</th>}
            {header('Spend · 30d', 'spend_usd')}
            {header('Automation', 'autonomy_ratio')}
            {header('Sessions', 'session_count')}
            {header('Commits', 'commit_count')}
            {showRepos && header('Repos', 'repo_count')}
            {showGithubRepos && header(GITHUB_REPOS_HEADER[githubBasis], 'github_repo_count')}
            {header('Cache', 'cache_hit_ratio')}
            <th scope="col" className={T.thRight}>Tokens</th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr className="border-t border-[#F2F2F2]">
              <td
                colSpan={(showDepartment ? 9 : 8) - (showRepos ? 0 : 1) + (showGithubRepos ? 1 : 0)}
                className="px-4 py-6 text-center text-[13px] text-[#8F8F8F]"
              >
                No coding activity captured yet.
              </td>
            </tr>
          ) : sorted.map(u => (
            <tr key={u.user_id} className={T.row}>
              <td className={T.td}>
                {canOpen ? (
                  <Link href={`/pulse/code/users?userId=${encodeURIComponent(u.user_id)}`} className="font-medium text-[#0A0A0A] hover:text-[#1F6F8B] hover:underline">
                    {u.display_name || u.email || u.user_id}
                  </Link>
                ) : <span className="font-medium text-[#0A0A0A]">{u.display_name || u.email || u.user_id}</span>}
              </td>
              {showDepartment && <td className={T.tdMute}>{u.department ?? 'No department'}</td>}
              <td className={cx(T.tdRight, 'font-medium')}>
                {u.spend_hidden ? 'hidden' : u.spend_usd === null ? (u.input_tokens + u.output_tokens === 0 ? 'not measured' : 'not priced') : formatCurrency(u.spend_usd)}
              </td>
              <td className={T.tdRight}>
                {u.autonomy_ratio === null ? 'not measured' : `${u.autonomy_ratio.toFixed(1)}×`}
              </td>
              <td className={T.tdRight}>{u.session_count}</td>
              <td className={T.tdRight}>{u.commit_count ?? 0}</td>
              {showRepos && <td className={T.tdRight}>{u.repo_count}</td>}
              {showGithubRepos && <td className={T.tdRight}>{u.github_repo_count ?? 0}</td>}
              <td className={T.tdRight}>
                {u.cache_hit_ratio === null ? 'not measured' : `${Math.round(u.cache_hit_ratio * 100)}%`}
              </td>
              <td className={cx(T.tdRight, 'text-[#8F8F8F]')}>{formatTokens(u.input_tokens + u.output_tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
