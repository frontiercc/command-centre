// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The people behind a Work Pulse headline figure, opened from its "See who" link: who only hands
 * over administrative work, or who the frontier work rests on. Same window and the same All /
 * Claude / ChatGPT view as the card, and one row per person per product, so the count is the
 * card's figure. Names and departments only.
 */
'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { PageBody, Panel, Notice, Muted, T, Tag } from '@/components/precision/ui';
import { useVendor } from '@/components/shared/VendorSwitch';
import { tierNamesOr, deepWords, type TierNames } from '@/lib/pulse/tier-names';

interface PersonRow {
  userId: string; name: string; department: string | null; product: 'claude' | 'openai'; tasks: number; share: number | null;
}
interface PeopleData { list: 'admin-only' | 'frontier-half'; window: 'quarter' | 'month'; vendor: string; start: number; end: number; people: PersonRow[]; departmentOnly: string | null; tierNames?: TierNames | null }

const PRODUCT: Record<PersonRow['product'], string> = { claude: 'Claude', openai: 'ChatGPT' };
const day = (s: number) => new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

function PeopleInner() {
  const params = useSearchParams();
  const list = params.get('list') === 'frontier-half' ? 'frontier-half' : 'admin-only';
  const windowParam = params.get('window') === 'quarter' ? 'quarter' : 'month';
  const [vendor, , vendorReady] = useVendor();
  const [data, setData] = useState<PeopleData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!vendorReady) return;
    setData(null);
    fetch(`/api/pulse/people?list=${list}&window=${windowParam}&vendor=${vendor}`)
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || "Couldn't load this page. Try again."); return r.json(); })
      .then(setData)
      .catch(e => setError(e.message));
  }, [list, windowParam, vendor, vendorReady]);

  const t = tierNamesOr(data?.tierNames ?? undefined);
  const title = list === 'admin-only' ? `People who only hand over ${t.t1.toLowerCase()} work` : `Who the ${t.t3.toLowerCase()} work rests on`;
  const back = windowParam === 'quarter' ? { href: '/pulse/cio', label: 'Back to Work Pulse' } : { href: '/', label: 'Back to the Dashboard' };
  const both = data ? new Set(data.people.map(p => p.product)).size > 1 : false;

  return (
    <>
      <TopBar title="People behind the figures" subtitle={title} />
      <PageBody>
        <Link href={back.href} className="text-[13px] font-medium text-[#1F6F8B] hover:underline w-fit">{back.label}</Link>
        {error ? <Notice tone="error">{error}</Notice> : !data ? <LoadingSpinner /> : (
          <Panel
            title={title}
            badge={<Tag tone="measured">Measured</Tag>}
            subtitle={`${day(data.start)} to ${day(data.end - 1)}${data.departmentOnly ? ` · ${data.departmentOnly} only` : ''}`}
            flush
          >
            <p className="m-0 px-4 py-3 text-[14px] text-[#333333] border-b border-[#F2F2F2]">
              {data.list === 'admin-only'
                ? <>{data.people.length.toLocaleString('en-GB')} {data.people.length === 1 ? 'person' : 'people'} used it in this period without handing over anything judged {deepWords(data.tierNames ?? undefined)}.</>
                : <>{data.people.length.toLocaleString('en-GB')} {data.people.length === 1 ? 'person does' : 'people do'} half of the {t.t3.toLowerCase()} work{both ? ' on each product' : ''}. If they left, that work would be at risk.</>}
              {both && <> A person using both Claude and ChatGPT appears once for each, as the card counts them.</>}
            </p>
            {data.people.length === 0 ? (
              <div className="p-4"><Muted>Nobody in this period.</Muted></div>
            ) : (
              <table className={T.table}>
                <thead>
                  <tr className={T.headRow}>
                    <th className={T.th}>Person</th>
                    <th className={T.th}>Department</th>
                    <th className={T.th}>Product</th>
                    <th className={T.thRight}>{data.list === 'admin-only' ? 'Tasks judged' : `${t.t3} tasks`}</th>
                    {data.list === 'frontier-half' && <th className={T.thRight}>Share of the {t.t3.toLowerCase()} work</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.people.map(p => (
                    <tr key={`${p.userId}:${p.product}`} className={T.row}>
                      <td className={T.td}>
                        <Link href={`/pulse/users?userId=${encodeURIComponent(p.userId)}`} className="text-[#0A0A0A] font-medium hover:text-[#1F6F8B] hover:underline">{p.name}</Link>
                      </td>
                      <td className={T.tdMute}>{p.department ?? 'No department'}</td>
                      <td className={T.tdMute}>{PRODUCT[p.product]}</td>
                      <td className={T.tdRight}>{p.tasks > 0 ? p.tasks.toLocaleString('en-GB') : <span className="text-[#8F8F8F]">none judged yet</span>}</td>
                      {data.list === 'frontier-half' && <td className={T.tdRight}>{p.share === null ? 'not measured' : `${Math.round(p.share * 100)}%`}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        )}
      </PageBody>
    </>
  );
}

export default function PeoplePage() {
  return <Suspense fallback={<LoadingSpinner />}><PeopleInner /></Suspense>;
}
