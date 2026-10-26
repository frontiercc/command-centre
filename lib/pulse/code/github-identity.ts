// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Pure identity helpers for per-user GitHub attribution.
// Two normalised identity forms exist everywhere in this feature:
//   - a lowercased email:      'jane.smith@example.com'
//   - a lowercased login form: 'login:jsmith'
// Emails are lowercased deliberately (commit author email casing is
// user-controlled and unreliable) — a documented deviation from the OTel
// receiver's exact-match rule, applied only in the GitHub sync path.

export interface CommitAuthor {
  email: string | null;
  login: string | null;
}

const NOREPLY_RE = /^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i;

/** GitHub noreply address → the login inside it (lowercased), else null. */
export function extractNoreplyLogin(email: string): string | null {
  const m = NOREPLY_RE.exec(email.trim());
  return m ? m[1].toLowerCase() : null;
}

/** Ordered, deduped identity candidates for map lookup: email first, then login form. */
export function identityCandidates(a: CommitAuthor): string[] {
  const out: string[] = [];
  const email = a.email?.trim().toLowerCase() || null;
  if (email) out.push(email);
  const login = a.login?.trim().toLowerCase() || (email ? extractNoreplyLogin(email) : null);
  if (login) {
    const form = `login:${login}`;
    if (!out.includes(form)) out.push(form);
  }
  return out;
}

/** The single identity an unmatched commit is queued under: login form preferred. */
export function bestUnmatchedIdentity(a: CommitAuthor): string | null {
  const login = a.login?.trim().toLowerCase() || (a.email ? extractNoreplyLogin(a.email) : null);
  if (login) return `login:${login}`;
  const email = a.email?.trim().toLowerCase();
  return email || null;
}
