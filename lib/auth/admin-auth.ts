// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { findValidSession, adminUserCount, type UserRole } from '@/lib/db/admin-queries';

export type { UserRole };

// ─── Constants
export const SESSION_COOKIE_NAME = 'ccc_session';
const SCRYPT_KEYLEN = 64;
const SALT_LEN = 16;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 2, maxmem: 128 * 1024 * 1024 }; // OWASP-recommended; maxmem raised for Node default limit
const SESSION_DURATION_DEFAULT = 24 * 60 * 60; // 24h
const SESSION_DURATION_REMEMBER = 7 * 24 * 60 * 60; // 7 days

// ─── Password Hashing (scrypt)
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_LEN).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!password || !stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  try {
    const derivedHash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derivedHash, 'hex'));
  } catch {
    return false; // Malformed hash
  }
}

// ─── Session Expiry
export function getSessionExpiry(rememberMe: boolean): number {
  const duration = rememberMe ? SESSION_DURATION_REMEMBER : SESSION_DURATION_DEFAULT;
  return Math.floor(Date.now() / 1000) + duration;
}

// ─── Cookie Helpers
export function setSessionCookie(response: NextResponse, sessionId: string, rememberMe: boolean): void {
  const maxAge = rememberMe ? SESSION_DURATION_REMEMBER : SESSION_DURATION_DEFAULT;
  // Secure cookies only work over HTTPS. In production behind a reverse proxy
  // or Tailscale, HTTPS is provided externally. For local Docker access (HTTP),
  // the cookie must not be marked secure or the browser silently rejects it.
  const useSecure = process.env.NODE_ENV === 'production'
    && process.env.CCC_INSECURE_COOKIES !== 'true';
  response.cookies.set(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge,
    secure: useSecure,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

// ─── Request Auth
export interface AdminSessionResult {
  authenticated: boolean;
  userId?: string;
  email?: string;
  role?: UserRole;
  displayName?: string | null;
  department?: string | null;
}

/**
 * Check if a request has a valid admin session cookie.
 */
export async function getAdminSession(request: NextRequest): Promise<AdminSessionResult> {
  const sessionId = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!sessionId) return { authenticated: false };

  const session = await findValidSession(sessionId);
  if (!session) return { authenticated: false };

  return {
    authenticated: true,
    userId: session.user.id,
    email: session.user.email,
    role: session.user.role,
    displayName: session.user.display_name,
    department: session.user.department,
  };
}

/**
 * Check if a request has admin role (not just viewer).
 */
export async function requireAdmin(request: NextRequest): Promise<(AdminSessionResult & { authenticated: true }) | null> {
  const session = await getAdminSession(request);
  if (!session.authenticated || session.role !== 'admin') return null;
  return session as AdminSessionResult & { authenticated: true };
}

/**
 * Check if setup is needed (no admin users exist).
 */
export async function isSetupNeeded(): Promise<boolean> {
  return (await adminUserCount()) === 0;
}

/** admin + manager can access /admin/pulse (overview/users/depts tabs) */
export function canAccessPulseAdmin(role: UserRole | undefined): boolean {
  return role === 'admin' || role === 'manager';
}

/** contributor roles — API calls are scoped to session.department */
export function isDeptScoped(role: UserRole | undefined): boolean {
  return role === 'cowork' || role === 'pulse' || role === 'code';
}

/** admin + viewer + manager can access dashboard, audit, alerts, reports */
export function canAccessCorePlatform(role: UserRole | undefined): boolean {
  return role === 'admin' || role === 'viewer' || role === 'manager';
}

/**
 * Roles that can read the Audit Log — the only place CCC shows people's own
 * prompt text. Admins see everything; managers see their own department.
 * Viewers are deliberately excluded: the viewer role
 * reads dashboards and figures, not what individuals typed into Claude.
 */
export function canAccessAuditLog(role: UserRole | undefined): boolean {
  return role === 'admin' || role === 'manager';
}

/** roles that can access Work Pulse */
export function canAccessCoworkPulse(role: UserRole | undefined): boolean {
  return role === 'admin' || role === 'manager' || role === 'viewer' || role === 'cowork' || role === 'pulse';
}

/** roles that can access Developer Pulse */
export function canAccessCodePulse(role: UserRole | undefined): boolean {
  return role === 'admin' || role === 'manager' || role === 'viewer' || role === 'code' || role === 'pulse';
}

/** admin + manager + viewer can access org-level overview pages (Cowork CIO, Developer Pulse overview) */
export function canAccessOrgOverview(role: UserRole | undefined): boolean {
  return role === 'admin' || role === 'manager' || role === 'viewer';
}
