// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// In-process HTTP mock OIDC IdP for tests. Binds to 127.0.0.1 on an ephemeral
// port, never touches the network, and exercises the same discovery/JWKS/token
// surface a real IdP (Google/Okta/Entra) would present to openid-client v6.
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

export interface MockIdp {
  issuer: string; // http://127.0.0.1:<port>
  stop(): Promise<void>;
  issueCode(claims: { email: string; email_verified?: boolean | null; name?: string; nonce: string; extra?: Record<string, unknown> }): string; // registers a one-time auth code
  lastTokenRequest?: Record<string, string>;
}

const ALG = 'RS256';

export async function startMockIdp(): Promise<MockIdp> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
  const kid = randomUUID();
  const publicJwk = await exportJWK(publicKey);

  // Pending one-time auth codes, keyed by code -> claims to embed in the ID token.
  const pendingCodes = new Map<string, { email: string; email_verified?: boolean | null; name?: string; nonce: string; extra?: Record<string, unknown> }>();

  const mockIdp: MockIdp = {
    issuer: '', // filled in once the server is listening
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
    issueCode(claims) {
      const code = randomUUID();
      pendingCodes.set(code, claims);
      return code;
    },
    lastTokenRequest: undefined,
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);

    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      const body = JSON.stringify({
        issuer: mockIdp.issuer,
        authorization_endpoint: `${mockIdp.issuer}/authorize`,
        token_endpoint: `${mockIdp.issuer}/token`,
        jwks_uri: `${mockIdp.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: [ALG],
        scopes_supported: ['openid', 'email', 'profile'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/jwks') {
      const body = JSON.stringify({ keys: [{ ...publicJwk, kid, use: 'sig', alg: ALG }] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/token') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        void (async () => {
          const params = new URLSearchParams(raw);
          const tokenRequest: Record<string, string> = {};
          for (const [k, v] of params.entries()) tokenRequest[k] = v;
          mockIdp.lastTokenRequest = tokenRequest;

          const grantType = params.get('grant_type');
          const code = params.get('code');
          const codeVerifier = params.get('code_verifier');
          const clientId = params.get('client_id');

          if (grantType !== 'authorization_code' || !code || !codeVerifier) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_request' }));
            return;
          }

          const claims = pendingCodes.get(code);
          if (!claims) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          pendingCodes.delete(code); // one-time use

          const now = Math.floor(Date.now() / 1000);
          // email_verified: null leaves the claim out, as Microsoft Entra ID does.
          const payload: Record<string, unknown> = {
            nonce: claims.nonce,
            email: claims.email,
            name: claims.name,
            ...claims.extra,
          };
          if (claims.email_verified !== null) payload.email_verified = claims.email_verified ?? true;
          const idToken = await new SignJWT(payload)
            .setProtectedHeader({ alg: ALG, kid })
            .setIssuer(mockIdp.issuer)
            .setSubject(claims.email)
            .setAudience(clientId ?? 'test-client')
            .setIssuedAt(now)
            .setExpirationTime(now + 300)
            .sign(privateKey);

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id_token: idToken, access_token: 'mock', token_type: 'Bearer' }));
        })();
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('mock IdP failed to bind to an ephemeral port');
  }
  mockIdp.issuer = `http://127.0.0.1:${address.port}`;

  return mockIdp;
}
