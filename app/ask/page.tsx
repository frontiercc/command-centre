// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import AskChat from '@/components/ask/AskChat';
import { askAvailable } from '@/components/ask/useAskAvailable';
import { Empty, PageBody, Panel, Tag } from '@/components/precision/ui';

function AskPage() {
  const q = useSearchParams().get('q') ?? undefined;
  const [state, setState] = useState<'loading' | 'ok' | 'off'>('loading');
  useEffect(() => { askAvailable().then(ok => setState(ok ? 'ok' : 'off')); }, []);

  return (
    <>
      <TopBar title="Ask the data" subtitle="Questions about your organisation's AI use, answered from the pages' own figures" />
      <PageBody>
        {state === 'off' && (
          <Empty title="Ask the data isn't available">
            It&apos;s for admins, and an admin turns it on in <Link href="/admin/ask" className="text-[#1F6F8B] hover:underline">Admin, Ask the data</Link>. It also needs an AI API key.
          </Empty>
        )}
        {state === 'ok' && (
          <Panel title="Ask the data" badge={<span className="inline-flex gap-1.5"><Tag tone="warn">Preview</Tag><Tag>Admin</Tag></span>} subtitle="Claude Haiku 5.5 · every figure checked against the pages">
            <p className="m-0 mb-3 text-[12px] text-[#8F8F8F]">In preview: answers may be incomplete, so check the linked page before acting on a figure.</p>
            <AskChat initialQuestion={q} page="/ask" />
          </Panel>
        )}
      </PageBody>
    </>
  );
}

export default function Page() {
  return <Suspense fallback={null}><AskPage /></Suspense>;
}
