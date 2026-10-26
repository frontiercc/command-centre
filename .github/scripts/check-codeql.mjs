// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Fails when CodeQL reports a finding that has not been reviewed.
//
//   node .github/scripts/check-codeql.mjs <sarif-dir> <reviewed-file>
//
// The reviewed file lists, per rule and file, how many findings were checked
// and why they are not a problem. A file may not gain more findings of a rule
// than were reviewed, so anything new still fails the run.
import fs from 'node:fs';
import path from 'node:path';

const [sarifDir, reviewedPath] = process.argv.slice(2);
if (!sarifDir || !reviewedPath) {
  console.error('usage: node check-codeql.mjs <sarif-dir> <reviewed-file>');
  process.exit(2);
}

const found = new Map(); // "rule<TAB>file" -> [messages]
for (const name of fs.readdirSync(sarifDir).filter((f) => f.endsWith('.sarif'))) {
  const sarif = JSON.parse(fs.readFileSync(path.join(sarifDir, name), 'utf8'));
  for (const run of sarif.runs ?? []) {
    for (const r of run.results ?? []) {
      const loc = r.locations?.[0]?.physicalLocation;
      const key = `${r.ruleId}\t${loc?.artifactLocation?.uri ?? '?'}`;
      const line = loc?.region?.startLine ?? '?';
      if (!found.has(key)) found.set(key, []);
      found.get(key).push(`${line}: ${r.message?.text ?? ''}`);
    }
  }
}

const reviewed = new Map(); // "rule<TAB>file" -> count
for (const raw of fs.readFileSync(reviewedPath, 'utf8').split(/\r?\n/)) {
  if (!raw.trim() || raw.startsWith('#')) continue;
  const [rule, file, count] = raw.split('\t');
  reviewed.set(`${rule}\t${file}`, Number(count));
}

let total = 0;
const unreviewed = [];
for (const [key, hits] of found) {
  total += hits.length;
  const allowed = reviewed.get(key) ?? 0;
  if (hits.length > allowed) unreviewed.push([key, hits, allowed]);
}

console.log(`CodeQL findings: ${total}; reviewed in ${reviewedPath}: ${total - unreviewed.reduce((n, [, h, a]) => n + h.length - a, 0)}`);
if (unreviewed.length) {
  console.log('\nFindings not yet reviewed:');
  for (const [key, hits, allowed] of unreviewed) {
    const [rule, file] = key.split('\t');
    console.log(`  ${rule} in ${file}: ${hits.length} found, ${allowed} reviewed`);
    for (const h of hits) console.log(`    line ${h}`);
  }
  process.exit(1);
}
