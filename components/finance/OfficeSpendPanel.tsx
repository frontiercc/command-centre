// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Claude in Office and Claude in Google spend: an estimate, beside the
 * by-surface strip and never in its totals. Both send tokens but no cost, so each app's spend is its
 * tokens priced from the model rates on Admin → Developer Pulse
 * (lib/finance/office-spend.ts), the same figures as the Work Pulse By product
 * panel and Spend Review. On FinOps it always shows (every app, at zero before
 * Office activity arrives); on Spend Review only for someone who used Office.
 * Also used per person on Spend Review (scope="person").
 */
import { Fragment } from 'react';
import { Panel, PanelFoot, Dot, T } from '@/components/precision/ui';
import { WORK_PRODUCT_COLOR } from '@/lib/ui/chart-colours';
import { FAMILY_LABEL, PRODUCT_FAMILY, PRODUCT_LABEL, type WorkProduct } from '@/lib/pulse/cowork/products';

interface Tokens { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }

export interface OfficeSpendLine {
  usd: number | null;
  tokens: Tokens;
  calls: number;
  unpricedModels: string[];
  people?: number;
}

export interface OfficeSpendData {
  byProduct: Array<OfficeSpendLine & { product: Exclude<WorkProduct, 'cowork'> }>;
  total: OfficeSpendLine;
  /** False before any Office or Google activity (FinOps lists every app at zero then). */
  hasOffice?: boolean;
  /** Which groups had activity; a group with none gets a set-up line. */
  seen?: { office: boolean; google: boolean };
}

const fmtUsd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmtTokensCompact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B`
  : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
  : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K`
  : String(n);

const tokensTotal = (t: Tokens) => t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens;

function Spend({ usd, calls }: { usd: number | null; calls: number }) {
  if (calls === 0) return <span className="text-[#8F8F8F]" title="No activity">—</span>;
  if (usd === null) return <span className="text-[#8F8F8F]" title="No rate for this model in Admin → Developer Pulse">—</span>;
  return <>≈{fmtUsd(usd)}</>;
}

export default function OfficeSpendPanel({ data, scope = 'organisation' }: { data: OfficeSpendData | null | undefined; scope?: 'organisation' | 'person' }) {
  if (!data || data.byProduct.length === 0) return null;
  const showPeople = scope === 'organisation';
  // App users: a person counts once for each app they used, so the column adds up.
  const appUsers = data.byProduct.reduce((n, r) => n + (r.people ?? 0), 0);
  const groups = (['office', 'google'] as const)
    .map(f => ({ family: f, rows: data.byProduct.filter(r => PRODUCT_FAMILY[r.product] === f) }))
    .filter(g => g.rows.length > 0);
  const seen = data.seen ?? { office: true, google: true };
  const title = groups.length === 1 ? `${FAMILY_LABEL[groups[0].family]} (estimate)` : 'Claude in Office and Google (estimate)';
  return (
    <Panel
      title={title}
      subtitle={scope === 'person' ? 'This month' : 'This month, not included in the totals above'}
      flush
    >
      <div className="overflow-x-auto">
        <table className={`${T.table} min-w-[480px]`}>
          <thead>
            <tr className={T.headRow}>
              <th scope="col" className={T.th}>App</th>
              {showPeople && <th scope="col" className={T.thRight}>App users</th>}
              <th scope="col" className={T.thRight}>Model calls</th>
              <th scope="col" className={T.thRight}>Tokens</th>
              <th scope="col" className={T.thRight}>Spend (estimate)</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(g => (
              <Fragment key={g.family}>
              <tr className={T.row}>
                <td colSpan={showPeople ? 5 : 4} className={`${T.td} pt-3 pb-1 text-[12px] font-medium uppercase tracking-wide text-[#666666]`}>
                  {FAMILY_LABEL[g.family]}
                </td>
              </tr>
              {g.rows.map(r => (
              <tr key={r.product} className={T.row}>
                <td className={T.td} style={{ paddingLeft: 32 }}><Dot color={WORK_PRODUCT_COLOR[r.product]}>{PRODUCT_LABEL[r.product]}</Dot></td>
                {showPeople && <td className={T.tdRight}>{(r.people ?? 0).toLocaleString('en-GB')}</td>}
                <td className={T.tdRight}>{r.calls.toLocaleString('en-GB')}</td>
                <td className={T.tdRight}>{fmtTokensCompact(tokensTotal(r.tokens))}</td>
                <td className={T.tdRight}><Spend usd={r.usd} calls={r.calls} /></td>
              </tr>
              ))}
              </Fragment>
            ))}
            {data.byProduct.length > 1 && (
              <tr className={`${T.row} border-t border-[#EAEAEA] font-medium`}>
                <td className={T.td}>All apps</td>
                {showPeople && <td className={T.tdRight}>{appUsers.toLocaleString('en-GB')}</td>}
                <td className={T.tdRight}>{data.total.calls.toLocaleString('en-GB')}</td>
                <td className={T.tdRight}>{fmtTokensCompact(tokensTotal(data.total.tokens))}</td>
                <td className={T.tdRight}><Spend usd={data.total.usd} calls={data.total.calls} /></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {scope === 'organisation' && !seen.office && (
        <p className="m-0 px-4 py-2.5 border-t border-[#F2F2F2] text-[13px] text-[#666666]">
          No Claude in Office activity yet. It appears here once Office monitoring is set up in the Claude admin console
          (Organisation settings → Office agents) and people use Claude in Excel, Word, PowerPoint or Outlook.
        </p>
      )}
      {scope === 'organisation' && !seen.google && (
        <p className="m-0 px-4 py-2.5 border-t border-[#F2F2F2] text-[13px] text-[#666666]">
          No Claude in Google activity yet. It appears here once people use Claude in Google Sheets, Docs or Slides, which
          reports through the same Office agents monitoring settings in the Claude admin console.
        </p>
      )}
      <PanelFoot>
        Office and Google send tokens but no cost, so this is the tokens priced from the model rates on Admin → Developer Pulse. It is an
        estimate, for visibility, not billing, and is never added to Cowork&apos;s reported spend, the totals or the cost centres.
        {showPeople && ' App users counts a person once for each app they used.'}
        {data.total.unpricedModels.length > 0 && ` Not priced, so left out: ${data.total.unpricedModels.join(', ')}. Add a rate to include it.`}
      </PanelFoot>
    </Panel>
  );
}
