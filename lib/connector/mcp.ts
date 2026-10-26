// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure JSON-RPC 2.0 protocol handler for the CCC Metrics Connector's
 * Streamable-HTTP MCP endpoint. No HTTP or DB imports here beyond
 * lib/connector/data.ts calls — request object in, response object out, so
 * this is testable without a server and reusable if the transport changes.
 *
 * Auth (verifyConnectorToken) happens at the route level, before this module
 * is ever invoked — nothing here trusts or checks identity.
 */
import { getConnectorSummary, getConnectorTrend, getConnectorHealth, InvalidMetricError, CONNECTOR_METRIC_ALLOWLIST } from '@/lib/connector/data';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'command-centre-metrics', version: '1.0.0' };

/** JSON-RPC 2.0 error codes used by this handler (spec-defined, do not renumber). */
const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
} as const;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface McpHandlerResult {
  status: number;
  json?: object;
}

/** The 3 tool definitions this connector exposes, with JSON Schema inputSchemas. */
const TOOLS = [
  {
    name: 'get_weekly_summary',
    description:
      "Last completed week's org-level AI metrics (Code + Cowork), with deltas vs the prior week, plus by-hand estimate vs measured Claude time when enabled.",
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_metric_trend',
    description: 'Org-level weekly time series for one metric, over a configurable trailing window.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          enum: Array.from(CONNECTOR_METRIC_ALLOWLIST),
          description: 'Which org-level weekly metric to return the trend for.',
        },
        weeks: {
          type: 'integer',
          minimum: 1,
          maximum: 26,
          default: 8,
          description: 'Number of trailing weeks to include (1-26, default 8).',
        },
      },
      required: ['metric'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_data_health',
    description: 'Pricing coverage, identity attribution, and pipeline health counters.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
] as const;

function errorResponse(id: unknown, code: number, message: string): McpHandlerResult {
  return {
    status: 200,
    json: {
      jsonrpc: '2.0',
      id: id === undefined ? null : id,
      error: { code, message },
    },
  };
}

function successResponse(id: unknown, result: object): McpHandlerResult {
  return {
    status: 200,
    json: { jsonrpc: '2.0', id: id === undefined ? null : id, result },
  };
}

function toolErrorResult(id: unknown, message: string): McpHandlerResult {
  return successResponse(id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  });
}

function toolTextResult(id: unknown, data: unknown): McpHandlerResult {
  return successResponse(id, {
    content: [{ type: 'text', text: JSON.stringify(data) }],
  });
}

/** Dispatch a validated tools/call to the underlying data layer. */
async function callTool(id: unknown, name: unknown, args: Record<string, unknown>): Promise<McpHandlerResult> {
  if (typeof name !== 'string') {
    return errorResponse(id, ERROR_CODES.INVALID_PARAMS, 'params.name is required and must be a string');
  }

  switch (name) {
    case 'get_weekly_summary':
      return toolTextResult(id, await getConnectorSummary());

    case 'get_data_health':
      return toolTextResult(id, await getConnectorHealth());

    case 'get_metric_trend': {
      const metric = args.metric;
      const weeks = args.weeks;
      if (typeof metric !== 'string') {
        return errorResponse(id, ERROR_CODES.INVALID_PARAMS, 'arguments.metric is required and must be a string');
      }
      if (weeks !== undefined && typeof weeks !== 'number') {
        return errorResponse(id, ERROR_CODES.INVALID_PARAMS, 'arguments.weeks must be a number when provided');
      }
      try {
        const result = await getConnectorTrend(metric, weeks as number | undefined);
        return toolTextResult(id, result);
      } catch (error) {
        if (error instanceof InvalidMetricError) {
          return toolErrorResult(id, error.message);
        }
        throw error;
      }
    }

    default:
      return toolErrorResult(id, `Unknown tool "${name}"`);
  }
}

async function handleSingle(body: JsonRpcRequest): Promise<McpHandlerResult> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return errorResponse(null, ERROR_CODES.INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC request object');
  }

  const { id, method, params } = body;

  if (typeof method !== 'string' || method.length === 0) {
    return errorResponse(id, ERROR_CODES.INVALID_REQUEST, 'Invalid Request: "method" is required and must be a string');
  }

  const isNotification = id === undefined;

  switch (method) {
    case 'initialize':
      if (isNotification) return { status: 202 };
      return successResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case 'notifications/initialized':
      // Always a notification per the MCP spec; treat any request-shaped
      // call the same way — no meaningful response body to send.
      return { status: 202 };

    case 'tools/list':
      if (isNotification) return { status: 202 };
      return successResponse(id, { tools: TOOLS });

    case 'tools/call': {
      if (isNotification) return { status: 202 };
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        return errorResponse(id, ERROR_CODES.INVALID_PARAMS, 'params is required for tools/call');
      }
      const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
        return errorResponse(id, ERROR_CODES.INVALID_PARAMS, 'params.arguments must be an object when provided');
      }
      return await callTool(id, name, (args as Record<string, unknown>) ?? {});
    }

    default:
      if (isNotification) return { status: 202 };
      return errorResponse(id, ERROR_CODES.METHOD_NOT_FOUND, `Method not found: "${method}"`);
  }
}

/**
 * Handle one already-parsed JSON body against the MCP JSON-RPC protocol.
 * Malformed-JSON (-32700) is a route-level concern (parsing happens before
 * this is called) — this function only ever receives valid JSON values.
 */
export async function handleMcpRequest(body: unknown): Promise<McpHandlerResult> {
  if (Array.isArray(body)) {
    return errorResponse(null, ERROR_CODES.INVALID_REQUEST, 'Batch requests are not supported. Send a single JSON-RPC request per call.');
  }

  return handleSingle(body as JsonRpcRequest);
}
