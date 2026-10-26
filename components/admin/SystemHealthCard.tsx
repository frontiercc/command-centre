// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

// System health: scheduled jobs, telemetry received,
// ingest failures and integrations, from what the hub already records. A check
// that has never run reads "not yet run", never healthy. Ages are shown without
// a red/green verdict; the telemetry-silence alert settings sit under
// "Telemetry received" (lib/alerts/telemetry-silence.ts).

import { useEffect, useState, type ChangeEvent } from 'react';
import type { SystemHealth, JobHealth, IntegrationHealth } from '@/lib/health/system-health';
import { Panel, SubHead, Dot, C, B, cx } from '@/components/precision/ui';
import { ToggleRow } from '@/components/admin/precision-admin';
import { parseWorkHours, isValidTimeZone } from '@/lib/alerts/telemetry-silence';

interface SilenceForm { hours: string; timeZone: string; workHours: string }

function SilenceSettings({ initial }: { initial: SilenceForm }) {
  const [form, setForm] = useState<SilenceForm>(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof SilenceForm) => (e: ChangeEvent<HTMLInputElement>) => { setMsg(null); setForm(f => ({ ...f, [k]: e.target.value })); };

  async function save() {
    const h = Number(form.hours);
    if (form.hours.trim() === '' || !Number.isFinite(h) || h < 0 || h > 40) { setMsg({ ok: false, text: 'Hours must be a number from 0 to 40.' }); return; }
    if (!parseWorkHours(form.workHours)) { setMsg({ ok: false, text: 'Working day must look like 08-18.' }); return; }
    if (!isValidTimeZone(form.timeZone.trim())) { setMsg({ ok: false, text: 'Time zone not recognised. Use a name such as Europe/London or America/Sao_Paulo.' }); return; }
    setSaving(true);
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telemetrySilenceHours: String(h), telemetrySilenceTimezone: form.timeZone.trim(), telemetrySilenceWorkHours: form.workHours.trim() }),
    }).catch(() => null);
    setSaving(false);
    setMsg(res?.ok ? { ok: true, text: 'Saved.' } : { ok: false, text: 'Could not save. Try again.' });
  }

  return (
    <div className="mt-3 pt-3 border-t border-[#F2F2F2]">
      <p className="m-0 text-[13px] text-[#666666] leading-5">
        Alert when a surface that has sent telemetry before sends nothing for this many working hours (Monday to Friday, inside the working day). Nights and weekends do not count. 0 turns this alert off.
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[13px] text-[#333333]">
          Working hours
          <input className={cx(B.input, 'w-20 tabular-nums')} inputMode="decimal" value={form.hours} onChange={set('hours')} aria-label="Working hours of silence before an alert" />
        </label>
        <label className="flex flex-col gap-1 text-[13px] text-[#333333]">
          Working day
          <input className={cx(B.input, 'w-24 tabular-nums')} value={form.workHours} onChange={set('workHours')} placeholder="08-18" />
        </label>
        <label className="flex flex-col gap-1 text-[13px] text-[#333333]">
          Time zone
          <input className={cx(B.input, 'w-48')} value={form.timeZone} onChange={set('timeZone')} placeholder="Europe/London" />
        </label>
        <button type="button" onClick={save} disabled={saving} className={B.secondary}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
      {msg && <p className={cx('m-0 mt-1 text-[13px]', msg.ok ? 'text-[#666666]' : 'text-[#B42318]')}>{msg.text}</p>}
    </div>
  );
}

const fmt = (s: number | null) =>
  s ? new Date(s * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

function ago(s: number | null, now: number): string {
  if (!s) return '—';
  const d = Math.max(0, now - s);
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} days ago`;
}

const NOT_RUN_GREY = '#A3A3A3';

function JobRow({ j, now }: { j: JobHealth; now: number }) {
  const color = j.status === 'failing' ? C.high : j.status === 'not_run' ? NOT_RUN_GREY : C.good;
  return (
    <li className="py-2 text-[14px]">
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
        <span className="text-[#0A0A0A]">{j.label}</span>
        <span className={cx('shrink-0', j.status === 'failing' ? 'text-[#B42318]' : j.status === 'not_run' ? 'text-[#8F8F8F]' : 'text-[#666666]')}>
          <Dot color={color}>
            {j.status === 'failing'
              ? `Failed ${j.consecutiveFailures === 1 ? 'last run' : `last ${j.consecutiveFailures} runs`} · ${ago(j.lastFailedAt, now)}`
              : j.status === 'not_run'
                ? 'Not yet run'
                : `Succeeded ${ago(j.lastSucceededAt, now)}`}
          </Dot>
        </span>
      </div>
      {j.status === 'failing' && (
        <div className="text-[13px] text-[#666666] mt-0.5 break-words">
          {j.lastError}
          <span className="text-[#8F8F8F]"> · last success {fmt(j.lastSucceededAt)}</span>
        </div>
      )}
    </li>
  );
}

function IntegrationRow({ i, now }: { i: IntegrationHealth; now: number }) {
  const text =
    i.status === 'untracked' ? 'Configured · not tracked yet'
      : i.status === 'not_run' ? 'Configured · not yet used'
        : i.status === 'failing' ? `Last call failed · ${ago(i.lastFailedAt, now)}`
          : `Last call succeeded · ${ago(i.lastSucceededAt, now)}`;
  const color = i.status === 'failing' ? C.high : i.status === 'untracked' || i.status === 'not_run' ? NOT_RUN_GREY : C.good;
  return (
    <li className="py-2 text-[14px]">
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
        <span className="text-[#0A0A0A]">{i.label}</span>
        <span className={cx('shrink-0', i.status === 'failing' ? 'text-[#B42318]' : 'text-[#666666]')}>
          <Dot color={color}>{text}</Dot>
        </span>
      </div>
      {i.status === 'failing' && i.lastError && <div className="text-[13px] text-[#666666] mt-0.5 break-words">{i.lastError}</div>}
    </li>
  );
}

export default function SystemHealthCard() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [failed, setFailed] = useState(false);
  // Raise alerts (and so Slack, if Slack alerts are on) for these problems?
  // Off by default: this panel shows them either way.
  const [alertsOn, setAlertsOn] = useState<boolean | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [silence, setSilence] = useState<SilenceForm | null>(null);

  useEffect(() => {
    fetch('/api/config')
      .then(r => (r.ok ? r.json() : null))
      .then(c => {
        if (!c) return;
        setAlertsOn(String(c.systemHealthAlertsEnabled) === 'true');
        setSilence({
          hours: String(c.telemetrySilenceHours ?? '3'),
          timeZone: String(c.telemetrySilenceTimezone || 'Europe/London'),
          workHours: String(c.telemetrySilenceWorkHours || '08-18'),
        });
      })
      .catch(() => {});
    fetch('/api/admin/system-health')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: SystemHealth) => setHealth(d))
      .catch(() => setFailed(true));
  }, []);

  if (failed) {
    return (
      <Panel title="System health">
        <p className="m-0 text-[14px] text-[#B42318]">System health could not be loaded.</p>
      </Panel>
    );
  }
  if (!health) return null;

  async function toggleAlerts(on: boolean) {
    setSaveError(false);
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemHealthAlertsEnabled: on ? 'true' : 'false' }),
    }).catch(() => null);
    if (res?.ok) setAlertsOn(on); else setSaveError(true);
  }

  const now = health.generatedAt;
  const failing = health.jobs.filter(j => j.status === 'failing');
  const ok = health.jobs.filter(j => j.status === 'ok').length;
  const notRun = health.jobs.filter(j => j.status === 'not_run').length;
  const f = health.ingestFailures;

  const listCls = 'm-0 p-0 list-none divide-y divide-[#F2F2F2]';

  return (
    <Panel title="System health" flush>
      <p className="m-0 px-4 pt-3 pb-3 text-[13px] text-[#666666] leading-5">
        What the hub has recorded about its own work: scheduled jobs, telemetry arriving, telemetry it failed to accept, and the integrations it calls.
      </p>

      {alertsOn !== null && (
        <ToggleRow
          label="Raise alerts for system health problems"
          hint="When on, a failing job, a rejected key, stalled retention or a surface that has gone quiet raises one alert per failure, which also goes to Slack if Slack alerts are on. It repeats only after the job has succeeded and then failed again. When off, these problems show only here."
          checked={alertsOn}
          onChange={toggleAlerts}
        >
          {saveError && <span className="text-[13px] text-[#B42318] mt-1">Could not save. Try again.</span>}
        </ToggleRow>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 border-t border-[#EAEAEA]">
        <div className="p-4 min-w-0">
          <SubHead>Scheduled jobs</SubHead>
          <p className={cx('m-0 text-[14px]', failing.length > 0 ? 'text-[#B42318]' : 'text-[#333333]')}>
            {failing.length > 0 ? `${failing.length} failing · ` : ''}
            {ok} succeeded in their last run
            {notRun > 0 ? ` · ${notRun} not yet run (not due or not enabled)` : ''}
          </p>
          {failing.length > 0 && (
            <ul className={cx(listCls, 'mt-1')}>
              {failing.map(j => <JobRow key={j.name} j={j} now={now} />)}
            </ul>
          )}
          <details className="mt-2">
            <summary className="text-[13px] font-medium text-[#245BF3] cursor-pointer">All jobs ({health.jobs.length})</summary>
            <ul className={cx(listCls, 'mt-1')}>
              {health.jobs.map(j => <JobRow key={j.name} j={j} now={now} />)}
            </ul>
          </details>
        </div>

        <div className="p-4 min-w-0 border-t border-[#F2F2F2] md:border-t-0 md:border-l md:border-[#EAEAEA]">
          <SubHead>Telemetry received</SubHead>
          <ul className={listCls}>
            {health.surfaces.map(s => (
              <li key={s.key} className="py-2 text-[14px] flex items-baseline justify-between gap-3">
                <span className="text-[#0A0A0A]">{s.label}</span>
                <span className={s.lastEventAt ? 'text-[#666666]' : 'text-[#8F8F8F]'} title={fmt(s.lastEventAt)}>
                  {s.lastEventAt ? `Last event ${ago(s.lastEventAt, now)}` : 'Nothing received yet'}
                </span>
              </li>
            ))}
          </ul>
          {silence && <SilenceSettings initial={silence} />}
        </div>

        <div className="p-4 min-w-0 border-t border-[#F2F2F2] md:border-[#EAEAEA]">
          <SubHead>Ingest failures</SubHead>
          <p className={cx('m-0 text-[14px] tabular-nums', f.last24h > 0 ? 'text-[#B54708]' : 'text-[#333333]')}>
            <Dot color={f.last24h > 0 ? C.medium : C.good}>
              {f.last24h.toLocaleString('en-GB')} in the last 24 hours · {f.last7d.toLocaleString('en-GB')} in the last 7 days
            </Dot>
          </p>
          {f.lastAt && (
            <p className="m-0 text-[13px] text-[#666666] mt-1 break-words">
              Most recent {fmt(f.lastAt)}: {f.lastMessage}
            </p>
          )}
          <p className="m-0 text-[13px] text-[#8F8F8F] mt-1 leading-5">Telemetry the hub received but could not store. Batches the collector never delivered are covered by the CloudWatch alarms, not here.</p>
        </div>

        <div className="p-4 min-w-0 border-t border-[#F2F2F2] md:border-l md:border-[#EAEAEA]">
          <SubHead>Integrations</SubHead>
          {health.integrations.length === 0 ? (
            <p className="m-0 text-[13px] text-[#8F8F8F]">No integration keys configured.</p>
          ) : (
            <ul className={listCls}>
              {health.integrations.map(i => <IntegrationRow key={i.key} i={i} now={now} />)}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}
