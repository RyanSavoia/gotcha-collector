'use strict';
// Baseline diff for `gotcha verify --baseline <path>`.
//
// The problem this solves: verify.sh treats `failed` as an ALREADY-RECORDED disproven
// claim that does not fail the build. So the moment a regression is written down, the
// weekly run goes green -- the regression is recorded and simultaneously silenced, and
// nobody is told the day it happened.
//
// A baseline stores the previous run's outcome per fact. CI then fails when an outcome
// got WORSE than last time, and stays green on failures that were already known. A
// regression is loud exactly once, on the run where it appears.
//
// Deliberately NOT part of the default path: with no --baseline, verify behaves
// exactly as verify.sh does, byte for byte.

const fs = require('fs');
const { writeFileAtomic } = require('./util');

const VERSION = 1;

function read(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.facts) return null;
    return parsed;
  } catch (e) { return null; }      // missing or corrupt: treated as "seed me"
}

function write(file, outcomes) {
  const facts = {};
  for (const o of outcomes) facts[o.id] = { status: o.status, rc: o.rc, label: o.label };
  writeFileAtomic(file, JSON.stringify({
    version: VERSION,
    generated: new Date().toISOString(),
    facts,
  }, null, 2) + '\n');
}

/**
 * Did this fact get worse than the baseline said?
 *
 * Worse means either of the things a reader would call a new problem:
 *   - a check that used to pass now fails
 *   - a claim that used to be trusted is now recorded as disproven (verified -> failed)
 *
 * Not worse: a fact that was already failing and still is (that is the acknowledged
 * state, and re-reporting it every week is how alert fatigue starts).
 */
function worse(prev, cur) {
  if (!prev) {
    // Unknown to the baseline. A brand-new fact that already fails is a real problem;
    // a new fact recorded as `failed` is someone documenting a known issue, not a regression.
    return cur.rc !== 0 && cur.status !== 'failed' && cur.status !== 'human-asserted' && cur.status !== 'verified-runtime';
  }
  if (prev.rc === 0 && cur.rc !== 0) return true;                       // check stopped passing
  if (prev.status !== 'failed' && cur.status === 'failed') return true; // trusted -> disproven
  return false;
}

/** Facts whose outcome improved, for reporting (not for exit status). */
function better(prev, cur) {
  if (!prev) return false;
  if (prev.rc !== 0 && cur.rc === 0) return true;
  if (prev.status === 'failed' && cur.status !== 'failed') return true;
  return false;
}

/**
 * Compare this run's outcomes against a baseline.
 * Returns { seeded, regressions[], recoveries[], dropped[] }.
 */
function compare(baseline, outcomes) {
  if (!baseline) return { seeded: true, regressions: [], recoveries: [], dropped: [] };
  const prevFacts = baseline.facts || {};
  const regressions = [];
  const recoveries = [];
  const seen = new Set();
  for (const cur of outcomes) {
    seen.add(cur.id);
    const prev = prevFacts[cur.id] || null;
    if (worse(prev, cur)) regressions.push({ cur, prev });
    else if (better(prev, cur)) recoveries.push({ cur, prev });
  }
  const dropped = Object.keys(prevFacts).filter((id) => !seen.has(id));
  return { seeded: false, regressions, recoveries, dropped };
}

function describe(entry) {
  const { cur, prev } = entry;
  const from = prev ? prev.label + ' (exit ' + prev.rc + ')' : 'not in baseline';
  return cur.id + ': ' + from + ' -> ' + cur.label + ' (exit ' + cur.rc + ')';
}

module.exports = { read, write, compare, worse, better, describe, VERSION };
