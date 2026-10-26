// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Remote MCP endpoint (Streamable HTTP transport, POST-only) exposing the
 * CCC Metrics Connector's read-only org-level tools to MCP clients.
 *
 * v1 limitation: no SSE / streaming responses. The MCP "Streamable HTTP"
 * transport allows a server to either return a single JSON response or
 * upgrade to an SSE stream for a POST; this endpoint always returns a
 * single JSON response body per request (batch requests are also rejected —
 * see lib/connector/mcp.ts). GET (used by real Streamable-HTTP clients to
 * open a server-initiated SSE stream) is not supported in v1 and returns 405.
 */
import { NextRequest, NextResponse } from 'next/server';
import { verifyConnectorToken } from '@/lib/connector/tokens';
import { handleMcpRequest } from '@/lib/connector/mcp';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const token = await verifyConnectorToken(request.headers.get('authorization'));
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: invalid JSON' } },
      { status: 200 }
    );
  }

  const { status, json } = await handleMcpRequest(body);
  if (json === undefined) {
    return new NextResponse(null, { status });
  }
  return NextResponse.json(json, { status });
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
