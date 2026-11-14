// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The old person page, which showed scores (delegation depth, output index). It is replaced by
// Person 360 (/pulse/person/[userId]), so an old link or bookmark lands there.
import { redirect } from 'next/navigation';

export default async function OldPersonPageRedirect({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  redirect(`/pulse/person/${encodeURIComponent(decodeURIComponent(userId))}`);
}
