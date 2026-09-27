'use strict';
// Where is the `claude` binary?
//
// This module exists because of a silent, three-week-shaped bug. The 5-minute
// launchd tick inherits a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin) -- not the
// login shell's -- so `execFileSync('claude', ...)` died with ENOENT on every
// chunk of every tick. The harvester counted each failure as "0 candidates",
// advanced the watermarks, and reported success. Fifteen ticks consumed real
// transcript content and extracted nothing from it.
//
// So the binary is resolved ONCE, at init, under a login shell, and its absolute
// path is written to config. PATH is never trusted again.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// Where Claude Code actually installs, in rough order of likelihood.
function candidatePaths() {
  const home = os.homedir();
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.bun', 'bin', 'claude'),
    path.join(home, '.volta', 'bin', 'claude'),
    '/usr/bin/claude',
  ];
}

function isRunnable(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (e) { return false; }
}

/**
 * Ask the user's LOGIN shell where claude is. A non-login `which` inherits the
 * same broken PATH we are trying to escape, so -lc is the whole point.
 */
function askLoginShell() {
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const out = execFileSync(shell, ['-lc', 'command -v claude'], {
      encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n').pop().trim();
    if (out && isRunnable(out)) return out;
  } catch (e) { /* no login shell, or claude genuinely absent */ }
  return null;
}

/** Full search, most authoritative first. Returns an absolute path or null. */
function discover() {
  const fromShell = askLoginShell();
  if (fromShell) return fromShell;
  for (const p of candidatePaths()) if (isRunnable(p)) return p;
  return null;
}

/**
 * The path to use right now: the one recorded at init, else a live search.
 * Takes `cfg` rather than loading it, so callers that already have config
 * (and tests that fabricate one) do not pay for a second read.
 */
function resolve(cfg) {
  // An explicit override is authoritative: if the owner (or a test) pins a path, a
  // silent fallback to some other binary would hide exactly the failure they are
  // pinning it to expose.
  if (process.env.GOTCHA_EXTRACTOR_BIN) {
    const forced = process.env.GOTCHA_EXTRACTOR_BIN;
    return isRunnable(forced) ? forced : null;
  }
  const recorded = cfg && cfg.extractor_bin;
  if (recorded && isRunnable(recorded)) return recorded;
  // Recorded but gone -- a reinstall moved it. Search rather than fail; doctor
  // will tell the owner the config is stale.
  return discover();
}

module.exports = { resolve, discover, isRunnable, candidatePaths, askLoginShell };
