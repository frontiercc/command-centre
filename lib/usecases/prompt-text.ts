// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The person's own words from a stored prompt, ready to show a model. Pure and
 * client-safe. Used by department process mining, the use case session judge
 * and skill drafting, so all three read the same text.
 *
 * About a quarter of one hub's Cowork prompts (over 28 days) start
 * with text the person did not write: Cowork's own <system-reminder> block
 * (closing on average at character 559, so a 600-character slice was nearly
 * all boilerplate), a scheduled-task header plus a fixed 448-character
 * preamble, <artifact-view-context> and <uploaded_files> wrappers, task
 * notifications, and "REDACTED" prompts. Left in, the boilerplate made every
 * scheduled job look like the same process to the session judge.
 */
import { redactPii } from '@/lib/pii/detect';

/** The paragraph every scheduled-task run carries before the task's own instructions (identical across all 222 seen). */
export const SCHEDULED_TASK_PREAMBLE =
  'This is an automated run of a scheduled task. The user is not present to answer questions. For implementation details, execute autonomously without asking clarifying questions — make reasonable choices and note them in your output. "write" actions (e.g. MCP tools that send, post, create, update, or delete), only take them if the task file asks for that specific action. When in doubt, producing a report of what you found is the correct output.';

/** Wrapper blocks added by Cowork around or before the person's words; removed whole. */
const WRAPPER_TAGS = ['system-reminder', 'artifact-view-context', 'uploaded_files', 'task-notification'] as const;

/**
 * URLs and file paths become placeholders, then personal-data patterns are
 * masked. Paths matter: a `/Users/<name>/` folder carries a person's name,
 * which redactPii does not catch. (Moved here from lib/highlights/gather.ts,
 * which re-exports it.)
 */
export function stripIdentity(text: string): string {
  const noUrls = text.replace(/https?:\/\/[^\s)>\]"']+/gi, '[link]');
  const noWinPaths = noUrls.replace(/[A-Za-z]:\\[^\s"'<>|]+/g, '[path]');
  const noUnixPaths = noWinPaths.replace(/(?<=^|[\s("'`@])(?:\/[\w.-]+){2,}\/?/g, '[path]');
  return redactPii(noUnixPaths);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const COLLAPSED_PREAMBLE = collapse(SCHEDULED_TASK_PREAMBLE);

/**
 * The person's own words, identity-stripped and PII-masked, whitespace
 * collapsed. Returns '' when nothing of theirs remains (a redacted prompt, a
 * prompt that was only a wrapper), so callers can skip it. A scheduled task
 * keeps its name ("Scheduled task: <name>.") and its own instructions.
 */
/** A captured output file name made safe to send: paths/links stripped, PII masked, capped. '' when nothing is left. */
export function cleanOutputName(raw: string | null | undefined): string {
  if (!raw) return '';
  // The file name alone: the folders say who and where, not what the work is.
  const base = raw.trim().split(/[\\/]/).filter(Boolean).pop() ?? '';
  return redactPii(stripIdentity(base)).replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** What a session took in and handed out, as clues to the work (never content). */
export interface SessionClues {
  /** Files it made: successful Write, SendUserFile or Artifact names. */
  made: string[];
  /** Files the person uploaded into it. */
  uploaded: string[];
  /** Connector actions, "server action" (e.g. "gmail create_draft"). */
  actions: string[];
}

/** One line of clues for a prompt, or '' when there are none. */
export function formatClues(c: SessionClues | undefined): string {
  if (!c) return '';
  const parts: string[] = [];
  if (c.uploaded.length) parts.push(`files uploaded: ${c.uploaded.join(', ')}`);
  if (c.made.length) parts.push(`files made: ${c.made.join(', ')}`);
  if (c.actions.length) parts.push(`connector actions: ${c.actions.join(', ')}`);
  return parts.join('; ');
}

export function cleanPromptText(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = raw;
  for (const tag of WRAPPER_TAGS) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'g'), ' ');
    // Stored content is capped (lib/otel/content-limits.ts), so a wrapper can be
    // opened and never closed: drop from the opening tag to the end.
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`), ' ');
  }
  s = s.replace(/<scheduled-task\b[^>]*\bname="([^"]*)"[^>]*>/g, ' Scheduled task: $1. ');
  s = s.replace(/<\/?scheduled-task\b[^>]*>/g, ' ');
  s = s.replace(/<\/?REDACTED>|\bREDACTED\b/g, ' ');
  s = collapse(s);
  s = s.split(COLLAPSED_PREAMBLE).join(' ');
  s = collapse(stripIdentity(s));
  // Nothing left but placeholders and punctuation: treat as empty.
  if (!/[\p{L}\p{N}]/u.test(s.replace(/\[(?:link|path)\]/g, ''))) return '';
  return s;
}
