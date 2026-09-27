'use strict';
// Runs a fact's `check` with the same helpers and the same shell semantics as
// repo-truth/verify.sh. Node owns parsing, status transitions and reporting --
// the things bash cannot do well; bash keeps owning check execution -- the thing
// it already does correctly. See DECISION.md.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PREAMBLE_PATH = path.join(__dirname, 'verify-preamble.sh');

// verify.sh's labelling, reproduced exactly (its run_fact()).
const LABELS = {
  verified: (rc) => (rc === 0 ? 'PASS' : 'FAIL'),
  'verified-runtime': () => 'RUNTIME-NOT-RECHECKED',
  'human-asserted': () => 'HUMAN-ASSERTED',
  failed: (rc) => (rc === 0 ? 'RECOVERED' : 'KNOWN-FAIL'),
};

/** A label that means "this fact's claim is currently contradicted by the tree". */
function isRegression(status, rc) {
  return status === 'verified' && rc !== 0;
}

/**
 * Evaluate one check. Returns { rc, output }.
 * `output` is combined stdout+stderr, exactly what verify.sh captures and emits.
 */
function runCheck(check, opts) {
  const root = opts.root;
  const here = opts.here;
  const timeout = opts.timeout || 120000;
  // `set -uo pipefail` then source the helpers, then eval the check -- the same
  // sequence verify.sh uses. The check runs in a subshell so a stray `exit` or
  // `cd` in one check cannot affect the next.
  //
  // `set -e` INSIDE that subshell is load-bearing. Without it a multi-line check
  // reports only its LAST line's status: every earlier assertion prints its failure
  // and is then discarded. A five-line check was really a one-line check with four
  // comments. Found 2026-09-26 by mutating the line a check was built to catch and
  // watching the fact still pass.
  const script =
    'set -uo pipefail\n' +
    'ROOT=$GOTCHA_ROOT\n' +
    'HERE=$GOTCHA_HERE\n' +
    '. "$GOTCHA_PREAMBLE"\n' +
    '( set -e; eval "$GOTCHA_CHECK" ) 2>&1\n';
  let rc = 0;
  let output = '';
  try {
    output = execFileSync('bash', ['-c', script], {
      encoding: 'utf8',
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: Object.assign({}, process.env, {
        GOTCHA_ROOT: root,
        GOTCHA_HERE: here,
        GOTCHA_PREAMBLE: PREAMBLE_PATH,
        GOTCHA_CHECK: check,
      }),
    });
  } catch (err) {
    rc = typeof err.status === 'number' ? err.status : 1;
    output = (err.stdout || '') + (err.stderr || '');
    if (err.killed || err.signal) {
      rc = rc || 1;
      output += '\n[gotcha: check timed out after ' + timeout + 'ms]';
    }
  }
  return { rc, output: output.replace(/\n+$/, '') };
}

/** Label a result the way verify.sh would. */
function label(status, rc) {
  const fn = LABELS[status];
  return fn ? fn(rc) : 'UNKNOWN-STATUS';
}

/** Does this repo layout have the sidecar files the shared helpers expect? */
function sidecarsPresent(here) {
  return fs.existsSync(path.join(here, 'orphan-candidates.txt')) &&
    fs.existsSync(path.join(here, 'web-route-groups.tsv'));
}

module.exports = { runCheck, label, isRegression, PREAMBLE_PATH, sidecarsPresent };
