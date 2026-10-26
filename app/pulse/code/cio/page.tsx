// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The Executive View's verdict cards lead /pulse/code. This route redirects
// there so old bookmarks keep working.
import { redirect } from 'next/navigation';

export default function CodeCioRedirect() {
  redirect('/pulse/code');
}
