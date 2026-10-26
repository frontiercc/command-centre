// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState, useCallback } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import type { FileUploadRow } from '@/app/api/admin/files/route';
import FileCategoryMixCard, { type FileCategoryMixItem } from '@/components/pulse/FileCategoryMixCard';
import { PageBody, Toolbar, Panel, Segmented, Tag, T, B, Empty, Notice, cx } from '@/components/precision/ui';

const DAY_OPTIONS = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
  { label: 'All time', value: 3650 },
];

function formatDate(ts: number) {
  return new Date(ts * 1000).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** File-type icon, shown beside the extension tag. */
function fileIcon(ext: string) {
  if (['pdf'].includes(ext)) return '📄';
  if (['doc', 'docx'].includes(ext)) return '📝';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return '🖼️';
  if (['md', 'txt'].includes(ext)) return '📃';
  if (['zip', 'tar', 'gz'].includes(ext)) return '🗜️';
  if (['js', 'ts', 'py', 'go', 'rs', 'java'].includes(ext)) return '💻';
  return '📎';
}

/** The file's extension, shown as a mono tag. */
function fileExt(filename: string) {
  if (!filename.includes('.')) return '';
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

export default function AdminFilesPage() {
  const [files, setFiles] = useState<FileUploadRow[]>([]);
  const [categoryMix, setCategoryMix] = useState<FileCategoryMixItem[]>([]);
  const [depts, setDepts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [days, setDays] = useState(30);
  const [deptFilter, setDeptFilter] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ days: String(days) });
    if (deptFilter) params.set('dept', deptFilter);
    if (search) params.set('search', search);
    fetch(`/api/admin/files?${params}`)
      .then(r => { if (!r.ok) throw new Error('load failed'); return r.json(); })
      .then(d => { setFiles(d.files ?? []); setDepts(d.depts ?? []); setCategoryMix(d.fileCategoryMix ?? []); })
      .catch(() => setError("Couldn't load this page. Try again."))
      .finally(() => setLoading(false));
  }, [days, deptFilter, search]);

  useEffect(() => { load(); }, [load]);

  // Group by date for display
  const grouped = files.reduce<Record<string, FileUploadRow[]>>((acc, row) => {
    const day = new Date(row.started_at * 1000).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
    (acc[day] ??= []).push(row);
    return acc;
  }, {});

  return (
    <>
      <TopBar
        title="File Uploads"
        subtitle="Files attached to Claude Cowork sessions across the org"
      />
      <PageBody className="max-w-[1000px]">

        {/* Filters */}
        <Toolbar left={loading ? '…' : `${files.length} file${files.length === 1 ? '' : 's'}`}>
          {/* Date range */}
          <Segmented
            label="Date range"
            options={DAY_OPTIONS}
            value={days}
            onChange={setDays}
          />

          {/* Department filter */}
          {depts.length > 0 && (
            <select
              value={deptFilter}
              onChange={e => setDeptFilter(e.target.value)}
              aria-label="Department"
              className={B.select}
            >
              <option value="">All departments</option>
              {depts.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          )}

          {/* Filename search */}
          <form
            onSubmit={e => { e.preventDefault(); setSearch(searchInput.trim()); }}
            className="flex items-center gap-2"
            role="search"
          >
            <input
              type="text"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search filename…"
              aria-label="Search filename"
              className={cx(B.input, 'w-48')}
            />
            {search && (
              <button
                type="button"
                onClick={() => { setSearch(''); setSearchInput(''); }}
                className={B.link}
              >
                Clear
              </button>
            )}
          </form>
        </Toolbar>

        {/* Files by category. Org-wide over the selected day range, so it is HIDDEN while a department filter is
            applied: showing an org mix above a filtered list would read as the
            filtered figure. */}
        {!deptFilter && categoryMix.length > 0 && (
          <div className="max-w-md">
            <FileCategoryMixCard items={categoryMix} />
          </div>
        )}

        {loading && <LoadingSpinner />}

        {error && (
          <Notice tone="error">{error}</Notice>
        )}

        {!loading && !error && files.length === 0 && (
          <Empty title="No file uploads found" icon="📎">
            Files appear here when users attach documents to Cowork sessions via OTel.
          </Empty>
        )}

        {!loading && !error && files.length > 0 && (
          <div className="flex flex-col gap-4">
            {Object.entries(grouped).map(([day, rows]) => (
              <Panel key={day} title={day} flush>
                <div className="overflow-x-auto">
                  <table className={T.table}>
                    <thead>
                      <tr className={T.headRow}>
                        <th scope="col" className={cx(T.th, 'w-14')}>Type</th>
                        <th scope="col" className={T.th}>Filename</th>
                        <th scope="col" className={T.th}>User</th>
                        <th scope="col" className={T.th}>Department</th>
                        <th scope="col" className={T.th}>Project</th>
                        <th scope="col" className={T.th}>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => {
                        const ext = fileExt(row.filename);
                        return (
                          <tr
                            key={`${row.session_id}-${row.filename}-${i}`}
                            className={T.row}
                          >
                            <td className={T.td}>
                              <span className="inline-flex items-center gap-1.5">
                                <span className="text-[16px] leading-none" aria-hidden="true">{fileIcon(ext)}</span>
                                {ext ? <Tag>{ext}</Tag> : <span className="text-[#B3B3B3]">—</span>}
                              </span>
                            </td>
                            <td className={T.td}>
                              <span className="font-medium text-[#0A0A0A] font-mono text-[13px] break-all">{row.filename}</span>
                            </td>
                            <td className={T.tdMute}>
                              {row.display_name ?? row.email ?? row.user_id}
                            </td>
                            <td className={T.tdMute}>
                              {row.department ?? <span className="text-[#B3B3B3]">—</span>}
                            </td>
                            <td className={cx(T.tdMute, 'text-[13px] max-w-[160px] truncate')}>
                              {row.project_name ?? <span className="text-[#B3B3B3]">—</span>}
                            </td>
                            <td className={cx(T.tdMute, 'text-[13px] whitespace-nowrap tabular-nums')}>
                              {formatDate(row.started_at)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Panel>
            ))}
          </div>
        )}

      </PageBody>
    </>
  );
}
