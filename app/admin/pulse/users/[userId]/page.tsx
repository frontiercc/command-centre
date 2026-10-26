// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import UserDrillDown from '@/components/pulse/admin/UserDrillDown';
import { PageBody } from '@/components/precision/ui';

export default function AdminUserPulsePage({ params }: { params: Promise<{ userId: string }> }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [adminChecked, setAdminChecked] = useState(false);
  const router = useRouter();

  useEffect(() => {
    params.then(p => setUserId(decodeURIComponent(p.userId)));
  }, [params]);

  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(data => {
        if (!data.authenticated || data.user?.role !== 'admin') {
          router.replace('/audit');
        } else {
          setAdminChecked(true);
        }
      })
      .catch(() => router.replace('/audit'));
  }, [router]);

  if (!adminChecked || !userId) return (
    <>
      <TopBar title="User Pulse" subtitle="Admin drill-down" />
      <LoadingSpinner />
    </>
  );

  return (
    <>
      <TopBar title="User Pulse" subtitle="Admin drill-down" />
      <PageBody>
        <UserDrillDown userId={userId} />
      </PageBody>
    </>
  );
}
