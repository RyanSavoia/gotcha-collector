'use strict';
const fs = require('fs');
const crypto = require('crypto');

// writeFileAtomic + sha12 adapted from code-recall (MIT) -- see ATTRIBUTION.md.
function writeFileAtomic(file, content) {
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* best effort */ }
    throw e;
  }
}

function sha12(text) {
  const norm = String(text).replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 12);
}

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** Minimal flag parser: --key value, --key=value, --bool. */
function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.indexOf('--') === 0) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && next.indexOf('--') !== 0 && VALUE_FLAGS.has(key)) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}
// Flags that take a VALUE. A flag missing from here is parsed as a boolean, so
// `--facts-repo /path` sets it to `true` and the path becomes a stray argument.
// That has now shipped three times -- `--org` once queried a real GitHub org
// literally named "true", and `--facts-repo` silently resolved to
// "<cwd>/true" during a clean-account install. test/run.sh asserts that every
// flag read anywhere in lib/ appears in exactly one of these two sets, so a new
// flag has to be declared rather than defaulting to the wrong answer.
const VALUE_FLAGS = new Set([
  'root', 'report', 'repo', 'since', 'limit', 'model', 'out', 'max-chunks', 'org',
  'domain', 'tool', 'facts', 'save-prompts', 'baseline', 'max', 'repo-name',
  'changed', 'comment-file', 'base', 'branch', 'gotcha-repo', 'file', 'project',
  'facts-repo', 'api-key', 'auth', 'budget', 'owner',
]);

// Flags that are presence-only. Listed explicitly so the guard above can tell
// "deliberately boolean" from "someone forgot".
const BOOLEAN_FLAGS = new Set([
  'dry-run', 'yes', 'force', 'json', 'quiet', 'verbose', 'incremental', 'all',
  'no-verify', 'debug', 'help', 'strict', 'apply', 'list', 'write', 'open',
  'install', 'print', 'auto', 'no-schedule', 'no-hooks', 'fix', 'github-action',
  'no-db', 'no-session-start', 'offline', 'purge', 'touch',
]);

module.exports = { writeFileAtomic, sha12, today, parseArgs, VALUE_FLAGS, BOOLEAN_FLAGS };
