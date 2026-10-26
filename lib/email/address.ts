// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// One plain mailbox, nothing else: telemetry chooses an auto-enrolled
// account's email, and a string such as "a@evil.com,b@corp.com" is a list of
// two recipients to the mail library and passes a domain check on the last
// one (security re-review R1). Allows what real addresses use
// (dots, plus, apostrophes, hyphens, non-ASCII), refuses list and header
// syntax: commas, semicolons, spaces, angle brackets, quotes, brackets,
// colons, backslashes and a second @.
// \x5C is the backslash.
const PLAIN_EMAIL = /^[^\s@,;<>"()[\]:\x5C]+@[^\s@,;<>"()[\]:\x5C.]+(\.[^\s@,;<>"()[\]:\x5C.]+)+$/u;

export function isPlainEmail(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return v.length > 0 && v.length <= 320 && PLAIN_EMAIL.test(v);
}
