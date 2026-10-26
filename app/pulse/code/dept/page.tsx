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
import { PageBody, Toolbar, Panel, Tag, Notice, B, cx } from '@/components/precision/ui';

interface DeptListRow {
  department: string;
  member_count: number;
}

interface DeptDetail {
  humanTime?: HumanTimeSummary | null;
  dept: string;
  metrics: CodeMetricsRow | null;
  members: CodeUserRow[];
  journeyGrid: Array<{ week: number; tier: number; count: number; provisionalCount?: number }>;
  githubRepos: { count7d: number; names7d: string[] } | null;
}

function DeptContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [depts, setDepts] = useState<DeptListRow[]>([]);
  const [deptsLoading, setDeptsLoading] = useState(true);
  const [detail, setDetail] = useState<DeptDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedDept = searchParams.get('dept') ?? '';

  // Load the department list for the dropdown
  useEffect(() => {
    fetch('/api/pulse/code/depts')
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.message || d.error || "Couldn't load this page. Try again.");
        return d;
      })
      .then(d => {
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDept = useCallback((dept: string) => {
    if (!dept) return;
    setDetailLoading(true);
    // A refusal (no department assigned, or another department) shows the
    // server's message; storing it as the department's data would crash the
    // page.
    fetch(`/api/pulse/code/dept/${encodeURIComponent(dept)}`)
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.message || (r.status === 403 ? 'You can only view your own department.' : d.error) || "Couldn't load this page. Try again.");
        return d;
      })
      .then(d => { setError(null); setDetail(d); })
      .catch(e => { setDetail(null); setError(e.message); })
      .finally(() => setDetailLoading(false));
  }, []);

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
        subtitle={selectedDept ? `Department Claude Code activity · ${selectedDept}` : 'Select a department'}
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
                {depts.length === 0 && <option value="">No departments with Code activity</option>}
                {depts.map(d => (
                  <option key={d.department} value={d.department}>
                    {d.department} · {d.member_count} {d.member_count === 1 ? 'person' : 'people'}
                  </option>
                ))}
              </select>
            )
          }
        />

        {error && <Notice tone="error">{error}</Notice>}
        {detailLoading && <LoadingSpinner />}

        {!detailLoading && detail && (
          <>
            <CodeStatStrip metrics={detail.metrics} githubRepos={detail.githubRepos} />

            <HumanTimeCard summary={detail.humanTime} surface="code" scope={detail.dept} />

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
              <CodeUserTable users={detail.members} showDepartment={false} />
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
