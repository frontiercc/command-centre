// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// SPIKE: proves openid-client v6's functional API (discovery, PKCE auth URL
// build, authorization code grant + ID-token claims) works end-to-end against
// an in-process mock IdP, before any feature code is built on top of it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as client from 'openid-client';
import { startMockIdp, type MockIdp } from './helpers/mock-idp';

let idp: MockIdp;

beforeAll(async () => {
  idp = await startMockIdp();
});

afterAll(async () => {
  await idp.stop();
});

describe('openid-client v6 spike against mock IdP', () => {
  it('discovers server metadata from the mock issuer', async () => {
    const config = await client.discovery(
      new URL(idp.issuer),
      'test-client',
      'test-secret',
      undefined,
      { execute: [client.allowInsecureRequests] },
    );

    expect(config.serverMetadata().issuer).toBe(idp.issuer);
    expect(config.serverMetadata().token_endpoint).toBe(`${idp.issuer}/token`);
    expect(config.serverMetadata().authorization_endpoint).toBe(`${idp.issuer}/authorize`);
    expect(config.serverMetadata().jwks_uri).toBe(`${idp.issuer}/jwks`);
  });

  it('builds a PKCE authorization URL pointing at the mock issuer', async () => {
    const config = await client.discovery(
      new URL(idp.issuer),
      'test-client',
      'test-secret',
      undefined,
      { execute: [client.allowInsecureRequests] },
    );

    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();

    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: 'http://localhost:3001/api/auth/sso/callback',
      scope: 'openid email profile',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });

    expect(authUrl.origin).toBe(idp.issuer);
    expect(authUrl.pathname).toBe('/authorize');
    expect(authUrl.searchParams.get('client_id')).toBe('test-client');
    expect(authUrl.searchParams.get('redirect_uri')).toBe('http://localhost:3001/api/auth/sso/callback');
    expect(authUrl.searchParams.get('code_challenge')).toBe(codeChallenge);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('state')).toBe(state);
    expect(authUrl.searchParams.get('nonce')).toBe(nonce);
  });

  it('completes an authorization code grant and round-trips ID-token claims', async () => {
    const config = await client.discovery(
      new URL(idp.issuer),
      'test-client',
      'test-secret',
      undefined,
      { execute: [client.allowInsecureRequests] },
    );

    const codeVerifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();

    const code = idp.issueCode({
      email: 'person@example.com',
      email_verified: true,
      name: 'Test Person',
      nonce,
    });

    // We never actually fetch the authorization endpoint in tests — the
    // redirect is synthesised here, mirroring what the browser would send
    // back to our callback route.
    const callbackUrl = new URL('http://localhost:3001/api/auth/sso/callback');
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);

    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedState: state,
      expectedNonce: nonce,
    });

    expect(tokens.token_type).toBe('bearer'); // oauth4webapi normalises token_type to lowercase
    expect(tokens.access_token).toBe('mock');
    const claims = tokens.claims();
    expect(claims?.email).toBe('person@example.com');
    expect(claims?.email_verified).toBe(true);
    expect(claims?.name).toBe('Test Person');
    expect(claims?.iss).toBe(idp.issuer);
    expect(claims?.aud).toBe('test-client');

    // The mock recorded the token request so we can assert PKCE + grant shape.
    expect(idp.lastTokenRequest?.grant_type).toBe('authorization_code');
    expect(idp.lastTokenRequest?.code).toBe(code);
    expect(idp.lastTokenRequest?.code_verifier).toBe(codeVerifier);
  });

  it('rejects a mismatched nonce (protects against ID-token substitution)', async () => {
    const config = await client.discovery(
      new URL(idp.issuer),
      'test-client',
      'test-secret',
      undefined,
      { execute: [client.allowInsecureRequests] },
    );

    const codeVerifier = client.randomPKCECodeVerifier();
    const state = client.randomState();

    const code = idp.issueCode({
      email: 'other@example.com',
      email_verified: true,
      nonce: 'nonce-the-idp-signed',
    });

    const callbackUrl = new URL('http://localhost:3001/api/auth/sso/callback');
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);

    await expect(
      client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: codeVerifier,
        expectedState: state,
        expectedNonce: 'a-different-nonce',
      }),
    ).rejects.toThrow();
  });
});
