// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState } from 'react';
import { B, cx } from '@/components/precision/ui';

/**
 * Explicit removal affordance for a stored secret. Blank+Save deliberately
 * never clears a sensitive key (mask/blank round-trips are dropped server-
 * side) — this button is the ONLY clear path. Calls DELETE /api/config/secret,
 * which also resets the integration's job-written sync state (registry:
 * lib/config-secrets.ts). Synced data is never deleted.
 */
export default function SecretRemoveButton({
  configKey,
  label,
  hasValue,
  resetsNote,
  onRemoved,
}: {
  configKey: string;
  label: string;
  hasValue: boolean;
  resetsNote?: string;
  onRemoved: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  if (!hasValue) return null;

  async function handleRemove() {
    const lines = [
      `Remove ${label}?`,
      resetsNote ? `This also resets sync bookmarks: ${resetsNote}.` : '',
      'Synced data is not deleted. This cannot be undone.',
    ].filter(Boolean);
    if (!window.confirm(lines.join('\n\n'))) return;

    setRemoving(true);
    try {
      const res = await fetch('/api/config/secret', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: configKey }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        window.alert(`Remove failed: ${data.error || res.status}`);
        return;
      }
      onRemoved();
    } finally {
      setRemoving(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleRemove}
      disabled={removing}
      aria-label={`Remove ${label}`}
      className={cx(B.danger, 'shrink-0 whitespace-nowrap')}
    >
      {removing ? 'Removing…' : 'Remove'}
    </button>
  );
}
