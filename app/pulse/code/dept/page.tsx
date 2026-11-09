// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import CodeStatStrip, { type CodeMetricsRow } from '@/components/pulse/code/CodeStatStrip';
import CodeUserTable, { type CodeUserRow } from '@/components/pulse/code/CodeUserTable';
import JourneyGrid from '@/components/pulse/JourneyGrid';
import HumanTimeCard, { type HumanTimeSummary } from '@/components/pulse/HumanTimeCard';
import { PageBody, Toolbar, Panel, Tag, Notice, Empty, B, cx } from '@/components/precision/ui';
import { useVendor, useOpenAiOnly, VendorSwitch } from '@/components/shared/VendorSwitch';
import { DEVELOPER_PULSE_VENDOR_LABELS } from '@/lib/dashboard/vendor';

interface DeptListRow {
  department: string;
  member_count: number;
}

interface DeptDetail {
  codexPresent?: boolean;
  metricsSplit?: { claude: CodeMetricsRow | null; openai: CodeMetricsRow | null } | null;
  humanTime?: HumanTimeSummary | null;
  dept: string;
  metrics: CodeMetricsRow | null;
  members: CodeUserRow[];
  journeyGrid: Array<{ week: number; tier: number; count: number; provisionalCount?: number }>;
  githubRepos: { count7d: number; names7d: string[]; basis?: 'all' | 'claude' | 'openai' } | null;
}

function DeptContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [depts, setDepts] = useState<DeptListRow[]>([]);
  const [deptsLoading, setDeptsLoading] = useState(true);
  const [detail, setDetail] = useState<DeptDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vendor, setVendor, vendorReady] = useVendor();
  const [codexPresent, setCodexPresent] = useState(false);
  const openaiOnly = useOpenAiOnly();
  const codexView = codexPresent || openaiOnly;

  const selectedDept = searchParams.get('dept') ?? '';
  // What the switch's view covers, for the empty states.
  const viewLabel = vendor === 'openai' ? 'Codex' : codexView && vendor === 'all' ? 'coding' : 'Claude Code';
  // A department missing from the picker has no activity in this view; its
  // page is not shown, so no figure from another view stands under the name.
  const notInView = !deptsLoading && selectedDept !== '' && !depts.some(d => d.department === selectedDept);

  // Load the department list for the dropdown
  useEffect(() => {
    if (!vendorReady) return; // the saved view is read after the page loads
    fetch(`/api/pulse/code/depts?vendor=${vendor}`)
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.message || d.error || "Couldn't load this page. Try again.");
        return d;
      })
      .then(d => {
        setCodexPresent(!!d.codexPresent);
        const list: DeptListRow[] = d.depts ?? [];
        setDepts(list);
        if (!searchParams.get('dept') && list.length > 0) {
          const params = new URLSearchParams(searchParams.toString());
          params.set('dept', list[0].department);
          router.replace(`/pulse/code/dept?${params.toString()}`);
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setDeptsLoading(false));
  }, [vendor, vendorReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDept = useCallback((dept: string) => {
    if (!vendorReady) return; // the saved view is read after the page loads
    if (!dept) return;
    setDetailLoading(true);
    // A refusal (no department assigned, or another department) shows the
    // server's message; storing it as the department's data would crash the
    // page.
    fetch(`/api/pulse/code/dept/${encodeURIComponent(dept)}?vendor=${vendor}`)
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.message || (r.status === 403 ? 'You can only view your own department.' : d.error) || "Couldn't load this page. Try again.");
        return d;
      })
      .then(d => { setError(null); setDetail(d); })
      .catch(e => { setDetail(null); setError(e.message); })
      .finally(() => setDetailLoading(false));
  }, [vendor, vendorReady]);

  useEffect(() => {
    if (selectedDept) loadDept(selectedDept);
  }, [selectedDept, loadDept]);

  const handleSelect = (dept: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('dept', dept);
    router.push(`/pulse/code/dept?${params.toString()}`);
  };

  return (
    <>
      <TopBar
        title="Developer Pulse: Departments"
        subtitle={selectedDept ? `Department ${openaiOnly ? 'Codex' : codexPresent ? 'coding' : 'Claude Code'} activity · ${selectedDept}` : 'Select a department'}
      />
      <PageBody>
        {/* Department picker (top-left) */}
        <Toolbar
          left={
            deptsLoading ? (
              <span className="block h-8 w-64 bg-[#F2F2F2] rounded-[10px] animate-pulse" />
            ) : (
              <select
                aria-label="Department"
                value={selectedDept}
                onChange={e => handleSelect(e.target.value)}
                className={cx(B.select, 'min-w-[240px] text-[14px]')}
              >
                {depts.length === 0 && !notInView && <option value="">No departments with {viewLabel} activity</option>}
                {notInView && <option value={selectedDept}>{selectedDept} · no {viewLabel} activity</option>}
                {depts.map(d => (
                  <option key={d.department} value={d.department}>
                    {d.department} · {d.member_count} {d.member_count === 1 ? 'person' : 'people'}
                  </option>
                ))}
              </select>
            )
          }
        >
          <VendorSwitch vendor={vendor} onChange={setVendor} openaiPresent={codexPresent} labels={DEVELOPER_PULSE_VENDOR_LABELS} />
        </Toolbar>

        {error && <Notice tone="error">{error}</Notice>}
        {detailLoading && <LoadingSpinner />}

        {!detailLoading && notInView && (
          <Empty title={`No ${viewLabel} activity in ${selectedDept}`}>
            {depts.length > 0 ? 'Choose a department from the list, or switch view.' : 'Switch view to see other activity.'}
          </Empty>
        )}

        {!detailLoading && !notInView && detail && (
          <>
            <CodeStatStrip metrics={detail.metrics} githubRepos={detail.githubRepos} view={codexView ? vendor : 'claude'} split={detail.metricsSplit} />

            <HumanTimeCard summary={detail.humanTime} surface="code" scope={detail.dept} view={codexView ? vendor : 'claude'} />

            {(detail.journeyGrid?.length ?? 0) > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Tag tone="judged">AI-judged</Tag>
                  <span className="text-[13px] text-[#8F8F8F]">Department delegation journey, 6 weeks</span>
                </div>
                <JourneyGrid data={detail.journeyGrid} heatmap />
              </div>
            )}

            <Panel title="Members" subtitle="7 days" flush>
              <CodeUserTable users={detail.members} showDepartment={false} githubBasis={detail.githubRepos?.basis ?? 'all'} />
            </Panel>
          </>
        )}
      </PageBody>
    </>
  );
}

export default function CodePulseDeptPage() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <DeptContent />
    </Suspense>
  );
}
