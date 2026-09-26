'use strict';
// Parser/writer for the restricted facts.yaml layout that repo-truth/verify.sh
// accepts. Deliberately NOT a general YAML implementation: verify.sh parses this
// file with plain bash and no YAML dependency, so anything we write has to stay
// inside the same narrow grammar or CI stops being able to read it.
//
// Every fact records the line range it came from, so an edit splices those lines
// and leaves the rest of the file byte-identical. A full parse-and-re-emit would
// reflow quoting and comments and produce an enormous, unreviewable diff on a file
// whose whole purpose is human review.

const fs = require('fs');
const path = require('path');

const ID_RE = /^[a-z0-9][a-z0-9-]+$/;
const STATUSES = ['verified', 'verified-runtime', 'human-asserted', 'failed'];
// Scalar fields verify.sh tolerates beyond the six required ones. Anything else is
// a schema error there (`unsupported YAML field or indentation`), so we refuse it
// here too rather than writing a file that fails CI.
const OPTIONAL_FIELDS = ['note', 'resolution', 'recheck', 'open_decision', 'provenance', 'counterexample', 'enforce'];
// Bookkeeping fields that exist only in candidate files, never in a real table.
const CANDIDATE_FIELDS = ['source', 'refines', 'promoted', 'gauntlet'];
const REQUIRED_FIELDS = ['claim', 'scope', 'evidence', 'check', 'status', 'verified_at'];

class FactsError extends Error {}

/**
 * JSON-quote a string, escaping non-ASCII as \uXXXX. The existing file is written
 * ASCII-only (an en-dash appears as \u2013), and matching that keeps a re-rendered
 * fact byte-identical to a hand-written one — so an edit diff shows only the fact
 * that actually changed.
 */
function jsonAscii(value) {
  return JSON.stringify(String(value)).replace(/[\u007f-\uffff]/g, (ch) =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Encode a string the way the existing file does: JSON double-quoted, one line. */
function encodeScalar(value) {
  return jsonAscii(String(value).replace(/\s+/g, ' ').trim());
}

/** Encode a scope/evidence list as a JSON inline array, as the existing file does. */
function encodeList(values) {
  return '[' + values.map((v) => jsonAscii(String(v))).join(', ') + ']';
}

function decodeMaybe(raw) {
  const text = raw.trim();
  if (!text) return text;
  try { return JSON.parse(text); } catch (e) { return text; }
}

/**
 * Parse facts.yaml into { lines, header, facts }.
 * Each fact: { id, claim, scope[], evidence[], check, status, verified_at, note?,
 *              start, end }  — start/end are inclusive indices into `lines`.
 */
function parse(text, opts) {
  const strict = !(opts && opts.strict === false);
  const lines = text.split('\n');
  const facts = [];
  let current = null;
  let inCheck = false;

  const finish = (endIdx) => {
    if (!current) return;
    // Trailing blank lines belong to the file, not to the fact; keeping them out of
    // the range means a spliced edit cannot swallow the file's final newline.
    while (endIdx > current.start && lines[endIdx].trim() === '') endIdx--;
    current.end = endIdx;
    current.check = current.checkLines.join('\n');
    if (current.check && !/\n$/.test(current.check)) current.check += '\n';
    delete current.checkLines;
    if (strict) {
      for (const field of REQUIRED_FIELDS) {
        if (current[field] === undefined || current[field] === null || current[field] === '') {
          throw new FactsError('fact ' + current.id + ': missing required field ' + field);
        }
      }
      if (STATUSES.indexOf(current.status) === -1) {
        throw new FactsError('fact ' + current.id + ': invalid status ' + JSON.stringify(current.status));
      }
    }
    facts.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf('  - id: ') === 0) {
      finish(i - 1);
      const id = line.slice('  - id: '.length).trim();
      if (strict && !ID_RE.test(id)) throw new FactsError('invalid id: ' + JSON.stringify(id));
      current = { id, scope: [], evidence: [], check: '', start: i, end: i, checkLines: [], optionalOrder: [] };
      inCheck = false;
      continue;
    }
    if (!current) continue;

    if (inCheck) {
      if (line.indexOf('      ') === 0 || line === '') {
        // A blank line inside a block scalar belongs to the block; verify.sh would
        // end the block, so we end it too and let the blank fall through.
        if (line !== '') { current.checkLines.push(line.slice(6)); continue; }
      }
      inCheck = false;
    }

    if (line === '    check: |') { inCheck = true; current.checkLineIdx = i; continue; }

    const m = /^    ([a-z_]+): (.*)$/.exec(line);
    if (m) {
      const key = m[1];
      const raw = m[2];
      if (key === 'scope' || key === 'evidence') {
        current[key] = decodeMaybe(raw);
        current[key + 'LineIdx'] = i;
      } else if (CANDIDATE_FIELDS.indexOf(key) !== -1) {
        current[key] = decodeMaybe(raw);
      } else if (REQUIRED_FIELDS.indexOf(key) !== -1 || OPTIONAL_FIELDS.indexOf(key) !== -1) {
        current[key] = decodeMaybe(raw);
        current[key + 'LineIdx'] = i;
        if (OPTIONAL_FIELDS.indexOf(key) !== -1) current.optionalOrder.push(key);
      } else if (strict) {
        throw new FactsError('fact ' + current.id + ': unsupported field ' + key);
      }
      continue;
    }
    if (line.trim() === '' || line.trim().charAt(0) === '#') continue;
    if (strict && /^ {4}\S/.test(line)) {
      throw new FactsError('fact ' + current.id + ': unsupported YAML line: ' + line);
    }
  }
  finish(lines.length - 1);

  const seen = Object.create(null);
  for (const f of facts) {
    if (seen[f.id]) throw new FactsError('duplicate id: ' + f.id);
    seen[f.id] = true;
  }

  const headerEnd = facts.length ? facts[0].start - 1 : lines.length - 1;
  return { lines, facts, header: lines.slice(0, headerEnd + 1).join('\n') };
}

/** Render one fact as the block of lines the existing file uses. */
function render(fact) {
  const out = ['  - id: ' + fact.id];
  out.push('    claim: ' + encodeScalar(fact.claim));
  out.push('    scope: ' + encodeList(fact.scope));
  out.push('    evidence: ' + encodeList(fact.evidence));
  out.push('    check: |');
  const check = String(fact.check).replace(/\n+$/, '');
  for (const l of check.split('\n')) out.push('      ' + l);
  out.push('    status: ' + fact.status);
  out.push('    verified_at: ' + jsonAscii(fact.verified_at));
  // Preserve the order these fields appeared in, so re-rendering an untouched fact
  // reproduces it exactly; fields newly added by us are appended in canonical order.
  const order = (fact.optionalOrder || []).slice();
  for (const field of OPTIONAL_FIELDS) if (order.indexOf(field) === -1) order.push(field);
  for (const field of order) {
    if (fact[field]) out.push('    ' + field + ': ' + encodeScalar(fact[field]));
  }
  return out;
}

const SCALAR_UPDATABLE = ['status', 'verified_at'].concat(OPTIONAL_FIELDS);

/**
 * Apply per-fact field updates, rewriting ONLY the lines whose field changed.
 *
 * Deliberately not "re-render the whole fact": a fact may legitimately be written
 * in a style we would render differently (raw UTF-8 rather than \uXXXX escapes, say),
 * and rewriting untouched lines would put cosmetic noise in a diff whose entire
 * purpose is to show a human what changed about the truth.
 *
 * updates: obj of id -> { status?, verified_at?, note?, ... } (scalar fields only).
 */
function applyUpdates(text, updates) {
  const doc = parse(text, { strict: false });
  const lines = doc.lines.slice();
  // Bottom-up so earlier line indices stay valid as we splice.
  const targets = doc.facts
    .filter((f) => Object.prototype.hasOwnProperty.call(updates, f.id))
    .sort((a, b) => b.start - a.start);

  for (const fact of targets) {
    const update = updates[fact.id] || {};
    for (const key of Object.keys(update)) {
      if (SCALAR_UPDATABLE.indexOf(key) === -1) {
        throw new FactsError('fact ' + fact.id + ': ' + key + ' is not updatable in place');
      }
    }
    const block = lines.slice(fact.start, fact.end + 1);
    const offset = fact.start;
    const appended = [];
    for (const key of Object.keys(update)) {
      const value = key === 'status' ? String(update[key]) : encodeScalar(update[key]);
      const line = '    ' + key + ': ' + value;
      const idx = fact[key + 'LineIdx'];
      if (typeof idx === 'number') block[idx - offset] = line;
      else appended.push(line);
    }
    if (appended.length) block.push.apply(block, appended);
    lines.splice(fact.start, fact.end - fact.start + 1, ...block);
  }
  return lines.join('\n');
}

function factsPathFor(repoPath) {
  return path.join(repoPath, 'repo-truth', 'facts.yaml');
}

function load(factsPath, opts) {
  if (!fs.existsSync(factsPath)) {
    throw new FactsError('no fact table at ' + factsPath);
  }
  return parse(fs.readFileSync(factsPath, 'utf8'), opts);
}

module.exports = {
  parse, render, applyUpdates, load, factsPathFor,
  encodeScalar, encodeList,
  STATUSES, REQUIRED_FIELDS, OPTIONAL_FIELDS, CANDIDATE_FIELDS, ID_RE, FactsError,
};
