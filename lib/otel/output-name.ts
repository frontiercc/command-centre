// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The file name of a Cowork output (frontier boxes). With
// OTEL_LOG_TOOL_DETAILS=1 — already set for Cowork and Code — every
// tool_result carries `tool_parameters` (documented to hold `file_path` for
// Write/Edit/Read) and `tool_input` (the tool's full arguments, which for a
// Write includes the whole file content). We keep ONLY the file name: never a
// directory, never content, never any other argument. The name passes the PII
// scrub before it is stored.
//
// Which field carries the name for SendUserFile and Artifact is not documented,
// so the common argument names are tried in order; a call that yields no name
// stores NULL and the UI falls back to counting outputs.
import { redactPii } from '@/lib/pii/detect';

export const OUTPUT_TOOLS: ReadonlySet<string> = new Set(['Write', 'SendUserFile', 'Artifact']);

const SINGLE_KEYS = ['file_path', 'filePath', 'path', 'file_name', 'filename', 'name', 'title'];
const LIST_KEYS = ['files', 'file_paths', 'paths'];
const MAX_LEN = 200;

function baseName(p: string): string {
  const parts = p.trim().split(/[\\/]/);
  return parts[parts.length - 1].trim();
}

function fromObject(o: unknown): string[] {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return [];
  const rec = o as Record<string, unknown>;
  for (const k of LIST_KEYS) {
    const v = rec[k];
    if (Array.isArray(v)) {
      const names = v.map(x => (typeof x === 'string' ? x : (x && typeof x === 'object' ? fromObject(x)[0] : undefined)))
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .map(baseName)
        .filter(Boolean);
      if (names.length) return names;
    }
  }
  for (const k of SINGLE_KEYS) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim() !== '') {
      const b = baseName(v);
      if (b) return [b];
    }
  }
  return [];
}

function parse(json: unknown): unknown {
  if (typeof json !== 'string') return json;
  try { return JSON.parse(json); } catch { return null; }
}

/**
 * The output's file name(s) for an output tool call, or null. `toolParameters`
 * is the already-parsed tool_parameters object; `toolInput` the raw tool_input
 * attribute (a JSON string, possibly truncated — a truncated string that no
 * longer parses simply yields nothing).
 */
export function outputFileName(toolName: string, toolParameters: unknown, toolInput: unknown): string | null {
  if (!OUTPUT_TOOLS.has(toolName)) return null;
  let names = fromObject(toolParameters);
  if (!names.length) names = fromObject(parse(toolInput));
  if (!names.length) return null;
  const joined = [...new Set(names)].join(', ');
  const capped = joined.length > MAX_LEN ? `${joined.slice(0, MAX_LEN - 1)}…` : joined;
  return redactPii(capped);
}
