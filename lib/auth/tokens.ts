// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import * as crypto from "crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Generate a 256-bit cryptographically random token, base62-encoded (~43 chars),
 * with the given prefix prepended (e.g. "ccc_enroll_Ab3x…").
 */
export function generateToken(prefix: string): string {
  // Use rejection sampling to eliminate modulo bias (256 % 62 != 0).
  // Only accept bytes < 248 (248 = 62 * 4, evenly divisible).
  let encoded = "";
  while (encoded.length < 43) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < 248) {
      encoded += BASE62[byte % 62];
    }
  }
  // Ensure prefix ends with underscore separator
  const safePrefix = prefix.endsWith("_") ? prefix : `${prefix}_`;
  return `${safePrefix}${encoded}`;
}

/**
 * SHA-256 hash a raw token string and return the hex digest.
 * Raw tokens are never persisted — only their hashes are stored.
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time string comparison using crypto.timingSafeEqual.
 * Handles different-length strings safely: when lengths differ we still
 * compare bufA against itself (to keep timing constant) then return false.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) {
    // Compare bufA against itself to maintain constant time, then return false.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Mask a token for display in logs/UI.
 * Shows the prefix + first ~8 chars after the last underscore, then "••••••••".
 * Example: "ccc_enroll_Ab3xYz12qW..." → "ccc_enroll_Ab3xYz12••••••••"
 */
export function maskToken(token: string): string {
  const lastUnderscore = token.lastIndexOf("_");
  if (lastUnderscore === -1) {
    // No prefix found — show first 8 chars then mask
    return token.slice(0, 8) + "••••••••";
  }

  const prefix = token.slice(0, lastUnderscore + 1);
  const body = token.slice(lastUnderscore + 1);
  return prefix + body.slice(0, 8) + "••••••••";
}
