// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Writes THIRD-PARTY-NOTICES.md from package-lock.json and the installed
// packages: every package the application uses at run time (development-only
// tools are left out), with its licence, source, copyright lines and any
// NOTICE file, followed by the licence texts.
//
//   npm run notices            rewrite the file (after npm ci)
//   npm run notices -- --check fail if the file is out of date (used by CI)
//
// Packages that install on some machines only (optional dependencies such as
// sharp's per-platform builds) are described from package-lock.json alone, never from the
// installed copy, so the file comes out the same on every operating system.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'THIRD-PARTY-NOTICES.md');
const check = process.argv.includes('--check');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

const entries = [], missing = [], texts = new Map(), seen = new Set();
// A copyright line, but not the blank template in the Apache licence appendix.
const isCopy = (l) => /^(copyright\b|\(c\)|©)/i.test(l.trim()) && !/\[yyyy\]|\{yyyy\}|<year>|\[name of copyright owner\]/i.test(l);

for (const [key, v] of Object.entries(lock.packages || {})) {
  if (!key.includes('node_modules/') || v.dev || v.devOptional || v.link) continue;
  const name = v.name || key.slice(key.lastIndexOf('node_modules/') + 13);
  const id = name + '@' + v.version;
  if (seen.has(id)) continue; seen.add(id);
  // Optional packages install on some machines and not others.
  const platformOnly = Boolean(v.os || v.cpu || v.libc || v.optional);
  const dir = path.join(root, ...key.split('/'));
  let pj = null;
  if (!platformOnly) { try { pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {} }
  if (pj && pj.version !== v.version) pj = null;
  const licence = v.license || (pj && (typeof pj.license === 'string' ? pj.license : pj.license?.type)) || 'Not stated';
  const e = { name, version: v.version, licence, source: null, copyright: [], notice: null, installed: !!pj };
  if (pj) {
    const repoUrl = typeof pj.repository === 'string' ? pj.repository : pj.repository?.url;
    e.source = repoUrl ? repoUrl.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/\.git$/, '') : (pj.homepage || null);
    if (e.source && /^[\w.-]+\/[\w.-]+$/.test(e.source)) e.source = 'https://github.com/' + e.source;
    if (e.source && /^github:/.test(e.source)) e.source = 'https://github.com/' + e.source.slice(7);
    const names = fs.readdirSync(dir);
    const lf = names.find((f) => /^(licen[cs]e|copying)([.-]|$)/i.test(f) && fs.statSync(path.join(dir, f)).isFile());
    if (lf) {
      const t = fs.readFileSync(path.join(dir, lf), 'utf8');
      e.copyright = [...new Set(t.split(/\r?\n/).filter(isCopy).map((l) => l.trim()))].slice(0, 5);
      if (!texts.has(licence)) texts.set(licence, { from: id, text: t.split(/\r?\n/).filter((l) => !isCopy(l)).join('\n').trim() });
    }
    const nf = names.find((f) => /^notice([.-]|$)/i.test(f) && fs.statSync(path.join(dir, f)).isFile());
    if (nf) e.notice = fs.readFileSync(path.join(dir, nf), 'utf8').trim();
  } else if (!platformOnly) missing.push(id);
  entries.push(e);
}

if (missing.length) {
  console.error(`${missing.length} package(s) are not installed at the locked version. Run npm ci first (${missing.slice(0, 5).join(', ')}).`);
  process.exit(1);
}

entries.sort((a, z) => a.name.localeCompare(z.name) || a.version.localeCompare(z.version));
const counts = {}; for (const e of entries) counts[e.licence] = (counts[e.licence] || 0) + 1;
const fence = (s) => '~~~text\n' + s.replace(/~~~/g, '~ ~ ~') + '\n~~~';
const out = ['# Third-party notices', '',
  "Frontier Command Centre uses the open-source packages below when it runs. Development-only tools are not listed. This file is generated from package-lock.json and the installed packages by `npm run notices`, and CI checks it is current. For each package it gives the version, licence and source, the copyright lines from the package's licence file and, where the package ships one, its NOTICE file. The text of each licence follows the list.", '',
  entries.length + ' packages:', '',
  '| Licence | Packages |', '|---|---|',
  ...Object.entries(counts).sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0])).map(([l, n]) => '| ' + l + ' | ' + n + ' |'), '',
  '## Packages', ''];
for (const e of entries) {
  out.push('### ' + e.name + ' ' + e.version, '', 'Licence: ' + e.licence + (e.source ? '. Source: ' + e.source : '') + '.', '');
  if (!e.installed) out.push('Installed on some machines only; licence taken from package-lock.json.', '');
  if (e.copyright.length) out.push(...e.copyright.map((c) => '- ' + c), '');
  if (e.notice) out.push('NOTICE:', '', fence(e.notice), '');
}
// sharp's prebuilt libvips packages ship no licence file of their own; their
// README lists the libraries they bundle. Summarised here from that list, and
// the LGPL-3.0 and GPL-3.0 texts (gnu.org, in scripts/licences/) are added.
const libvips = entries.filter((e) => e.name.startsWith('@img/sharp-libvips-'));
if (libvips.length) {
  const versions = [...new Set(libvips.map((e) => e.version))].join(', ');
  out.push('## Libraries bundled by sharp', '',
    `sharp, which Next.js uses to process images, installs a prebuilt build of libvips for the machine it runs on: the ${libvips.length} \`@img/sharp-libvips-*\` packages above, version ${versions}. They are not part of this repository; npm downloads the one for your platform when Command Centre is installed, and a Docker image you build includes it.`, '',
    'Each build bundles libvips and the libraries it depends on. Their own licensing list, at https://github.com/lovell/sharp-libvips, gives them as:', '',
    '- **GNU Lesser General Public License v3:** libvips, glib, pango, librsvg, libheif, fribidi, libexif and proxy-libintl, used under the "any later version" clause of their LGPL v2 or v2.1 licences.',
    '- **Mozilla Public License 1.1:** cairo.',
    '- **BSD 2-Clause with the Alliance for Open Media Patent License 1.0:** aom.',
    '- **Permissive licences** (MIT, BSD, zlib, IJG, libpng, libtiff, freetype and fontconfig licences): the others.', '',
    'The LGPL v3 adds permissions to the GNU General Public License v3, so the texts of both follow under Licence texts.', '');
  texts.set('LGPL-3.0-or-later', { from: 'the libraries bundled by sharp, as published by the Free Software Foundation', text: fs.readFileSync(path.join(root, 'scripts', 'licences', 'LGPL-3.0.txt'), 'utf8').trim() });
  texts.set('GPL-3.0', { from: 'the libraries bundled by sharp (the LGPL v3 builds on it), as published by the Free Software Foundation', text: fs.readFileSync(path.join(root, 'scripts', 'licences', 'GPL-3.0.txt'), 'utf8').trim() });
}

// Icon drawings copied into the source from three open-source icon sets.
// They are not npm packages, so they are listed here by hand, each with its
// own licence text from scripts/licences/.
out.push('## Icons copied into the source', '',
  'Some icons in the interface are SVG drawings copied from these icon sets. They are used under the licences below, and the files that contain them say so in a comment.', '');
for (const [name, licence, source, file] of [
  ['Heroicons', 'MIT', 'https://github.com/tailwindlabs/heroicons', 'heroicons-MIT.txt'],
  ['Feather', 'MIT', 'https://github.com/feathericons/feather', 'feather-MIT.txt'],
  ['Lucide', 'ISC', 'https://github.com/lucide-icons/lucide', 'lucide-ISC.txt'],
]) {
  out.push('### ' + name, '', 'Licence: ' + licence + '. Source: ' + source + '.', '', fence(fs.readFileSync(path.join(root, 'scripts', 'licences', file), 'utf8').trim()), '');
}

out.push('## Licence texts', '');
for (const [l, t] of [...texts.entries()].sort((a, z) => a[0].localeCompare(z[0]))) out.push('### ' + l, '', 'As included with ' + t.from + '.', '', fence(t.text), '');
const text = out.join('\n').replace(/\r\n/g, '\n');

if (check) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== text) {
    console.error('THIRD-PARTY-NOTICES.md is out of date. Run npm run notices and commit the result.');
    process.exit(1);
  }
  console.log(`THIRD-PARTY-NOTICES.md is current: ${entries.length} packages, ${texts.size} licence texts.`);
} else {
  fs.writeFileSync(target, text);
  console.log(`Wrote THIRD-PARTY-NOTICES.md: ${entries.length} packages, ${texts.size} licence texts.`);
}
