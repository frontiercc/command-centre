// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Fragment, useEffect, useState } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { PageBody, Panel, PanelFoot, Strip, Figure, Tag, T, Empty, Notice, cx } from '@/components/precision/ui';
import {
  spendShare,
  type SubagentRegister,
  type SubagentRow,
  type SubagentSource,
  type SubagentSurface,
} from '@/lib/subagents/shared';

function money(n: number | null): string {
  if (n === null) return 'Not priced';
  if (n > 0 && n < 0.01) return 'Under $0.01';
  return `$${n.toLocaleString('en-GB', { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 })}`;
}

function pct(n: number | null): string {
  if (n === null) return 'Not measured';
  const p = n * 100;
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

function day(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "claude-opus-5-5" reads as "opus-5-5"; the full id stays in the tooltip. */
function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

const SURFACE_LABEL: Record<SubagentSurface, string> = { code: 'Claude Code', cowork: 'Cowork' };

function SourceLabel({ source, plugin }: { source: SubagentSource; plugin: string | null }) {
  if (source === 'built_in') return <span>Claude</span>;
  if (source === 'plugin') return <span>Plugin: <span className="font-mono text-[13px]">{plugin}</span></span>;
  if (source === 'own') return <span>Own definition</span>;
  return (
    <span title="The person's Claude sends 'custom' in place of the name. Names arrive once tool details are switched on in their telemetry settings.">
      Name withheld
    </span>
  );
}

function Surfaces({ surfaces }: { surfaces: SubagentSurface[] }) {
  return (
    <span className="inline-flex gap-1 whitespace-nowrap">
      {surfaces.map(s => <Tag key={s}>{SURFACE_LABEL[s]}</Tag>)}
    </span>
  );
}

function Models({ row }: { row: SubagentRow }) {
  if (row.models.length === 0) return <span className="text-[#8F8F8F]">Not captured</span>;
  const shown = row.models.slice(0, 2);
  const rest = row.models.length - shown.length;
  return (
    <span
      className="text-[13px] font-mono"
      title={row.models.map(m => `${m.model}: ${money(m.spendUsd)}`).join('\n')}
    >
      {shown.map(m => shortModel(m.model)).join(', ')}{rest > 0 && <span className="text-[#8F8F8F]"> +{rest}</span>}
    </span>
  );
}

function PeopleTable({ row }: { row: SubagentRow }) {
  return (
    <table className={T.table}>
      <thead>
        <tr className={T.headRow}>
          <th scope="col" className={T.th}>Person</th>
          <th scope="col" className={T.th}>Department</th>
          <th scope="col" className={T.th}>Used in</th>
          <th scope="col" className={T.thRight}>Sessions</th>
          <th scope="col" className={T.thRight}>Model calls</th>
          <th scope="col" className={T.thRight}>Cowork launches</th>
          <th scope="col" className={T.thRight}>Spend</th>
          <th scope="col" className={T.th}>Models</th>
        </tr>
      </thead>
      <tbody>
        {row.byPerson.map((p, i) => (
          <tr key={`${p.name}-${i}`} className={T.row}>
            <td className={T.td}>{p.name}</td>
            <td className={T.tdMute}>{p.department ?? 'No department'}</td>
            <td className={T.td}><Surfaces surfaces={p.surfaces} /></td>
            <td className={T.tdRight}>{p.sessions}</td>
            <td className={T.tdRight}>{p.calls > 0 ? p.calls.toLocaleString('en-GB') : 'None'}</td>
            <td className={T.tdRight}>{p.surfaces.includes('cowork') ? p.launches.toLocaleString('en-GB') : ''}</td>
            <td className={T.tdRight}>{money(p.spendUsd)}</td>
            <td className={cx(T.tdMute, 'font-mono text-[13px] whitespace-nowrap')} title={p.models.join('\n')}>
              {p.models.length > 0 ? p.models.map(shortModel).join(', ') : 'Not captured'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function ClaudeSubagentsPage() {
  const [data, setData] = useState<SubagentRegister | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/subagents')
      .then(async r => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error ?? "Couldn't load this page. Try again.");
        return body as SubagentRegister;
      })
      .then(setData)
      .catch(e => setError(e.message));
  }, []);

  const t = data?.totals;
  const codeShare = t ? spendShare(t.codeSubagentSpendUsd, t.codeTotalSpendUsd) : null;
  const coworkShare = t ? spendShare(t.coworkSubagentSpendUsd, t.coworkTotalSpendUsd) : null;

  return (
    <>
      <TopBar
        title="Claude Sub Agents"
        subtitle="Subagents people run in Claude Code and Cowork, who runs them, and what they cost"
      />
      <PageBody>
        {error && <Notice tone="error">{error}</Notice>}
        {!data && !error && <LoadingSpinner />}

        {data && t && (
          <>
            <Strip cols={4}>
              <Figure
                label="Subagents in use"
                value={t.subagents}
                tone="measured"
                sub={`${t.custom} custom, ${t.builtIn} built-in, last ${data.windowDays} days`}
              />
              <Figure
                label="New custom subagents"
                value={t.newCustom}
                tone="measured"
                sub={`First seen in the last ${data.newDays} days`}
              />
              <Figure
                label="Share of Claude Code spend"
                value={pct(codeShare)}
                tone="measured"
                sub={codeShare === null ? 'No priced Claude Code spend' : `${money(t.codeSubagentSpendUsd)} of ${money(t.codeTotalSpendUsd)}, last ${data.windowDays} days`}
              />
              <Figure
                label="Cowork subagent launches"
                value={t.coworkLaunches.toLocaleString('en-GB')}
                tone="measured"
                sub={coworkShare !== null
                  ? `By ${t.coworkLaunchPeople} people, ${pct(coworkShare)} of Cowork spend`
                  : `By ${t.coworkLaunchPeople} ${t.coworkLaunchPeople === 1 ? 'person' : 'people'}`}
              />
            </Strip>

            {data.rows.length === 0 ? (
              <Empty title="No subagents seen in the last 30 days">
                Subagents appear here once people run them in Claude Code or Cowork with telemetry switched on.
              </Empty>
            ) : (
              <Panel
                title="Subagents"
                subtitle={`Last ${data.windowDays} days. Select a row to see who runs it.`}
                flush
              >
                <div className="overflow-x-auto">
                  <table className={T.table}>
                    <thead>
                      <tr className={T.headRow}>
                        <th scope="col" className={T.th}>Subagent</th>
                        <th scope="col" className={T.th}>Type</th>
                        <th scope="col" className={T.th}>Source</th>
                        <th scope="col" className={T.th}>Used in</th>
                        <th scope="col" className={T.th}>Models</th>
                        <th scope="col" className={T.thRight}>People</th>
                        <th scope="col" className={T.thRight}>Sessions</th>
                        <th scope="col" className={T.thRight}>Spend</th>
                        <th scope="col" className={T.th}>First seen</th>
                        <th scope="col" className={T.th}>Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map(row => {
                        const isOpen = open === row.name;
                        return (
                          <Fragment key={row.name}>
                            <tr
                              className={cx(T.row, 'cursor-pointer')}
                              onClick={() => setOpen(isOpen ? null : row.name)}
                              aria-expanded={isOpen}
                            >
                              <td className={T.td}>
                                <button
                                  type="button"
                                  className="inline-flex items-center gap-2 text-left"
                                  onClick={e => { e.stopPropagation(); setOpen(isOpen ? null : row.name); }}
                                  aria-expanded={isOpen}
                                  aria-label={`${isOpen ? 'Hide' : 'Show'} who runs ${row.name}`}
                                >
                                  <span className="text-[#8F8F8F] w-3" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                                  <span className="font-mono text-[13px] font-medium text-[#0A0A0A] whitespace-nowrap">{row.name}</span>
                                  {row.isNew && <Tag tone="warn">New</Tag>}
                                </button>
                              </td>
                              <td className={cx(T.tdMute, 'whitespace-nowrap')}>{row.kind === 'custom' ? 'Custom' : 'Built-in'}</td>
                              <td className={cx(T.tdMute, 'whitespace-nowrap')}><SourceLabel source={row.source} plugin={row.plugin} /></td>
                              <td className={T.td}><Surfaces surfaces={row.surfaces} /></td>
                              <td className={cx(T.tdMute, 'whitespace-nowrap')}><Models row={row} /></td>
                              <td className={T.tdRight}>{row.people}</td>
                              <td className={T.tdRight}>{row.sessions}</td>
                              <td className={T.tdRight}>{money(row.spendUsd)}</td>
                              <td className={cx(T.tdMute, 'whitespace-nowrap')}>{day(row.firstSeen)}</td>
                              <td className={cx(T.tdMute, 'whitespace-nowrap')}>{day(row.lastSeen)}</td>
                            </tr>
                            {isOpen && (
                              <tr className="bg-[#FAFAFA]">
                                <td colSpan={10} className="px-4 py-3">
                                  <div className="bg-white border border-[#EAEAEA] rounded-[10px] overflow-x-auto">
                                    <PeopleTable row={row} />
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <PanelFoot>
                  Spend is measured: Claude Code at the model rates in Admin, Developer Pulse; Cowork as Claude reports it.
                  {data.unpricedModels.length > 0 && ` Not priced, so left out of spend: ${data.unpricedModels.join(', ')}.`}
                  {' '}Custom subagents first seen in the last {data.newDays} days are marked New.
                </PanelFoot>
              </Panel>
            )}
          </>
        )}
      </PageBody>
    </>
  );
}
