// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Microsoft Entra ID directory access for department sync, through Microsoft
 * Graph. Read-only, two calls:
 *
 * - At sign-in: GET /me?$select=… with the signed-in person's own access
 *   token (delegated permission User.Read). Graph returns department only
 *   when it is named in $select.
 * - Daily lookup: GET /users?$select=… with an app-only token from the client
 *   credentials grant (application permission User.Read.All, with admin
 *   consent), using the single sign-on app's client ID and secret. Every page
 *   is read, so one listing covers everyone.
 *
 * Tokens are used once, in memory, and never stored or logged. This module
 * does no database work; lib/directory/department-sync.ts applies the result.
 */
import { isMicrosoftIssuer } from '@/lib/auth/oidc';
import { normaliseEmails } from '@/lib/directory/department-rules';

export interface DirectoryEntry {
  /** Every address the person is known by, lower-cased. */
  emails: string[];
  /** The department as the directory holds it; null when empty. */
  department: string | null;
}

/** A failure the admin can act on, kept apart from a network fault. */
export class DirectoryPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectoryPermissionError';
  }
}

export interface EntraEndpoints {
  tenant: string;
  loginHost: string;
  graphHost: string;
}

/** Graph host for each Microsoft cloud's sign-in host. */
const GRAPH_HOST: Record<string, string> = {
  'login.microsoftonline.com': 'graph.microsoft.com',
  'login.microsoftonline.us': 'graph.microsoft.us',
  'login.partner.microsoftonline.cn': 'microsoftgraph.chinacloudapi.cn',
};

/**
 * The tenant and hosts behind a Microsoft issuer URL
 * (https://login.microsoftonline.com/{tenant}/v2.0, or the older
 * https://sts.windows.net/{tenant}/). null for any other issuer.
 */
export function entraEndpoints(issuerUrl: string | null | undefined): EntraEndpoints | null {
  if (!issuerUrl) return null;
  const withSlash = issuerUrl.endsWith('/') ? issuerUrl : `${issuerUrl}/`;
  if (!isMicrosoftIssuer(withSlash)) return null;
  let url: URL;
  try { url = new URL(withSlash); } catch { return null; }
  const tenant = url.pathname.split('/').filter(Boolean)[0];
  if (!tenant) return null;
  const loginHost = url.host === 'sts.windows.net' ? 'login.microsoftonline.com' : url.host;
  const graphHost = GRAPH_HOST[loginHost];
  if (!graphHost) return null;
  return { tenant, loginHost, graphHost };
}

const SIGN_IN_TIMEOUT_MS = 5_000;
const LIST_TIMEOUT_MS = 20_000;
/** 999 per page (Graph's maximum) × 500 pages: far beyond any customer. */
const MAX_PAGES = 500;
const SELECT = 'id,mail,userPrincipalName,otherMails,proxyAddresses,department';

interface GraphUser {
  mail?: string | null;
  userPrincipalName?: string | null;
  otherMails?: string[] | null;
  proxyAddresses?: string[] | null;
  department?: string | null;
}

function toEntry(u: GraphUser): DirectoryEntry {
  return {
    emails: normaliseEmails([u.mail, u.userPrincipalName, ...(u.otherMails ?? []), ...(u.proxyAddresses ?? [])]),
    department: typeof u.department === 'string' && u.department.trim() !== '' ? u.department : null,
  };
}

async function graphGet(url: string, token: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401 || res.status === 403) {
    throw new DirectoryPermissionError(`Microsoft Graph refused the request (${res.status})`);
  }
  if (!res.ok) throw new Error(`Microsoft Graph returned ${res.status}`);
  return res.json();
}

/** The signed-in person's directory entry, read with their own access token. */
export async function readSignedInEntra(
  endpoints: EntraEndpoints,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DirectoryEntry> {
  const body = await graphGet(
    `https://${endpoints.graphHost}/v1.0/me?$select=${SELECT}`,
    accessToken,
    SIGN_IN_TIMEOUT_MS,
    fetchImpl,
  ) as GraphUser;
  return toEntry(body);
}

/** An app-only Graph token from the client credentials grant. */
export async function appOnlyToken(
  endpoints: EntraEndpoints,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`https://${endpoints.loginHost}/${encodeURIComponent(endpoints.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: `https://${endpoints.graphHost}/.default`,
      grant_type: 'client_credentials',
    }).toString(),
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  });
  if (res.status === 400 || res.status === 401) {
    throw new DirectoryPermissionError('Microsoft refused the app sign-in: check the client ID and secret');
  }
  if (!res.ok) throw new Error(`Microsoft sign-in returned ${res.status}`);
  const body = await res.json() as { access_token?: unknown };
  if (typeof body.access_token !== 'string') throw new Error('Microsoft sign-in returned no token');
  return body.access_token;
}

/** Everyone in the directory, every page. Needs User.Read.All (application). */
export async function listEntraUsers(
  endpoints: EntraEndpoints,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DirectoryEntry[]> {
  const out: DirectoryEntry[] = [];
  let next: string | undefined = `https://${endpoints.graphHost}/v1.0/users?$select=${SELECT}&$top=999`;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const body = await graphGet(next, token, LIST_TIMEOUT_MS, fetchImpl) as { value?: GraphUser[]; '@odata.nextLink'?: string };
    for (const u of body.value ?? []) {
      const entry = toEntry(u);
      if (entry.emails.length > 0) out.push(entry);
    }
    const link = body['@odata.nextLink'];
    // Only ever follow a link back to the same Graph host.
    next = typeof link === 'string' && link.startsWith(`https://${endpoints.graphHost}/`) ? link : undefined;
  }
  return out;
}
