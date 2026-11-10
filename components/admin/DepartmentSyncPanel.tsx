// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Admin → Access & Keys: Department sync. Follows the single sign-on provider
 * (Microsoft Entra ID today). Turning it on writes nothing: the admin previews
 * what the directory holds, maps any names, then applies. After that,
 * departments update at sign-in and in a daily lookup of everyone. Lists the
 * exceptions an admin may want to act on: people kept manual, names waiting
 * to be mapped, and people the directory doesn't have.
 */
import { useCallback, useEffect, useState } from 'react';
import { Panel, Notice, Muted, Tag, T, B, cx } from '@/components/precision/ui';
import { ToggleRow } from '@/components/admin/precision-admin';
import { useToast } from '@/components/shared/ToastProvider';

type MatchedBy = 'map' | 'existing' | 'new';
interface NameRow { directoryName: string; department: string; matchedBy: MatchedBy; people: number }
interface Stats {
  at: number; origin: string; people: number; inDirectory: number; updated: number; unchanged: number;
  manual: number; emptyInDirectory: number; notFound: number; names: NameRow[]; newNames: string[];
  error?: { kind: 'permission' | 'failed'; message: string };
}
interface PersonRef { kind: 'user' | 'admin'; id: string; name: string; email: string | null; department: string | null }
interface Status {
  enabled: boolean;
  appliedAt: number | null;
  active: boolean;
  provider: { kind: 'entra' | 'unsupported' | 'none'; label?: string };
  map: Record<string, string>;
  lastRun: number | null;
  lastStats: Stats | null;
  manualPeople: PersonRef[];
  notFoundPeople: PersonRef[];
}

const MATCHED_LABEL: Record<MatchedBy, string> = {
  existing: 'Existing department',
  map: 'From your name map',
  new: 'New department',
};

function when(epochS: number): string {
  return new Date(epochS * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
}

/** "Found 40 of 42 people in Microsoft Entra ID; 2 not found." */
function summary(s: Stats, label: string): string {
  const parts = [`Found ${s.inDirectory.toLocaleString('en-GB')} of ${plural(s.people, 'person', 'people')} in ${label}`];
  if (s.notFound > 0) parts.push(`${s.notFound.toLocaleString('en-GB')} not found`);
  return `${parts.join('; ')}.`;
}

export default function DepartmentSyncPanel() {
  const { showToast } = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<'' | 'toggle' | 'preview' | 'apply' | 'run' | 'map' | string>('');
  const [preview, setPreview] = useState<Stats | null>(null);
  const [mapRows, setMapRows] = useState<Array<{ from: string; to: string }>>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/department-sync');
      if (!res.ok) throw new Error();
      const data = await res.json() as Status;
      setStatus(data);
      setMapRows(Object.entries(data.map).map(([from, to]) => ({ from, to })));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const saveConfig = async (values: Record<string, string>): Promise<boolean> => {
    const res = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
    return res.ok;
  };

  const post = async (body: Record<string, string>) => {
    const res = await fetch('/api/admin/department-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  };

  const toggle = async (next: boolean) => {
    setBusy('toggle');
    if (await saveConfig({ departmentSyncEnabled: next ? 'true' : 'false' })) {
      showToast(next ? 'Department sync turned on. Nothing changes until you apply the preview.' : 'Department sync turned off', 'success');
      setPreview(null);
      await load();
    } else {
      showToast('Could not save', 'error');
    }
    setBusy('');
  };

  const runPreview = async () => {
    setBusy('preview');
    const { ok, data } = await post({ action: 'preview' });
    if (ok) setPreview(data.stats as Stats); else showToast(data.error || 'Preview failed', 'error');
    setBusy('');
  };

  const apply = async (action: 'apply' | 'run') => {
    setBusy(action);
    const { ok, data } = await post({ action });
    if (ok) {
      const s = data.stats as Stats;
      showToast(s.error ? 'Applied: departments will update at sign-in' : `Done: ${plural(s.updated, 'department')} updated`, 'success');
      setPreview(null);
      await load();
    } else {
      showToast(data.error || 'Could not reach Microsoft Entra ID', 'error');
    }
    setBusy('');
  };

  const saveMap = async (rows = mapRows) => {
    setBusy('map');
    const map: Record<string, string> = {};
    for (const r of rows) if (r.from.trim() && r.to.trim()) map[r.from.trim()] = r.to.trim();
    if (await saveConfig({ departmentSyncMap: JSON.stringify(map) })) {
      showToast('Name map saved', 'success');
      await load();
      // A preview on screen is refreshed so it reflects the new map.
      if (preview) await runPreview();
    } else {
      showToast('Could not save the name map', 'error');
    }
    setBusy('');
  };

  const returnToDirectory = async (p: PersonRef) => {
    setBusy(`return:${p.id}`);
    const { ok, data } = await post({ action: 'return', kind: p.kind, id: p.id });
    if (ok) {
      showToast(`${p.name} returned to the directory. Their department updates at the next lookup or sign-in.`, 'success');
      await load();
    } else {
      showToast(data.error || 'Could not return to directory', 'error');
    }
    setBusy('');
  };

  if (loadError) {
    return <Panel title="Department sync"><Muted>Couldn&apos;t load department sync. Try reloading the page.</Muted></Panel>;
  }
  if (!status) {
    return <Panel title="Department sync"><Muted>Loading…</Muted></Panel>;
  }

  const isEntra = status.provider.kind === 'entra';
  const label = status.provider.label ?? 'Microsoft Entra ID';
  const title = isEntra ? 'Department sync · Microsoft Entra ID' : 'Department sync';
  const last = status.lastStats;

  if (!isEntra) {
    return (
      <Panel title={title}>
        <Notice tone="info">
          Department sync currently works with Microsoft Entra ID only. Set up single sign-on with Microsoft Entra ID above to use it.
        </Notice>
      </Panel>
    );
  }

  const mapEditor = (
    <div className="px-4 py-3 border-t border-[#F2F2F2] flex flex-col gap-2">
      <span className="text-[14px] font-medium text-[#0A0A0A]">Name map</span>
      <span className="text-[13px] text-[#666666] leading-5">
        Where your directory uses a different name for a department, map it here, for example &quot;Eng&quot; to &quot;Engineering&quot;. Capitals and spacing never need mapping.
      </span>
      {mapRows.length > 0 && (
        <div className="flex flex-col gap-2">
          {mapRows.map((r, i) => (
            <div key={i} className="flex items-center gap-2 flex-wrap">
              <input
                aria-label="Directory name"
                className={cx(B.input, 'w-56')}
                value={r.from}
                placeholder="Name in the directory"
                onChange={e => setMapRows(rows => rows.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))}
              />
              <span className="text-[13px] text-[#8F8F8F]">becomes</span>
              <input
                aria-label="Command Centre department"
                className={cx(B.input, 'w-56')}
                value={r.to}
                placeholder="Department in Command Centre"
                onChange={e => setMapRows(rows => rows.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))}
              />
              <button type="button" className={B.link} onClick={() => setMapRows(rows => rows.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3">
        <button type="button" className={B.secondary} onClick={() => setMapRows(rows => [...rows, { from: '', to: '' }])}>Add a mapping</button>
        <button type="button" className={B.primary} disabled={busy === 'map'} onClick={() => saveMap()}>{busy === 'map' ? 'Saving…' : 'Save name map'}</button>
      </div>
    </div>
  );

  const nameTable = (s: Stats) => (
    <table className={T.table}>
      <thead>
        <tr className={T.headRow}>
          <th className={T.th}>Name in {label}</th>
          <th className={T.th}>Department in Command Centre</th>
          <th className={T.th}>How</th>
          <th className={T.thRight}>People</th>
        </tr>
      </thead>
      <tbody>
        {s.names.map(n => (
          <tr key={n.directoryName} className={T.row}>
            <td className={T.td}>{n.directoryName}</td>
            <td className={T.td}>{n.department}</td>
            <td className={T.tdMute}>{n.matchedBy === 'new' ? <Tag tone="warn">New department</Tag> : MATCHED_LABEL[n.matchedBy]}</td>
            <td className={T.tdRight}>{n.people.toLocaleString('en-GB')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const errorNotice = (s: Stats) => s.error && (
    <Notice tone={s.error.kind === 'permission' ? 'warn' : 'error'}>
      {s.error.kind === 'permission'
        ? <>The daily lookup can&apos;t read the directory: {s.error.message}. It needs the application permission <strong>User.Read.All</strong>, with admin consent, on your app registration. Until then, departments update only when people sign in.</>
        : s.error.message}
    </Notice>
  );

  return (
    <Panel title={title} flush>
      <p className="m-0 px-4 pt-3 text-[13px] text-[#666666] leading-5">
        Keeps each person&apos;s department in step with {label}: when they sign in with Microsoft, and in a daily lookup of everyone Command Centre knows, including people who never sign in. Only departments change; roles and access never do. A department an admin sets by hand is kept, and an empty value in the directory never removes one.
      </p>
      <ToggleRow
        first
        label="Automatically synchronise departments from SSO"
        hint={<>Needs <strong>User.Read</strong> (delegated) for sign-in and <strong>User.Read.All</strong> (application, with admin consent) for the daily lookup, on the app registration used for single sign-on.</>}
        checked={status.enabled}
        disabled={busy === 'toggle'}
        onChange={toggle}
      />

      {status.enabled && !status.appliedAt && (
        <div className="px-4 py-3 border-t border-[#F2F2F2] flex flex-col gap-3">
          <Notice tone="info" title="Nothing has changed yet.">
            Preview the departments in {label} and where each one lands. Map any names that should join an existing department, then select Apply.
          </Notice>
          <div className="flex items-center gap-3 flex-wrap">
            <button type="button" className={B.secondary} disabled={busy === 'preview'} onClick={runPreview}>{busy === 'preview' ? 'Reading the directory…' : 'Preview'}</button>
            {preview && (
              <button type="button" className={B.primary} disabled={busy === 'apply'} onClick={() => apply('apply')}>
                {busy === 'apply' ? 'Applying…' : 'Apply'}
              </button>
            )}
          </div>
          {preview && (
            <div className="flex flex-col gap-2">
              {errorNotice(preview)}
              {!preview.error && (
                <>
                  <span className="text-[13px] text-[#4D4D4D]">
                    {summary(preview, label)} Applying would update {plural(preview.updated, 'department')}{preview.manual > 0 ? `, keep ${plural(preview.manual, 'hand-set department')}` : ''}{preview.emptyInDirectory > 0 ? `, and leave ${plural(preview.emptyInDirectory, 'person', 'people')} whose directory department is empty` : ''}.
                  </span>
                  {preview.names.length > 0 ? <div className="border border-[#EAEAEA] rounded-[10px] overflow-hidden">{nameTable(preview)}</div> : <Muted>No departments found in the directory for the people Command Centre knows.</Muted>}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {status.active && (
        <div className="px-4 py-3 border-t border-[#F2F2F2] flex flex-col gap-2">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[14px] font-medium text-[#0A0A0A]">Daily lookup</span>
            <button type="button" className={B.secondary} disabled={busy === 'run'} onClick={() => apply('run')}>{busy === 'run' ? 'Running…' : 'Run now'}</button>
          </div>
          {last ? (
            <>
              <span className="text-[13px] text-[#4D4D4D]">
                Last run {when(last.at)}: {plural(last.updated, 'department')} updated, {last.unchanged.toLocaleString('en-GB')} unchanged{last.manual > 0 ? `, ${last.manual.toLocaleString('en-GB')} kept manual` : ''}{last.notFound > 0 ? `, ${last.notFound.toLocaleString('en-GB')} not found` : ''}.
              </span>
              {errorNotice(last)}
            </>
          ) : <Muted>Not run yet.</Muted>}
        </div>
      )}

      {status.enabled && mapEditor}

      {status.active && (
        <div className="px-4 py-3 border-t border-[#F2F2F2] flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-[14px] font-medium text-[#0A0A0A]">Names waiting to be mapped</span>
            {(last?.newNames.length ?? 0) > 0 ? (
              <>
                <span className="text-[13px] text-[#666666]">These names from {label} became new departments. Map one to an existing department to merge it.</span>
                <div className="flex flex-wrap gap-2">
                  {last!.newNames.map(n => (
                    <button
                      key={n}
                      type="button"
                      className={B.secondary}
                      onClick={() => setMapRows(rows => (rows.some(r => r.from.toLowerCase() === n.toLowerCase()) ? rows : [...rows, { from: n, to: '' }]))}
                    >
                      Map {n}
                    </button>
                  ))}
                </div>
              </>
            ) : <Muted>None.</Muted>}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[14px] font-medium text-[#0A0A0A]">Kept manual</span>
            {status.manualPeople.length > 0 ? (
              <table className={T.table}>
                <tbody>
                  {status.manualPeople.map(p => (
                    <tr key={`${p.kind}:${p.id}`} className={T.row}>
                      <td className={T.td}>{p.name}</td>
                      <td className={T.tdMute}>{p.department || 'No department'}</td>
                      <td className={T.tdRight}>
                        <button type="button" className={B.link} disabled={busy === `return:${p.id}`} onClick={() => returnToDirectory(p)}>Return to directory</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Muted>None. Editing a department by hand keeps it here until it is returned to the directory.</Muted>}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[14px] font-medium text-[#0A0A0A]">Not found in {label}</span>
            {status.notFoundPeople.length > 0 ? (
              <>
                <span className="text-[13px] text-[#666666]">
                  No directory entry matches their email, for example contractors or people using another address. Their department stays as it is.
                  {last && last.notFound > status.notFoundPeople.length ? ` Showing ${status.notFoundPeople.length} of ${last.notFound.toLocaleString('en-GB')}.` : ''}
                </span>
                <ul className="m-0 pl-4 text-[13px] text-[#4D4D4D] columns-1 md:columns-2">
                  {status.notFoundPeople.map(p => <li key={`${p.kind}:${p.id}`}>{p.name}{p.department ? ` · ${p.department}` : ''}</li>)}
                </ul>
              </>
            ) : <Muted>None.</Muted>}
          </div>
        </div>
      )}
    </Panel>
  );
}
