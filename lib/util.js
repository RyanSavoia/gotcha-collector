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
const VALUE_FLAGS = new Set(['root', 'report', 'repo', 'since', 'limit', 'model', 'out', 'max-chunks', 'org', 'domain', 'tool', 'facts', 'save-prompts', 'baseline', 'max', 'repo-name', 'changed', 'comment-file', 'base', 'branch', 'gotcha-repo', 'file', 'project', 'model']);

module.exports = { writeFileAtomic, sha12, today, parseArgs };
