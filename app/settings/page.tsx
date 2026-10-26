// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { redirect } from 'next/navigation';

export default function SettingsRedirect() {
  redirect('/admin/system');
}
