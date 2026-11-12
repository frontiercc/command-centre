// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Admin, first panel: is everything running? Quiet when every job's last run succeeded and
 * telemetry is arriving. Otherwise the failing jobs and the products that have gone quiet are
 * listed, with a strip of every job's last result. Settings stay on the System page.
 */
import { useEffect, useState } from 'react';
import { AnswerPanel, AC } from '@/components/precision/answer';
import { ageWords, listWords, plural } from '@/lib/ui/answer-text';
import type { SystemHealth } from '@/lib/health/system-health';

const QUIET_HOURS = 3;

export default function IsEverythingRunning() {
  const [h, setH] = useState<SystemHealth | null>(null);
  useEffect(() => {
    fetch('/api/admin/system-health').then(r => (r.ok ? r.json() : null)).then(setH).catch(() => setH(null));
  }, []);
  if (!h) return null;
  const nowS = Math.floor(Date.now() / 1000);
  const failing = h.jobs.filter(j => j.status === 'failing');
  const ran = h.jobs.filter(j => j.status !== 'not_run');
  const seen = h.surfaces.filter(s => s.lastEventAt !== null);
  const quiet = seen.filter(s => nowS - (s.lastEventAt ?? 0) > QUIET_HOURS * 3600);
  const badKeys = h.integrations.filter(i => i.status === 'failing');
  const latest = seen.reduce((m, s) => Math.max(m, s.lastEventAt ?? 0), 0);

  const strip = (
    <div className="flex flex-wrap gap-[3px]" aria-label="Each job's last run">
      {h.jobs.map(j => (
        <span key={j.name} title={`${j.label}: ${j.status === 'ok' ? 'last run succeeded' : j.status === 'failing' ? 'last run failed' : 'not run yet'}`}
          className="h-4 rounded-[2px]" style={{ width: 18, background: j.status === 'failing' ? AC.bad : j.status === 'ok' ? AC.measured : '#E4E4E7' }} />
      ))}
    </div>
  );

  if (failing.length === 0 && quiet.length === 0 && badKeys.length === 0) {
    return (
      <AnswerPanel
        question="Is everything running?"
        period={`Checked ${ageWords(h.generatedAt, nowS) === 'under an hour' ? 'just now' : `${ageWords(h.generatedAt, nowS)} ago`}`}
        quiet={<>Everything is running. All {plural(ran.length, 'job')} that have run succeeded on their last run{latest ? `, and the last telemetry arrived ${ageWords(latest, nowS)} ago` : ''}.</>}
        strip={strip}
        detail={{ href: '/admin/system', label: 'See every job and integration' }}
      />
    );
  }

  const parts: string[] = [];
  if (failing.length) parts.push(`${plural(failing.length, 'job')} ${failing.length === 1 ? 'is' : 'are'} failing`);
  if (badKeys.length) parts.push(`${listWords(badKeys.map(k => k.label))} ${badKeys.length === 1 ? 'is' : 'are'} rejecting requests`);
  if (quiet.length) parts.push(`nothing has arrived from ${listWords(quiet.map(q => q.label))} for over ${QUIET_HOURS} hours`);
  const sentence = parts.join('; ');
  return (
    <AnswerPanel
      question="Is everything running?"
      answer={<>{sentence.charAt(0).toUpperCase() + sentence.slice(1)}.</>}
      tag="measured"
      attention={{
        title: 'Needs attention',
        items: [
          ...failing.map(j => ({ key: j.name, label: j.label, why: `· failed ${plural(j.consecutiveFailures, 'time')} in a row${j.lastFailedAt ? `, last ${ageWords(j.lastFailedAt, nowS)} ago` : ''}`, value: 'Failing', tone: 'bad' as const, href: '/admin/system', action: 'Open' })),
          ...badKeys.map(k => ({ key: k.key, label: k.label, why: '· key rejected', value: 'Check key', tone: 'bad' as const, href: '/admin/security', action: 'Open' })),
          ...quiet.map(q => ({ key: q.key, label: q.label, why: `· last event ${ageWords(q.lastEventAt ?? 0, nowS)} ago`, value: 'Quiet', tone: 'warn' as const })),
        ],
      }}
      detail={{ href: '/admin/system', label: 'See every job and integration' }}
      note={`a job is failing when its last run failed. A product is quiet when nothing has arrived from it for over ${QUIET_HOURS} hours; ones never seen are left out.`}
    >
      {strip}
      <div className="flex flex-wrap gap-x-4 mt-2 text-[12px] text-[#666666]">
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: AC.measured }} />Last run succeeded</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: AC.bad }} />Failed</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px] bg-[#E4E4E7]" />Not run yet</span>
      </div>
    </AnswerPanel>
  );
}
