// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState, useCallback } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { useToast } from '@/components/shared/ToastProvider';
import { PageBody, Panel, T, B, Empty, Notice, Muted, cx } from '@/components/precision/ui';
import { Field } from '@/components/admin/precision-admin';

interface CostCentre {
  id: number;
  name: string;
  code: string | null;
}

interface DeptMap {
  department: string;
  costCentreId: number;
}

interface CostCentresData {
  centres: CostCentre[];
  map: DeptMap[];
  departments: string[];
}

export default function CostCentresAdminPage() {
  const [loading, setLoading] = useState(true);
  const [notEnabled, setNotEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CostCentresData | null>(null);
  const [newName, setNewName] = useState('');
  const [newCode, setNewCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const { showToast } = useToast();

  const load = useCallback(() => {
    return fetch('/api/finance/cost-centres')
      .then(r => {
        if (r.status === 404) {
          setNotEnabled(true);
          throw new Error('not enabled');
        }
        if (!r.ok) throw new Error('load failed');
        return r.json();
      })
      .then((d: CostCentresData) => setData(d))
      .catch(e => { if (e.message !== 'not enabled') setError("Couldn't load this page. Try again."); });
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const res = await fetch('/api/finance/cost-centres', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'createCentre', name, code: newCode.trim() || undefined }),
      });
      if (res.status === 409) {
        showToast('A cost centre with that name already exists', 'error');
      } else if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        showToast(d.error || 'Failed to create cost centre', 'error');
      } else {
        showToast('Cost centre created', 'success');
        setNewName('');
        setNewCode('');
        await load();
      }
    } catch {
      showToast('Failed to create cost centre', 'error');
    } finally {
      setCreating(false);
    }
  };

  const startRename = (centre: CostCentre) => {
    setRenamingId(centre.id);
    setRenameValue(centre.name);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };

  const handleRename = async (centre: CostCentre) => {
    if (renaming) return;
    const name = renameValue.trim();
    if (!name) return;
    setRenaming(true);
    try {
      // GOTCHA: renameCentre overwrites `code` from the request body — round-trip
      // the centre's existing code here or the GL code is silently nulled.
      const res = await fetch('/api/finance/cost-centres', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'renameCentre', id: centre.id, name, code: centre.code ?? undefined }),
      });
      if (res.status === 409) {
        showToast('A cost centre with that name already exists', 'error');
      } else if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        showToast(d.error || 'Failed to rename cost centre', 'error');
      } else {
        showToast('Cost centre renamed', 'success');
        setRenamingId(null);
        setRenameValue('');
        await load();
      }
    } catch {
      showToast('Failed to rename cost centre', 'error');
    } finally {
      setRenaming(false);
    }
  };

  const handleDelete = async (centre: CostCentre) => {
    if (!window.confirm(`Delete cost centre "${centre.name}"? Any departments mapped to it will become unmapped.`)) {
      return;
    }
    try {
      const res = await fetch('/api/finance/cost-centres', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deleteCentre', id: centre.id }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        showToast(d.error || 'Failed to delete cost centre', 'error');
      } else {
        showToast('Cost centre deleted', 'success');
        await load();
      }
    } catch {
      showToast('Failed to delete cost centre', 'error');
    }
  };

  const handleMapChange = async (department: string, value: string) => {
    try {
      const res = value === ''
        ? await fetch('/api/finance/cost-centres', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'unmapDept', department }),
          })
        : await fetch('/api/finance/cost-centres', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'mapDept', department, costCentreId: Number(value) }),
          });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        showToast(d.error || 'Failed to update mapping', 'error');
      } else {
        showToast('Mapping updated', 'success');
        await load();
      }
    } catch {
      showToast('Failed to update mapping', 'error');
    }
  };


  if (loading) return (
    <>
      <TopBar title="Cost Centres" subtitle="Map departments to finance cost centres for chargeback" />
      <LoadingSpinner />
    </>
  );

  if (notEnabled) return (
    <>
      <TopBar title="Cost Centres" subtitle="Map departments to finance cost centres for chargeback" />
      <PageBody className="max-w-[720px]">
        <Empty title="FinOps is not enabled on this instance">
          Enable FinOps to map departments to cost centres.
        </Empty>
      </PageBody>
    </>
  );

  if (error) return (
    <>
      <TopBar title="Cost Centres" subtitle="Map departments to finance cost centres for chargeback" />
      <PageBody>
        <Notice tone="error">{error}</Notice>
      </PageBody>
    </>
  );

  const centres = data?.centres ?? [];
  const departments = data?.departments ?? [];
  const map = data?.map ?? [];

  return (
    <>
      <TopBar title="Cost Centres" subtitle="Map departments to finance cost centres for chargeback" />
      <PageBody className="max-w-[1000px]">

        <p className="m-0 text-[14px] text-[#666666]">
          Unmapped departments are billed under their own name. Group several departments by pointing them at one centre.
        </p>

        {/* Section 1: Cost centres */}
        <Panel title="Cost centres" flush>
          {centres.length === 0 && (
            <div className="px-4 py-3"><Muted>No cost centres yet.</Muted></div>
          )}
          {centres.length > 0 && (
            <ul className="m-0 p-0 list-none">
              {centres.map(centre => (
                <li key={centre.id} className="flex items-center gap-3 flex-wrap px-4 py-2.5 border-t border-[#F2F2F2] first:border-t-0">
                  {renamingId === centre.id ? (
                    <div className="flex-1 flex items-center gap-2 flex-wrap min-w-0">
                      <input
                        type="text"
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleRename(centre);
                          if (e.key === 'Escape') cancelRename();
                        }}
                        autoFocus
                        aria-label="New cost centre name"
                        className={cx(B.input, 'flex-1 min-w-[160px]')}
                      />
                      <GlCode code={centre.code} />
                      <button
                        type="button"
                        onClick={() => handleRename(centre)}
                        disabled={renaming || !renameValue.trim()}
                        className={B.primary}
                      >
                        {renaming ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        onClick={cancelRename}
                        disabled={renaming}
                        className={B.secondary}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex-1 min-w-0 flex items-center gap-2">
                        <span className="text-[14px] font-medium text-[#0A0A0A] truncate">{centre.name}</span>
                        <GlCode code={centre.code} />
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => startRename(centre)}
                          className={B.secondary}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(centre)}
                          className={B.danger}
                        >
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="px-4 py-3.5 border-t border-[#EAEAEA] flex flex-col md:flex-row gap-3 md:items-end">
            <Field label="Name" className="flex-1">
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. Engineering"
                className={cx(B.input, 'w-full')}
              />
            </Field>
            <Field label="GL code (optional)" className="md:w-48">
              <input
                type="text"
                value={newCode}
                onChange={e => setNewCode(e.target.value)}
                placeholder="e.g. GL-1000"
                className={cx(B.input, 'w-full font-mono')}
              />
            </Field>
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              className={B.primary}
            >
              {creating ? 'Adding…' : 'Add centre'}
            </button>
          </div>
        </Panel>

        {/* Section 2: Department mapping */}
        <Panel title="Department mapping" flush>
          {departments.length === 0 && (
            <div className="px-4 py-3"><Muted>No departments detected yet.</Muted></div>
          )}
          {departments.length > 0 && (
            <div className="overflow-x-auto">
              <table className={T.table}>
                <thead>
                  <tr className={T.headRow}>
                    <th scope="col" className={T.th}>Department</th>
                    <th scope="col" className={T.th}>Cost centre</th>
                  </tr>
                </thead>
                <tbody>
                  {departments.map(dept => {
                    const mapped = map.find(m => m.department === dept);
                    return (
                      <tr key={dept} className={T.row}>
                        <td className={cx(T.td, 'font-medium text-[#0A0A0A]')}>{dept}</td>
                        <td className={T.td}>
                          <select
                            value={mapped ? String(mapped.costCentreId) : ''}
                            onChange={e => handleMapChange(dept, e.target.value)}
                            aria-label={`Cost centre for ${dept}`}
                            className={cx(B.select, 'w-full max-w-xs')}
                          >
                            <option value="">Unmapped</option>
                            {centres.map(centre => (
                              <option key={centre.id} value={centre.id}>
                                {centre.name}{centre.code ? ` (${centre.code})` : ''}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

      </PageBody>
    </>
  );
}

/** GL code as a mono tag. Kept local (not the kit's Tag) because Tag
 *  uppercases its text, and a GL code must render exactly as stored. */
function GlCode({ code }: { code: string | null }) {
  if (!code) return <span className="text-[13px] text-[#8F8F8F]">no code</span>;
  return (
    <span className="inline-flex items-center font-mono text-[11px] leading-4 px-1.5 rounded-[6px] border border-[#EAEAEA] text-[#4D4D4D] whitespace-nowrap">
      {code}
    </span>
  );
}
