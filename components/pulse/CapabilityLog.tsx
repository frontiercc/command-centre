// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Panel, T, Muted } from '@/components/precision/ui';

interface CapabilityEvent {
  id: number;
  title: string;
  body: string | null;
  tier: number | null;
  detected_at: number;
  confirmed_at: number | null;
  user_id: string;
  display_name: string | null;
  email: string;
  team_id: string | null;
  department: string | null;
  content_preview?: string | null;
}

/**
 * Strip legacy slug from old-format titles like
 * "Capability creation candidate (capability_creation)" → "Capability Creation"
 * New-format titles "New capability — Engineering · Architecture" pass through unchanged.
 */
export function cleanTitle(title: string): string {
  // Legacy format: "Capability creation candidate (some_slug)"
  const legacyMatch = title.match(/^Capability creation candidate \((.+)\)$/i);
  if (legacyMatch) {
    return legacyMatch[1]
      .replace(/:/g, ' · ')
      .replace(/_/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }
  // New format: strip "New capability — " prefix for display
  return title.replace(/^New capability\s*[—–-]\s*/i, '');
}

interface CapabilityLogProps {
  events: CapabilityEvent[];
}

function formatDate(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

export default function CapabilityLog({ events }: CapabilityLogProps) {
  return (
    <Panel
      title="Capability creation log"
      subtitle={events.length > 0 ? `${events.length} confirmed` : undefined}
      flush={events.length > 0}
    >
      {events.length === 0 ? (
        <Muted>
          No confirmed capability creation events yet. Candidates appear when the classifier detects novel work,
          and are confirmed by an admin in the team view.
        </Muted>
      ) : (
        <div className="overflow-x-auto">
          <table className={`${T.table} min-w-[600px]`}>
            <thead>
              <tr className={T.headRow}>
                <th scope="col" className={T.th}>Date</th>
                <th scope="col" className={T.th}>Capability</th>
                <th scope="col" className={T.th}>Person</th>
                <th scope="col" className={T.th}>Team</th>
                <th scope="col" className={T.thRight}>Tier</th>
              </tr>
            </thead>
            <tbody>
              {events.map(ev => (
                <tr key={ev.id} className={T.row}>
                  <td className={`${T.tdMute} whitespace-nowrap tabular-nums`}>{formatDate(ev.confirmed_at ?? ev.detected_at)}</td>
                  <td className={`${T.td} max-w-sm`}>
                    <p className="m-0 font-medium text-[#0A0A0A]">{cleanTitle(ev.title)}</p>
                    {ev.content_preview && (
                      <p className="m-0 mt-0.5 text-[13px] text-[#666666] line-clamp-2">
                        &ldquo;{ev.content_preview.slice(0, 180)}&rdquo;
                      </p>
                    )}
                    {!ev.content_preview && ev.body && (
                      <p className="m-0 mt-0.5 text-[13px] text-[#8F8F8F] line-clamp-2">{ev.body}</p>
                    )}
                  </td>
                  <td className={`${T.td} whitespace-nowrap`}>{ev.display_name ?? ev.email}</td>
                  <td className={`${T.tdMute} whitespace-nowrap`}>{ev.department ?? ev.team_id ?? '—'}</td>
                  <td className={`${T.td} text-right`}>
                    {ev.tier ? (
                      <span className={`font-mono text-[12px] px-1.5 py-0.5 rounded-[6px] ${
                        ev.tier === 3 ? 'bg-[#3D6CE8] text-white' :
                        ev.tier === 2 ? 'bg-[#8DB2FC] text-[#05073F]' :
                        'bg-[#CCD1DB] text-[#05073F]'
                      }`} title="Tier is AI-judged">
                        T{ev.tier}
                      </span>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
