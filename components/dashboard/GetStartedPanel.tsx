// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

// The dashboard's "Get started" panel: the setup steps for a new install, each
// ticked off from what the install already holds (lib/setup/status.ts) or by
// an admin with Done. Admins only: anyone else gets a 403 from the route and
// the panel renders nothing. Connecting Claude points to Admin → Ingestion,
// which holds the collector address, bearer token and settings to copy.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Panel, B } from '@/components/precision/ui';
import type { SetupStatus, SetupStep } from '@/lib/setup/status';

const SAMPLE_COMMAND = 'docker compose --profile demo run --rm demo-data';

function arrived(at: number | null): string | null {
  if (!at) return null;
  const d = new Date(at * 1000);
  return 'First data arrived ' + d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '.';
}

function Step({ n, done, optional, title, children, link, onDone, busy }: {
  n: number; done: boolean; optional?: boolean; title: string; children: React.ReactNode;
  link?: { href: string; label: string };
  /** Marks the step as done by hand; shown while the step is open. */
  onDone?: () => void;
  busy?: boolean;
}) {
  return (
    <li className="flex gap-3 py-3 border-b border-[#EAEAEA] last:border-b-0">
      <span
        aria-hidden
        className={`mt-0.5 shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[12px] font-semibold ${done ? 'bg-[#146C2E] text-white' : 'border border-[#DADADA] text-[#4D4D4D]'}`}
      >
        {done ? '✓' : n}
      </span>
      <div className="min-w-0">
        <p className={`m-0 text-[14px] font-medium ${done ? 'text-[#8F8F8F]' : 'text-[#0A0A0A]'}`}>
          {title}
          {optional && <span className="ml-2 text-[12px] font-normal text-[#8F8F8F]">Optional</span>}
          <span className="sr-only">{done ? ' (done)' : ' (to do)'}</span>
        </p>
        {!done && <div className="mt-0.5 text-[13px] text-[#4D4D4D]">{children}</div>}
        {!done && (link || onDone) && (
          <div className="mt-1 flex items-center gap-4">
            {link && <Link href={link.href} className={B.link}>{link.label}</Link>}
            {onDone && <button type="button" className={B.link} onClick={onDone} disabled={busy}>Done</button>}
          </div>
        )}
      </div>
    </li>
  );
}

export default function GetStartedPanel() {
  const [s, setS] = useState<SetupStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/api/get-started')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live) setS(d); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  if (!s) return null;

  const post = async (body: { action: 'hide' } | { action: 'show' } | { action: 'step-done'; step: SetupStep }) => {
    setBusy(true);
    try {
      const r = await fetch('/api/get-started', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (r.ok) {
        if (body.action === 'hide' || body.action === 'show') setS({ ...s, hidden: body.action === 'hide' });
        else {
          // Read the steps back, so the count and ticks come from the server.
          const fresh = await fetch('/api/get-started').then((x) => (x.ok ? x.json() : null)).catch(() => null);
          if (fresh) setS(fresh);
        }
      }
    } catch { /* leave the panel as it was; the buttons come back */ }
    setBusy(false);
  };
  // Stays after every step is done, until an admin closes it. Hidden before
  // setup is finished, it leaves a link to bring it back.
  if (s.hidden) {
    if (s.complete) return null;
    return (
      <p className="m-0 text-[13px] text-[#4D4D4D]">
        Setup is not finished ({s.done} of 5 done).{' '}
        <button type="button" className={B.link} onClick={() => post({ action: 'show' })} disabled={busy}>Show setup steps</button>
      </p>
    );
  }

  const done = (step: SetupStep) => () => post({ action: 'step-done', step });
  const marked = (step: SetupStep) => s.markedDone.includes(step);

  const codeDone = s.claudeCodeAt !== null || marked('claude-code');
  const coworkDone = s.coworkAt !== null || marked('cowork');
  const noTelemetry = s.claudeCodeAt === null && s.coworkAt === null;

  return (
    <Panel
      title="Get started"
      subtitle={s.complete ? 'All 5 done' : `${s.done} of 5 done`}
      right={s.complete
        ? <button type="button" className={B.secondary} onClick={() => post({ action: 'hide' })} disabled={busy}>Close</button>
        : <button type="button" className={B.link} onClick={() => post({ action: 'hide' })} disabled={busy}>Hide</button>}
    >
      {s.complete && (
        <p className="m-0 mb-1 text-[13px] text-[#146C2E]">Setup is complete. Close this panel when you are ready.</p>
      )}
      <ol className="m-0 p-0 list-none">
        <Step n={1} done={s.apiKey} title="Add your Claude API key" link={{ href: '/admin/security', label: 'Go to Access & Keys' }} onDone={done('api-key')} busy={busy}>
          Briefings, work classification and summaries use it.
        </Step>
        <Step n={2} done={codeDone} title="Connect Claude Code" link={{ href: '/admin/ingestion', label: 'Go to Ingestion' }} onDone={done('claude-code')} busy={busy}>
          {arrived(s.claudeCodeAt) ?? <>Admin → Ingestion has your collector&apos;s address and bearer token, and the Claude Code settings ready to copy. This ticks when the first data arrives.</>}
        </Step>
        <Step n={3} done={coworkDone} title="Connect Claude Cowork" link={{ href: '/admin/ingestion', label: 'Go to Ingestion' }} onDone={done('cowork')} busy={busy}>
          {arrived(s.coworkAt) ?? <>Admin → Ingestion shows what to enter in Claude&apos;s Organization settings, under Data and Privacy → Monitoring. This ticks when the first data arrives.</>}
        </Step>
        <Step n={4} done={s.rubricReviewed} title="Review how work is classified" link={{ href: '/admin/pulse?tab=tiers', label: 'Go to tiers' }} onDone={done('rubric')} busy={busy}>
          Check the tiers that grade the depth of work people hand to Claude, and adjust them for your organisation if needed. This ticks once they are saved.
        </Step>
        <Step n={5} done={s.departmentsSet} title="Set people's departments" link={{ href: '/admin/users', label: 'Go to User Insights' }} onDone={done('departments')} busy={busy}>
          Most views and briefings group people by department.
        </Step>
        {s.sampleData.available && noTelemetry && (
          <Step n={6} optional done={s.sampleData.loaded} title="Explore with sample data">
            Fills this install with a fictional organisation, so every page has something to show. Use it only on an install for exploring. Run:
            <code className="block mt-1.5 px-2 py-1.5 rounded-[8px] bg-[#F5F5F5] text-[12px] text-[#0A0A0A] font-mono overflow-x-auto">{SAMPLE_COMMAND}</code>
          </Step>
        )}
      </ol>
    </Panel>
  );
}
