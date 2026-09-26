#!/usr/bin/env node
'use strict';
// Release gate: refuse to publish anything derived from a developer's machine.
//
// gotcha's whole job is handling transcripts and secrets, so the package is exactly
// the wrong thing to ship carelessly. This fails the publish on: harvested facts,
// candidates, transcripts, state, logs, credentials, or any file whose CONTENT trips
// the same redaction patterns the harvester uses.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const redact = require('../lib/redact');

const ROOT = path.join(__dirname, '..');

// Paths that must never be in a published artifact.
const FORBIDDEN = [
  /(^|\/)candidates\//, /(^|\/)disputed\//, /(^|\/)drafts\//,
  /(^|\/)facts\.ya?ml$/, /(^|\/)topology\.ya?ml$/, /(^|\/)state\.json$/,
  /(^|\/)credentials\.json$/, /(^|\/)config\.json$/,
  /(^|\/)hook-index\.json$/, /(^|\/)DIGEST\.md$/, /(^|\/)REVIEW\.md$/,
  /\.log$/, /(^|\/)logs\//, /\.jsonl$/, /weekly-baseline\.json$/,
];

// Files that legitimately contain the patterns (they ARE the patterns).
const CONTENT_EXEMPT = [/(^|\/)lib\/redact\.js$/, /(^|\/)scripts\/release-check\.js$/, /(^|\/)test\//];

function packedFiles() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const j = JSON.parse(out);
  return (j[0] && j[0].files ? j[0].files : []).map((f) => f.path);
}

const files = packedFiles();
const violations = [];
const warnings = [];

for (const f of files) {
  if (FORBIDDEN.some((re) => re.test(f))) { violations.push([f, 'forbidden path']); continue; }
  if (CONTENT_EXEMPT.some((re) => re.test(f))) continue;
  let text = '';
  try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { continue; }
  // Strict: actual credential material blocks. The broad scrubbing patterns also
  // match template text like "x-access-token:%s", which must not fail a release.
  if (redact.looksSecretStrict(text)) { violations.push([f, 'contains credential material']); continue; }
  if (redact.looksSecret(text)) warnings.push([f, 'mentions a credential-ish keyword (not blocking)']);
  // A developer's home directory leaking into the package is the other giveaway.
  if (/\/Users\/[a-z0-9_.-]+\//i.test(text) && !/\/Users\/<|\/Users\/you/i.test(text)) {
    violations.push([f, 'contains an absolute /Users/<someone> path']);
  }
}

console.log('release-check: ' + files.length + ' file(s) in the package');
for (const [f, why] of warnings) console.log('  note     ' + f + '  (' + why + ')');
if (!violations.length) { console.log('  clean — no facts, transcripts, state, logs, credentials, or machine paths'); process.exit(0); }
console.log('');
for (const [f, why] of violations) console.log('  BLOCKED  ' + f + '  (' + why + ')');
console.log('');
console.log('  Publish refused. Fix the file or exclude it via package.json "files".');
process.exit(1);
