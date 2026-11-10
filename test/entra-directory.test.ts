// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The Entra adapter against a stand-in for Microsoft (no network).
import { describe, it, expect, vi } from 'vitest';
import {
  entraEndpoints, readSignedInEntra, appOnlyToken, listEntraUsers, DirectoryPermissionError,
} from '@/lib/directory/entra';

const TENANT = '11111111-2222-3333-4444-555555555555';
const ENDPOINTS = { tenant: TENANT, loginHost: 'login.microsoftonline.com', graphHost: 'graph.microsoft.com' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('entraEndpoints', () => {
  it('reads the tenant from a v2.0 issuer and picks the public Graph host', () => {
    expect(entraEndpoints(`https://login.microsoftonline.com/${TENANT}/v2.0`)).toEqual(ENDPOINTS);
  });
  it('maps the older sts.windows.net issuer to the public sign-in host', () => {
    expect(entraEndpoints(`https://sts.windows.net/${TENANT}/`)).toEqual(ENDPOINTS);
  });
  it('picks the US government Graph host for that cloud', () => {
    expect(entraEndpoints(`https://login.microsoftonline.us/${TENANT}/v2.0`)?.graphHost).toBe('graph.microsoft.us');
  });
  it('is null for any other provider', () => {
    expect(entraEndpoints('https://accounts.google.com')).toBeNull();
    expect(entraEndpoints('https://example.okta.com/oauth2/default')).toBeNull();
    expect(entraEndpoints('')).toBeNull();
  });
});

describe('readSignedInEntra', () => {
  it('asks Graph for the department by name and returns every address', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      mail: 'Declan@Example.com', userPrincipalName: 'declan@example.onmicrosoft.com', otherMails: [], proxyAddresses: ['smtp:dg@example.com'], department: 'Operations',
    }));
    const entry = await readSignedInEntra(ENDPOINTS, 'token', fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('https://graph.microsoft.com/v1.0/me?$select=');
    expect(url).toContain('department');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token');
    expect(entry).toEqual({ emails: ['declan@example.com', 'declan@example.onmicrosoft.com', 'dg@example.com'], department: 'Operations' });
  });

  it('gives a null department when the directory has none', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { mail: 'a@example.com', department: '  ' }));
    expect((await readSignedInEntra(ENDPOINTS, 't', fetchImpl as unknown as typeof fetch)).department).toBeNull();
  });

  it('reports a refusal as a permission error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, {}));
    await expect(readSignedInEntra(ENDPOINTS, 't', fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(DirectoryPermissionError);
  });
});

describe('appOnlyToken', () => {
  it('uses the client credentials grant for the Graph default scope', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { access_token: 'app-token' }));
    expect(await appOnlyToken(ENDPOINTS, 'client', 'secret', fetchImpl as unknown as typeof fetch)).toBe('app-token');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('scope')).toBe('https://graph.microsoft.com/.default');
  });

  it('reports a rejected client ID or secret as a permission error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: 'invalid_client' }));
    await expect(appOnlyToken(ENDPOINTS, 'c', 's', fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(DirectoryPermissionError);
  });
});

describe('listEntraUsers', () => {
  it('reads every page and skips entries with no address', async () => {
    const pages = [
      jsonResponse(200, { value: [{ mail: 'a@example.com', department: 'Finance' }, { department: 'Orphan' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=2' }),
      jsonResponse(200, { value: [{ userPrincipalName: 'b@example.com', department: null }] }),
    ];
    const fetchImpl = vi.fn(async () => pages.shift()!);
    const users = await listEntraUsers(ENDPOINTS, 't', fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(users).toEqual([
      { emails: ['a@example.com'], department: 'Finance' },
      { emails: ['b@example.com'], department: null },
    ]);
  });

  it('never follows a next link to another host', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { value: [], '@odata.nextLink': 'https://evil.example.com/next' }));
    await listEntraUsers(ENDPOINTS, 't', fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a missing User.Read.All as a permission error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, {}));
    await expect(listEntraUsers(ENDPOINTS, 't', fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(DirectoryPermissionError);
  });
});
