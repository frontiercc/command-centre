// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The one password-length rule (raised from 8). Client-safe: the
// setup, reset and security pages import it for their own checks, and every
// route that sets a password enforces it server-side. Applies to new and
// changed passwords only; existing passwords keep working (no forced resets).
// Most people sign in with SSO; this covers local accounts (the first admin,
// break-glass accounts). NIST SP 800-63B suggests 15 for password-only accounts.
export const MIN_PASSWORD_LENGTH = 12;
export const PASSWORD_TOO_SHORT = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
