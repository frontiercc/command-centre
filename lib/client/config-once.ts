// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// GET /api/config once per page load, shared by the sidebar, the admin menu
// and the vendor switch. Each read writes an access-audit row, so callers that
// only need the flags share this one request. Pages that edit settings fetch
// their own fresh copy.
let request: Promise<Record<string, unknown> | null> | null = null;

export function fetchConfigOnce(): Promise<Record<string, unknown> | null> {
  request ??= fetch('/api/config')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return request;
}
