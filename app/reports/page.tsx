// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState, useMemo } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { PageBody, Toolbar, Panel, SubHead, Empty, T, B } from '@/components/precision/ui';
import ReportViewer from '@/components/reports/ReportViewer';
import { REPORT_SECTIONS, availableSections } from '@/lib/reports/section-catalog';
import { useCorePlatformGuard } from '@/components/shared/useCorePlatformGuard';
import { effectiveCodeHumanTime } from '@/lib/pulse/human-time';

interface Report {
  id: string;
  report_type: string;
  period_start: string;
  period_end: string;
  generated_by: string | null;
  content_md: string;
  content_summary: string | null;
  generated_at: number;
}

export default function ReportsPage() {
  useCorePlatformGuard();
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [selectedReport, setSelectedReport] = useState<Report | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [selectedSections, setSelectedSections] = useState<Set<string>>(
    new Set(REPORT_SECTIONS.filter(s => s.default).map(s => s.id))
  );
  const [periodStart, setPeriodStart] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7);
    return d.toISOString().split('T')[0];
  });
  const [periodEnd, setPeriodEnd] = useState(() => new Date().toISOString().split('T')[0]);
  const [departmentFilter, setDepartmentFilter] = useState('');

  const [users, setUsers] = useState<Array<{ id: string; department?: string | null }>>([]);
  useEffect(() => {
    // A refused request (e.g. an expired session) answers with an object, not a list.
    fetch('/api/users').then(r => r.json()).then(d => setUsers(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  // Which sections this viewer may pick. The server enforces the same rule in
  // /api/ai/report — this only keeps unusable options out of the picker. On a
  // failed fetch the flags stay false, so gated sections hide rather than
  // offering something that would generate nothing.
  const [flags, setFlags] = useState<{ chargebackEnabled?: boolean; useCasesEnabled?: boolean; gdprApplicable?: boolean; lgpdApplicable?: boolean; humanTimeEnabled?: boolean }>({});
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/config')
      .then(r => (r.ok ? r.json() : null))
      .then(cfg => {
        if (cfg) setFlags({
          chargebackEnabled: Boolean(cfg.chargebackEnabled),
          useCasesEnabled: Boolean(cfg.useCasesEnabled),
          gdprApplicable: Boolean(cfg.gdprApplicable),
          lgpdApplicable: Boolean(cfg.lgpdApplicable),
          humanTimeEnabled: String(cfg.humanTimeEnabled) === 'true' || effectiveCodeHumanTime(cfg.humanTimeCodeEnabled, cfg.humanTimeEnabled),
        });
      })
      .catch(() => {});
    fetch('/api/admin/session')
      .then(r => (r.ok ? r.json() : null))
      .then(s => { if (s?.user?.role) setRole(String(s.user.role)); })
      .catch(() => {});
  }, []);

  const visibleSections = useMemo(
    () => availableSections(flags, role === 'admin' || role === 'manager'),
    [flags, role],
  );
  const selectedVisibleIds = useMemo(
    () => visibleSections.filter(s => selectedSections.has(s.id)).map(s => s.id),
    [visibleSections, selectedSections],
  );
  const departments = useMemo(() => {
    const depts = users.map(u => u.department).filter((d): d is string => Boolean(d));
    return Array.from(new Set(depts)).sort();
  }, [users]);

  const fetchReports = () => {
    fetch('/api/ai/report')
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setReports(data); })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchReports(); }, []);

  const toggleSection = (id: string) => {
    setSelectedSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const generateReport = async () => {
    setGenerating(true);
    setShowOptions(false);
    try {
      const res = await fetch('/api/ai/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_type: 'on-demand',
          sections: selectedVisibleIds,
          period_start: periodStart,
          period_end: periodEnd,
          ...(departmentFilter ? { department: departmentFilter } : {}),
        }),
      });
      const report = await res.json();
      if (report.id) {
        setSelectedReport(report);
        fetchReports();
      }
    } catch (err) {
      console.error('Failed to generate report:', err);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <>
      <TopBar title="Reports" subtitle="Governance and compliance reports" />
      <PageBody>
        <Toolbar left={<span className="tabular-nums">{reports.length} report{reports.length !== 1 ? 's' : ''} generated</span>}>
          <button
            type="button"
            onClick={() => generating ? null : setShowOptions(!showOptions)}
            disabled={generating}
            aria-expanded={showOptions}
            className={B.accent}
          >
            {generating ? 'Generating...' : 'Generate report'}
          </button>
        </Toolbar>

        {showOptions && (
          <Panel
            title="New report"
            subtitle="Choose the period and the sections to include"
            flush
          >
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4 border-b border-[#F2F2F2]">
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium text-[#333333]">Report period</span>
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={periodStart}
                    onChange={e => setPeriodStart(e.target.value)}
                    aria-label="Period start"
                    className={`${B.input} flex-1 min-w-0`}
                  />
                  <span className="text-[13px] text-[#8F8F8F]">to</span>
                  <input
                    type="date"
                    value={periodEnd}
                    onChange={e => setPeriodEnd(e.target.value)}
                    aria-label="Period end"
                    className={`${B.input} flex-1 min-w-0`}
                  />
                </div>
              </div>

              {departments.length > 0 && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium text-[#333333]">Department</span>
                  <select
                    value={departmentFilter}
                    onChange={e => setDepartmentFilter(e.target.value)}
                    className={`${B.input} w-full`}
                  >
                    <option value="">All departments</option>
                    {departments.map(d => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            <div className="p-4">
              <SubHead
                right={
                  <span className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setSelectedSections(new Set(visibleSections.map(s => s.id)))}
                      className={B.link}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedSections(new Set(['executive_summary']))}
                      className="text-[13px] font-medium text-[#666666] hover:underline"
                    >
                      Reset
                    </button>
                  </span>
                }
              >
                Report sections
              </SubHead>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {visibleSections.map(section => {
                  const on = selectedSections.has(section.id);
                  return (
                    <button
                      key={section.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleSection(section.id)}
                      className={`text-left rounded-[10px] border px-3 py-2 flex flex-col gap-0.5 ${
                        on
                          ? 'border-[#245BF3] bg-[#F2F5FF]'
                          : 'border-[#EAEAEA] bg-white hover:border-[#DADADA]'
                      }`}
                    >
                      <span className={`text-[14px] font-medium ${on ? 'text-[#245BF3]' : 'text-[#0A0A0A]'}`}>{section.label}</span>
                      <span className="text-[13px] text-[#666666]">{section.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="px-4 py-3 border-t border-[#F2F2F2] flex items-center gap-2 flex-wrap">
              <span className="text-[13px] text-[#8F8F8F] tabular-nums">{selectedVisibleIds.length} of {visibleSections.length} sections</span>
              <div className="ml-auto flex gap-2">
                <button type="button" onClick={() => setShowOptions(false)} className={B.secondary}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={generateReport}
                  disabled={selectedSections.size === 0}
                  className={B.accent}
                >
                  Generate ({selectedVisibleIds.length} sections)
                </button>
              </div>
            </div>
          </Panel>
        )}

        {loading ? (
          <LoadingSpinner />
        ) : selectedReport ? (
          <ReportViewer report={selectedReport} onBack={() => setSelectedReport(null)} />
        ) : reports.length === 0 ? (
          <Empty title="No reports">
            No reports generated yet. Click Generate report to create your first governance report.
          </Empty>
        ) : (
          /* Reports list */
          <Panel title="Generated reports" flush>
            <div className="overflow-x-auto">
              <table className={T.table}>
                <thead>
                  <tr className={T.headRow}>
                    <th scope="col" className={T.th}>Type</th>
                    <th scope="col" className={T.th}>Period</th>
                    <th scope="col" className={T.th}>Generated</th>
                    <th scope="col" className={`${T.th} hidden md:table-cell`}>By</th>
                    <th scope="col" className={`${T.th} hidden md:table-cell`}>Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map(report => (
                    <tr
                      key={report.id}
                      onClick={() => setSelectedReport(report)}
                      className={`${T.row} cursor-pointer`}
                    >
                      <td className={`${T.td} whitespace-nowrap`}>
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); setSelectedReport(report); }}
                          className="font-medium text-[#0A0A0A] hover:underline capitalize text-left"
                        >
                          {report.report_type}
                        </button>
                      </td>
                      <td className={`${T.td} whitespace-nowrap tabular-nums`}>
                        {report.period_start} to {report.period_end}
                      </td>
                      <td className={`${T.tdMute} whitespace-nowrap tabular-nums`}>
                        {new Date(report.generated_at * 1000).toLocaleDateString('en-GB')}
                      </td>
                      <td className={`${T.tdMute} hidden md:table-cell`}>{report.generated_by || 'system'}</td>
                      <td className={`${T.tdMute} hidden md:table-cell max-w-sm truncate`}>
                        {report.content_summary || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
      </PageBody>
    </>
  );
}
