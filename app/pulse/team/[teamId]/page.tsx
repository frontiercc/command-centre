// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Redirect shim: /pulse/team/[teamId] lands on that department on Departments.
import { redirect } from 'next/navigation';

export default async function TeamPulseRedirect({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  redirect(`/pulse/dept?dept=${encodeURIComponent(decodeURIComponent(teamId))}`);
}
