// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { Panel, Tag, B } from '@/components/precision/ui';

interface Rollup {
  annualisedRecurring: number;
  oneOffTotal: number;
  hoursReclaimedMonthly: number;
  coverage: { valued: number; total: number };
}
interface Entry {
  title: string; team: string | null; valueType: string | null;
  valueAmount: number | null; valuePeriod: string | null; valueBasis: string | null; attributedBy: string | null;
}
interface LedgerData { rollup: Rollup; entries: Entry[] }

const gbp = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;

export default function ValueOnTheTable() {
  const [data, setData] = useState<LedgerData | null>(null);

  useEffect(() => {
    fetch('/api/pulse/capability-ledger')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(setData)
      .catch(() => setData(null));
  }, []);

  // Hidden until at least one capability carries an attributed value.
  if (!data || data.rollup.coverage.valued === 0) return null;
  const { rollup, entries } = data;

  return (
    <Panel
      title="Value on the table"
      badge={<Tag tone="judged">Estimate</Tag>}
      right={<a href="/api/pulse/capability-ledger?format=csv" className={B.link}>Export ledger (CSV)</a>}
      flush
    >
      <p className="m-0 px-4 pt-3 text-[13px] text-[#8F8F8F]">
        Manager-attributed, not modelled. A separate ledger, never added to FinOps spend or Code value estimates.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 px-4 py-3">
        <div>
          <p className="m-0 text-[24px] leading-7 font-semibold tabular-nums text-[#2451F3]">{gbp(rollup.annualisedRecurring)}<span className="text-[13px] font-normal text-[#8F8F8F]"> /yr</span></p>
          <p className="m-0 mt-1 text-[13px] text-[#8F8F8F]">Recurring, annualised</p>
        </div>
        {rollup.oneOffTotal > 0 && (
          <div>
            <p className="m-0 text-[24px] leading-7 font-semibold tabular-nums text-[#2451F3]">{gbp(rollup.oneOffTotal)}</p>
            <p className="m-0 mt-1 text-[13px] text-[#8F8F8F]">One-off (not annualised)</p>
          </div>
        )}
        {rollup.hoursReclaimedMonthly > 0 && (
          <div>
            <p className="m-0 text-[24px] leading-7 font-semibold tabular-nums text-[#2451F3]">{Math.round(rollup.hoursReclaimedMonthly)}<span className="text-[13px] font-normal text-[#8F8F8F]"> hrs/mo</span></p>
            <p className="m-0 mt-1 text-[13px] text-[#8F8F8F]">Time reclaimed</p>
          </div>
        )}
      </div>
      <p className="m-0 px-4 pb-2 text-[13px] text-[#666666]">
        {rollup.coverage.valued} of {rollup.coverage.total} confirmed capabilities carry an attributed value.
      </p>
      <ul className="m-0 p-0 list-none">
        {entries.slice(0, 8).map((e, i) => (
          <li key={i} className="flex items-start justify-between gap-3 px-4 py-2.5 border-t border-[#F2F2F2] text-[14px]">
            <div className="min-w-0">
              <p className="m-0 font-medium text-[#0A0A0A] truncate">{e.title}</p>
              {e.valueBasis && <p className="m-0 text-[13px] text-[#8F8F8F] truncate">{e.valueBasis}</p>}
              {e.attributedBy && <p className="m-0 text-[13px] text-[#8F8F8F]">Attributed by {e.attributedBy}</p>}
            </div>
            <div className="text-right shrink-0 text-[#2451F3] tabular-nums">
              {e.valueType === 'time_reclaimed'
                ? `${Math.round(e.valueAmount ?? 0)} hrs/mo`
                : `${gbp(e.valueAmount ?? 0)} ${e.valuePeriod === 'one_off' ? 'one-off' : e.valuePeriod === 'annual' ? '/yr' : '/mo'}`}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
