// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * FinOps top-spenders leaderboard — ranked list from the already-built
 * ChargebackReport.leaderboard (single-source, no new query). Zero-spend
 * users are excluded server-side, so an empty list renders a plain
 * "no spend" message rather than an empty table.
 *
 * Each name opens that person's Spend Review for the same month.
 */
import Link from 'next/link';
import { Panel, T, Muted } from '@/components/precision/ui';
import { SURFACE_COLOR, PRODUCT_COLOR } from '@/lib/ui/chart-colours';

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  totalUsd: number;
  codeUsd: number;
  coworkUsd: number;
  /** Present when the OpenAI export is connected. */
  chatgptUsd?: number;
  codexUsd?: number;
}

const fmtUsd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** Each product's share of a person's spend, in the shared product colours. */
function SplitBar({ parts }: { parts: Array<{ usd: number; colour: string }> }) {
  const total = parts.reduce((a, p) => a + p.usd, 0);
  if (total <= 0) return null;
  return (
    <div className="flex h-1.5 rounded-full overflow-hidden gap-px bg-[#F2F2F2]">
      {parts.map((p, i) => <div key={i} style={{ width: `${(p.usd / total) * 100}%`, background: p.colour }} />)}
    </div>
  );
}

/** A person's spend by product: Claude Code and Cowork, plus ChatGPT and Codex when connected. */
function productParts(u: LeaderboardEntry, openaiOnly: boolean) {
  const openai = u.chatgptUsd !== undefined;
  const parts = [
    ...(!openai || !openaiOnly ? [
      { label: openai ? 'Claude Code' : 'Code', usd: u.codeUsd, colour: SURFACE_COLOR.code },
      { label: openai ? 'Claude Cowork' : 'Cowork', usd: u.coworkUsd, colour: SURFACE_COLOR.cowork },
    ] : []),
    ...(openai ? [
      { label: 'ChatGPT', usd: u.chatgptUsd ?? 0, colour: PRODUCT_COLOR.chatgpt_chat },
      { label: 'Codex', usd: u.codexUsd ?? 0, colour: PRODUCT_COLOR.codex },
    ] : []),
  ];
  return { openai, parts };
}

export default function Leaderboard({ leaderboard, period, openaiOnly = false }: { leaderboard: LeaderboardEntry[]; period?: string; openaiOnly?: boolean }) {
  const openai = leaderboard.some(u => u.chatgptUsd !== undefined);
  return (
    <Panel
      title="Top spenders"
      right={<Link href={`/finops/spend-review${period ? `?period=${period}` : ''}`} className="text-[13px] font-medium text-[#245BF3] hover:underline">Spend Review</Link>}
      flush
    >
      {leaderboard.length === 0 ? (
        <div className="p-4"><Muted>No priced spend this month.</Muted></div>
      ) : (
        <div className="overflow-x-auto">
          <table className={T.table}>
            <thead>
              <tr className={T.headRow}>
                <th scope="col" className={T.th}><span className="sr-only">Rank</span></th>
                <th scope="col" className={T.th}>Person</th>
                <th scope="col" className={`${T.th} w-[34%] hidden sm:table-cell`}>{openai ? 'By product' : 'Code / Cowork'}</th>
                <th scope="col" className={T.thRight}>Spend</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((u, i) => {
                const { parts } = productParts(u, openaiOnly);
                const shown = openai ? parts.filter(p => p.usd > 0) : parts;
                return (
                <tr key={u.userId} className={T.row}>
                  <td className={`${T.td} w-8 text-[12px] text-[#B3B3B3] tabular-nums`}>{i + 1}</td>
                  <td className={T.td}>
                    <Link
                      href={`/finops/spend-review/${encodeURIComponent(u.userId)}${period ? `?period=${period}` : ''}`}
                      className="font-medium text-[#0A0A0A] hover:text-[#245BF3] hover:underline"
                    >
                      {u.displayName}
                    </Link>
                  </td>
                  <td className={`${T.td} hidden sm:table-cell`} title={parts.map(p => `${p.label} ${fmtUsd(p.usd)}`).join(' · ')}>
                    <SplitBar parts={parts} />
                    <span className="block mt-1 text-[12px] text-[#8F8F8F] tabular-nums">
                      {openai
                        ? shown.map(p => `${p.label} ${fmtUsd(p.usd)}`).join(' · ')
                        : `${fmtUsd(u.codeUsd)} / ${fmtUsd(u.coworkUsd)}`}
                    </span>
                  </td>
                  <td className={`${T.tdRight} font-medium`}>{fmtUsd(u.totalUsd)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
