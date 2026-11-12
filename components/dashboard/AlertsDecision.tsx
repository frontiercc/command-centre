// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Dashboard "Alerts needing a decision": the open high and critical alerts, oldest first, with a
 * 14-day strip of when alerts were raised. Quiet when none are open.
 */
import { useEffect, useState } from 'react';
import { AnswerPanel, AC, Legend } from '@/components/precision/answer';
import { ageWords, dayMonth, fmtInt, plural } from '@/lib/ui/answer-text';
import { categoryForType, CATEGORY_LABELS } from '@/lib/alerts/categories';

interface AlertRow { id: string; severity: string; status: string; title: string; generated_at: number; alert_type: string }

const DAY = 86400;
const isHigh = (s: string) => s === 'high' || s === 'critical';

export default function AlertsDecision() {
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  useEffect(() => {
    fetch('/api/alerts')
      .then(r => (r.ok ? r.json() : null))
      .then(d => setAlerts(Array.isArray(d) ? d : null))
      .catch(() => setAlerts(null));
  }, []);
  if (!alerts) return null;

  const nowS = Math.floor(Date.now() / 1000);
  const open = alerts.filter(a => a.status === 'open');
  const openHigh = open.filter(a => isHigh(a.severity)).sort((a, b) => a.generated_at - b.generated_at);
  const openOther = open.length - openHigh.length;

  if (openHigh.length === 0) {
    return (
      <AnswerPanel
        question="Alerts needing a decision"
        period="Open now"
        quiet={<>No high or critical alerts are open.{openOther > 0 ? ` ${plural(openOther, 'medium or low alert')} ${openOther === 1 ? 'is' : 'are'} waiting.` : ''}</>}
        detail={{ href: '/alerts', label: open.length > 0 ? `See all ${fmtInt(open.length)} open alerts` : 'Open alerts' }}
      />
    );
  }

  // 14 days of raised alerts, one dot each, high ones as red rings while still open.
  const days = Array.from({ length: 14 }, (_, i) => {
    const start = Math.floor(nowS / DAY) * DAY - (13 - i) * DAY;
    const inDay = alerts.filter(a => a.generated_at >= start && a.generated_at < start + DAY);
    return { start, high: inDay.filter(a => isHigh(a.severity)), other: inDay.filter(a => !isHigh(a.severity)).length };
  });
  const maxStack = Math.max(1, ...days.map(d => d.high.length + d.other));
  const H = Math.min(120, 24 + maxStack * 14);
  const oldest = openHigh[0];
  const kinds = [...new Set(openHigh.map(a => categoryForType(a.alert_type)))].filter(k => k !== 'other');
  const kindWords = kinds.length === 1 ? CATEGORY_LABELS[kinds[0]].replace(/&/g, 'and').toLowerCase() : null;

  return (
    <AnswerPanel
      question="Alerts needing a decision"
      period="Last 14 days"
      answer={<><b>{plural(openHigh.length, 'high alert')}</b> {openHigh.length === 1 ? 'is' : 'are'} open, the oldest for {ageWords(oldest.generated_at, nowS)}.{kindWords ? ` ${openHigh.length === 1 ? 'It is' : 'All are'} about ${kindWords}.` : ''}</>}
      attention={{
        title: 'Open high alerts, oldest first',
        items: openHigh.slice(0, 3).map(a => ({ key: a.id, label: a.title, why: `· ${ageWords(a.generated_at, nowS)}`, href: `/alerts?id=${encodeURIComponent(a.id)}`, action: 'Review' })),
        more: openHigh.length > 3 ? openHigh.length - 3 : undefined,
      }}
      detail={{ href: '/alerts', label: `See all ${fmtInt(open.length)} open alerts` }}
      note="high and critical alerts are the ones sent to Slack. Each dot is an alert on the day it was raised."
    >
      <svg viewBox={`0 0 600 ${H}`} className="w-full h-auto block" role="img">
        {days.map((d, i) => {
          const x = 20 + i * (560 / 13);
          let y = H - 26;
          const dots: JSX.Element[] = [];
          for (let k = 0; k < d.other; k++) { dots.push(<circle key={`o${k}`} cx={x} cy={y} r={5} fill={AC.grey} />); y -= 13; }
          d.high.forEach((a, k) => {
            const stillOpen = a.status === 'open';
            dots.push(<circle key={`h${k}`} cx={x} cy={y} r={6} fill={stillOpen ? '#fff' : AC.bad} stroke={AC.bad} strokeWidth={2.5} />);
            y -= 14;
          });
          return (
            <g key={i}>
              {dots}
              {(i % 2 === 1 || i === 13) && <text x={x} y={H - 5} textAnchor="middle" fontSize="11" fill={AC.faint}>{dayMonth(d.start)}</text>}
            </g>
          );
        })}
      </svg>
      <Legend items={[{ label: 'High or critical', colour: AC.bad, mark: 'dot' }, { label: 'Still open', colour: AC.bad, mark: 'ring' }, { label: 'Medium or low', colour: AC.grey, mark: 'dot' }]} />
    </AnswerPanel>
  );
}
