// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { redirect } from 'next/navigation';
export default async function UserDetailRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect('/admin/users/' + id);
}
