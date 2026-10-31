// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// A localhost stand-in for OpenAI's Compliance Logs Platform endpoints,
// serving the mock data from data.mjs. Point the ChatGPT and Codex sync at it
// to test the whole path without a ChatGPT Enterprise workspace.
//
//   node scripts/openai-mock/server.mjs              # listens on 4010
//   node scripts/openai-mock/server.mjs --write out  # also writes the files available now to out/
//
// Settings (environment): OPENAI_MOCK_PORT (4010), OPENAI_MOCK_DAYS of
// history (14), OPENAI_MOCK_SEED (42), OPENAI_MOCK_RATE_LIMIT (100 a minute).
// The data runs 24 hours past start-up
// and files appear as their time comes, about every 10 minutes, so an
// incremental sync can be watched picking up new files.
//
// Keys: `mock-admin-key` reads every log type; `mock-costs-key` reads COSTS
// only (403 on the rest, as a Costs-only key does); anything else is 401.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildEvents, buildFiles, WORKSPACE_ID, ORGANIZATION_ID } from './data.mjs';

const PORT = Number(process.env.OPENAI_MOCK_PORT || 4010);
const DAYS = Number(process.env.OPENAI_MOCK_DAYS || 14);
const SEED = Number(process.env.OPENAI_MOCK_SEED || 42);
// Per key, per method and route, as documented. Tests raise it to run at full speed.
const RATE_LIMIT_PER_MIN = Number(process.env.OPENAI_MOCK_RATE_LIMIT || 100);
const SIGNED_URL_TTL_MS = 5 * 60 * 1000;

const KEYS = {
  'mock-admin-key': new Set(['CONVERSATION_MESSAGE', 'CODEX_LOG', 'CODEX_TURN', 'COSTS']),
  'mock-costs-key': new Set(['COSTS']),
};
const WORKSPACE_TYPES = new Set(['CONVERSATION_MESSAGE', 'CODEX_LOG', 'CODEX_TURN']);
const ORG_TYPES = new Set(['COSTS']);

const startedAt = Date.now();
const { events, people } = buildEvents({ nowMs: startedAt, days: DAYS, seed: SEED });
const files = buildFiles(events, { seed: SEED });
const byId = new Map(files.map((f) => [f.id, f]));
const signed = new Map(); // token → { fileId, expires }
const hits = new Map(); // key|route|minute → count

const available = (now) => files.filter((f) => f.endMs <= now);

function send(res, status, body, headers = {}) {
  const json = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(json);
}
const fail = (res, status, message, headers) => send(res, status, { error: { message } }, headers);

function rateLimited(key, route) {
  const minute = Math.floor(Date.now() / 60_000);
  const k = `${key}|${route}|${minute}`;
  const n = (hits.get(k) ?? 0) + 1;
  hits.set(k, n);
  return n > RATE_LIMIT_PER_MIN ? String(60 - Math.floor((Date.now() / 1000) % 60)) : null;
}

function parseTypes(url) {
  return url.searchParams.getAll('event_type').flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

function listFiles(res, url, scope, allowedHere, grants) {
  const types = parseTypes(url);
  if (!types.length) return fail(res, 400, 'event_type is required');
  for (const t of types) {
    if (!allowedHere.has(t)) {
      return fail(res, 400, scope === 'workspace' && t === 'COSTS'
        ? 'COSTS is not available from the workspace logs route; use the organization route'
        : `event_type ${t} is not supported on this route`);
    }
    if (!grants.has(t)) return fail(res, 403, `API key is missing the scope to read ${t}`);
  }
  const after = url.searchParams.get('after');
  if (!after || Number.isNaN(Date.parse(after))) return fail(res, 400, 'after must be an ISO 8601 timestamp');
  const before = url.searchParams.get('before');
  if (before && Number.isNaN(Date.parse(before))) return fail(res, 400, 'before must be an ISO 8601 timestamp');
  const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(res, 400, 'limit must be between 1 and 100');

  const afterMs = Date.parse(after);
  const beforeMs = before ? Date.parse(before) : Infinity;
  const matching = available(Date.now()).filter(
    (f) => types.includes(f.event_type) && f.endMs > afterMs && f.endMs < beforeMs,
  );
  const page = matching.slice(0, limit);
  send(res, 200, {
    data: page.map(({ id, event_type, end_time, file_name, file_size, file_sha256 }) => ({ id, event_type, end_time, file_name, file_size, file_sha256 })),
    has_more: matching.length > limit,
    last_end_time: page.length ? page[page.length - 1].end_time : null,
  });
}

function redirectToFile(req, res, fileId, allowedHere, grants) {
  const f = byId.get(fileId);
  if (!f || f.endMs > Date.now()) return fail(res, 404, 'The log file was not found or is no longer available.');
  if (!allowedHere.has(f.event_type)) return fail(res, 404, 'The log file was not found or is no longer available.');
  if (!grants.has(f.event_type)) return fail(res, 403, `API key is missing the scope to read ${f.event_type}`);
  const token = randomBytes(16).toString('hex');
  signed.set(token, { fileId, expires: Date.now() + SIGNED_URL_TTL_MS });
  // Built from the Host the caller used, so the link also works from inside Docker.
  res.writeHead(307, { location: `http://${req.headers.host || `localhost:${PORT}`}/signed/${token}` });
  res.end();
}

function maxEventTime(res, url, allowedHere, grants) {
  const types = parseTypes(url);
  if (!types.length) return fail(res, 400, 'event_type is required');
  const out = {};
  for (const t of types) {
    if (!allowedHere.has(t)) return fail(res, 400, `event_type ${t} is not supported on this route`);
    if (!grants.has(t)) return fail(res, 403, `API key is missing the scope to read ${t}`);
    const mine = available(Date.now()).filter((f) => f.event_type === t);
    out[t] = mine.length ? new Date(Math.max(...mine.map((f) => f.maxEventMs))).toISOString() : null;
  }
  send(res, 200, { max_event_time: out });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');

  // Signed download links carry no Authorization header, like a real signed URL.
  const signedMatch = url.pathname.match(/^\/signed\/([0-9a-f]{32})$/);
  if (signedMatch) {
    const s = signed.get(signedMatch[1]);
    if (!s || s.expires < Date.now()) return fail(res, 403, 'Signed URL has expired');
    const f = byId.get(s.fileId);
    res.writeHead(200, { 'content-type': 'application/jsonl', 'content-length': f.file_size });
    return res.end(f.body);
  }

  const auth = req.headers.authorization ?? '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const grants = KEYS[key];
  if (!grants) return fail(res, 401, 'Invalid or missing admin API key');

  const routes = [
    [/^\/v1\/compliance\/workspaces\/([^/]+)\/logs$/, 'ws-list'],
    [/^\/v1\/compliance\/workspaces\/([^/]+)\/logs\/([^/]+)$/, 'ws-get'],
    [/^\/v1\/compliance\/workspaces\/([^/]+)\/max_event_time$/, 'ws-max'],
    [/^\/v1\/compliance\/organizations\/([^/]+)\/logs$/, 'org-list'],
    [/^\/v1\/compliance\/organizations\/([^/]+)\/logs\/([^/]+)$/, 'org-get'],
    [/^\/v1\/compliance\/organizations\/([^/]+)\/max_event_time$/, 'org-max'],
  ];
  for (const [re, name] of routes) {
    const m = url.pathname.match(re);
    if (!m) continue;
    const retry = rateLimited(key, name);
    if (retry) return fail(res, 429, 'Too many requests', { 'retry-after': retry });
    const isOrg = name.startsWith('org');
    if (isOrg ? m[1] !== ORGANIZATION_ID : m[1] !== WORKSPACE_ID) {
      return fail(res, 404, `${isOrg ? 'organization_id' : 'workspace_id'} not found`);
    }
    const allowedHere = isOrg ? ORG_TYPES : WORKSPACE_TYPES;
    if (name.endsWith('list')) return listFiles(res, url, isOrg ? 'organization' : 'workspace', allowedHere, grants);
    if (name.endsWith('get')) return redirectToFile(req, res, m[2], allowedHere, grants);
    return maxEventTime(res, url, allowedHere, grants);
  }
  return fail(res, 404, 'Not found');
});

const writeIdx = process.argv.indexOf('--write');
if (writeIdx > -1) {
  const dir = path.resolve(process.argv[writeIdx + 1] || 'openai-mock-files');
  mkdirSync(dir, { recursive: true });
  for (const f of available(startedAt)) writeFileSync(path.join(dir, f.file_name), f.body);
  console.log(`Wrote ${available(startedAt).length} files to ${dir}`);
}

server.listen(PORT, () => {
  const now = available(startedAt);
  const count = (t) => now.filter((f) => f.event_type === t).length;
  console.log(`Mock OpenAI Compliance Logs Platform on http://localhost:${PORT}/v1`);
  console.log(`  workspace_id    ${WORKSPACE_ID}`);
  console.log(`  organization_id ${ORGANIZATION_ID}`);
  console.log(`  keys            mock-admin-key (all), mock-costs-key (COSTS only)`);
  console.log(`  people          ${people.chatgpt.length} ChatGPT, ${people.codex.length} Codex`);
  console.log(`  files now       ${count('CONVERSATION_MESSAGE')} CONVERSATION_MESSAGE, ${count('CODEX_LOG')} CODEX_LOG, ${count('CODEX_TURN')} CODEX_TURN, ${count('COSTS')} COSTS`);
});
