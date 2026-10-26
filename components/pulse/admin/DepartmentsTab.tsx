// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import DeptTable, { DeptRow } from '@/components/pulse/DeptTable';
import { Panel, Muted, Notice } from '@/components/precision/ui';

export default function DepartmentsTab() {
  const [depts, setDepts] = useState<DeptRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/pulse/depts')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => setDepts(d.depts ?? []))
      .catch(() => setDepts([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <Panel>
        <Muted>Loading departments…</Muted>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="info">
        Click a department name to open its full Pulse view. Metrics are computed from
        user-level data, and averages update each time the aggregator runs.
      </Notice>
      <DeptTable depts={depts} />
    </div>
  );
}
