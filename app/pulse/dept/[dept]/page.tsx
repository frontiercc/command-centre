// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The old department page, which showed scores (delegation depth, resilience). It is replaced by
// Departments (/pulse/dept), so an old link or bookmark lands on that department there.
import { redirect } from 'next/navigation';

export default async function OldDepartmentPageRedirect({
  params,
}: {
  params: Promise<{ dept: string }>;
}) {
  const { dept } = await params;
  redirect(`/pulse/dept?dept=${encodeURIComponent(decodeURIComponent(dept))}`);
}
