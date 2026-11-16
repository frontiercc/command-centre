// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { useToast } from '@/components/shared/ToastProvider';
import { B, Empty, Figure, Notice, PageBody, Panel, Strip, T, Tag, cx } from '@/components/precision/ui';

interface LogRow {
  askedAt: number; askedBy: string; question: string; page: string | null; lookups: string[];
  outcome: string; costUsd: number | null; durationMs: number | null;
}
interface AdminAsk {
  enabled: boolean; hasKey: boolean; model: string; monthlyCapUsd: string; retentionDays: string;
  month: { start: number; spendUsd: number; outcomes: Record<string, number> };
  questions: LogRow[];
}

const OUTCOME: Record<string, { label: string; tone: 'neutral' | 'measured' | 'warn' | 'bad' }> = {
  answered: { label: 'Answered', tone: 'measured' },
  not_answerable: { label: "Couldn't answer", tone: 'warn' },
  refused: { label: 'Failed the number check', tone: 'bad' },
  capped: { label: 'Over the cap', tone: 'warn' },
  error: { label: 'Error', tone: 'bad' },
};

const LOOKUP_LABEL: Record<string, string> = {
  dashboard: 'Dashboard', work_pulse: 'Work Pulse', work_pulse_department: 'Department', departments: 'Departments',
  people_scores: 'People', people_list: 'People list', developer_pulse: 'Developer Pulse', developer_value: 'Developer Value',
  finops_month: 'FinOps', spend_trend: 'Spend trend', spend_review: 'Spend Review', spend_review_person: 'Person spend',
  alerts: 'Alerts', skills_and_connectors: 'S&C Board', use_cases: 'Use Cases', find_person: 'Find person',
  calculate: 'Calculate', cannot_answer: 'No lookup fits',
};

const money = (n: number) => `$${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (s: number) => new Date(s * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function AdminAskPage() {
  const [data, setData] = useState<AdminAsk | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ askEnabled: false, askMonthlyCapUsd: '5', askLogRetentionDays: '90' });
  const [errors, setErrors] = useState<{ cap?: string; days?: string }>({});
  const { showToast } = useToast();

  const load = () => fetch('/api/admin/ask')
    .then(r => (r.ok ? r.json() : Promise.reject()))
    .then((d: AdminAsk) => {
      setData(d);
      setForm({ askEnabled: d.enabled, askMonthlyCapUsd: d.monthlyCapUsd, askLogRetentionDays: d.retentionDays });
    })
    .catch(() => showToast("Couldn't load Ask the data settings", 'error'))
    .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);

  const save = async () => {
    const cap = Number(form.askMonthlyCapUsd);
    const days = Number(form.askLogRetentionDays);
    const next: typeof errors = {};
    if (!form.askMonthlyCapUsd.trim() || !Number.isFinite(cap) || cap < 0) next.cap = 'Enter an amount in dollars, 0 or more.';
    if (!Number.isInteger(days) || days < 1 || days > 3650) next.days = 'Enter a whole number of days from 1 to 3650.';
    setErrors(next);
    if (next.cap || next.days) return;
    setSaving(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // /api/config takes text values only (a boolean is skipped), so the switch goes as 'true' or 'false'.
        body: JSON.stringify({ askEnabled: form.askEnabled ? 'true' : 'false', askMonthlyCapUsd: String(cap), askLogRetentionDays: String(days) }),
      });
      if (!res.ok) throw new Error();
      showToast('Ask the data settings saved', 'success');
      void load();
    } catch {
      showToast("Couldn't save the settings", 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-8"><LoadingSpinner /></div>;
  const spend = data?.month.spendUsd ?? 0;
  const cap = Number(data?.monthlyCapUsd ?? 0);
  const asked = Object.values(data?.month.outcomes ?? {}).reduce((a, b) => a + b, 0);

  return (
    <>
      <TopBar title="Ask the data" subtitle="Questions about the data, for admins, answered from the pages' own figures" />
      <PageBody>
        {data && !data.hasKey && <Notice tone="warn" title="No AI API key.">Ask the data needs one. Add it in <Link href="/admin/security" className="text-[#1F6F8B] hover:underline">Admin → Access &amp; Keys</Link>.</Notice>}

        <Notice tone="info" title="Preview.">Ask the data is in preview: answers may be incomplete, and every page that shows it says so. Each question sends the figures it needs, which can include people&apos;s names and per-person figures but never prompt text, to Anthropic&apos;s API with your AI key. See the AI data flow document.</Notice>

        <Strip cols={4}>
          <Figure label="Spent this month" value={money(spend)} sub={`of a ${money(cap)} cap, measured from Anthropic's token counts`} tone="measured" />
          <Figure label="Questions this month" value={String(asked)} />
          <Figure label="Answered" value={String(data?.month.outcomes.answered ?? 0)} />
          <Figure label="Couldn't answer" value={String(data?.month.outcomes.not_answerable ?? 0)} sub="tells you which lookup to add next" />
        </Strip>

        <Panel title="Settings">
          <div className="flex flex-col gap-4 max-w-xl">
            <label className="flex items-center gap-3 text-[14px]">
              <input type="checkbox" checked={form.askEnabled} onChange={e => setForm(f => ({ ...f, askEnabled: e.target.checked }))} />
              <span><span className="font-medium">Turn on Ask the data</span><span className="block text-[13px] text-[#8F8F8F]">Admins only. It shows in the sidebar, the jump-to search (Ctrl K) and the top bar of every page.</span></span>
            </label>
            <div className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">Model</span>
              <span className="text-[14px]">Claude Haiku 5.5 <Tag>Fixed</Tag></span>
              <span className="text-[12px] text-[#8F8F8F]">Ask the data always runs on {data?.model}. The model picks lookups and writes the sentences; code supplies every figure, and each one is checked against the pages before it&apos;s shown.</span>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">Monthly spend cap (USD)</span>
              <input className={cx(B.input, 'w-40')} inputMode="decimal" value={form.askMonthlyCapUsd} onChange={e => { setForm(f => ({ ...f, askMonthlyCapUsd: e.target.value })); setErrors(x => ({ ...x, cap: undefined })); }} />
              {errors.cap ? <span className="text-[13px] text-[#B42318]">{errors.cap}</span> : <span className="text-[12px] text-[#8F8F8F]">Once this month&apos;s spend reaches it, questions stop until next month.</span>}
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">Keep the question log for (days)</span>
              <input className={cx(B.input, 'w-40')} inputMode="numeric" value={form.askLogRetentionDays} onChange={e => { setForm(f => ({ ...f, askLogRetentionDays: e.target.value })); setErrors(x => ({ ...x, days: undefined })); }} />
              {errors.days ? <span className="text-[13px] text-[#B42318]">{errors.days}</span> : <span className="text-[12px] text-[#8F8F8F]">Older questions are deleted. Answers are never stored.</span>}
            </label>
            <div><button type="button" className={B.primary} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>
          </div>
        </Panel>

        <Panel title="Question log" subtitle="Newest first. The question, which lookups ran and the outcome; never the answer." flush>
          {!data?.questions.length ? (
            <div className="p-4"><Empty title="No questions yet">Questions appear here once an admin asks one.</Empty></div>
          ) : (
            <div className="overflow-x-auto">
              <table className={T.table}>
                <thead>
                  <tr className={T.headRow}>
                    <th scope="col" className={T.th}>When</th>
                    <th scope="col" className={T.th}>Who</th>
                    <th scope="col" className={T.th}>Question</th>
                    <th scope="col" className={T.th}>Lookups</th>
                    <th scope="col" className={T.th}>Outcome</th>
                    <th scope="col" className={T.thRight}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.questions.map((q, i) => {
                    const o = OUTCOME[q.outcome] ?? { label: q.outcome, tone: 'neutral' as const };
                    return (
                      <tr key={i} className={T.row}>
                        <td className={cx(T.tdMute, 'whitespace-nowrap')}>{when(q.askedAt)}</td>
                        <td className={T.tdMute}>{q.askedBy}</td>
                        <td className={cx(T.td, 'min-w-[16rem]')}>{q.question}{q.page && q.page !== '/ask' && <span className="block text-[12px] text-[#8F8F8F]">asked on {q.page}</span>}</td>
                        <td className={cx(T.tdMute, 'text-[13px]')}>{[...new Set(q.lookups.map(l => LOOKUP_LABEL[l] ?? l))].join(', ') || 'None'}</td>
                        <td className={T.td}><Tag tone={o.tone}>{o.label}</Tag></td>
                        <td className={T.tdRight}>{q.costUsd === null ? 'Not priced' : `$${q.costUsd.toFixed(4)}`}</td>
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
