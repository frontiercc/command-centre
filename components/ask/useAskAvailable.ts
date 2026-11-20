// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { sharedGet } from '@/components/shared/shared-get';

/** Whether Ask the data is available to this person (an admin, turned on, with an AI key). Asked once per page load. */
let cached: Promise<boolean> | null = null;

export function askAvailable(): Promise<boolean> {
  if (!cached) {
    cached = sharedGet('/api/ask')
      .then(r => (r.ok ? r.json() : { available: false }))
      .then((d: { available?: boolean }) => d.available === true)
      .catch(() => false);
  }
  return cached;
}

export function useAskAvailable(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let live = true;
    askAvailable().then(v => { if (live) setOk(v); });
    return () => { live = false; };
  }, []);
  return ok;
}

/**
 * What the current page is showing, for the drawer: a page with a period or team choice
 * registers a short note ("Work Pulse shows the last quarter"), so "this page" questions are
 * answered for what is on screen. Notes go when the page does.
 */
const pageNotes = new Map<string, string>();

export function useAskPageNote(key: string, note: string | null) {
  useEffect(() => {
    if (note) pageNotes.set(key, note); else pageNotes.delete(key);
    return () => { pageNotes.delete(key); };
  }, [key, note]);
}

/** The notes the current page registered, with its All / Claude / ChatGPT setting. */
export function currentPageNote(vendor: string | null): string {
  const parts = [...pageNotes.values()];
  if (vendor === 'claude') parts.push('The page is set to Claude products only.');
  else if (vendor === 'openai') parts.push('The page is set to ChatGPT and Codex only.');
  return parts.join(' ');
}

/** Open the slide-out drawer, optionally with a question to ask straight away. */
export function openAskDrawer(question?: string) {
  window.dispatchEvent(new CustomEvent('ask:open', { detail: { question } }));
}
