// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';

/**
 * The signed-in person's role, for hiding a control or link they cannot use. Empty until known,
 * so anything gated on a role stays hidden while it loads. The server still decides every request.
 */
export function useSessionRole(): string {
  const [role, setRole] = useState('');
  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(d => setRole(d?.authenticated ? (d.user?.role ?? '') : ''))
      .catch(() => {});
  }, []);
  return role;
}
