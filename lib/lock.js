'use strict';
// Single-holder lock for the harvest tick.
//
// A 5-minute timer and a harvest that can run for minutes will overlap. Two ticks
// racing on state.json would double-spend tokens and could advance a watermark past
// content the other is still reading. mkdir is atomic on every filesystem we care
// about, so the directory IS the lock; the pid inside lets a later tick tell a
// crashed holder from a live one.

const fs = require('fs');
const path = require('path');
const repos = require('./repos');

const LOCK_DIR = path.join(repos.GOTCHA_HOME, '.tick.lock');
const PID_FILE = path.join(LOCK_DIR, 'pid');

function holderAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Returns { ok: true, release } or { ok: false, heldBy }. */
function acquire() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(LOCK_DIR);
      fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
      return { ok: true, release };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0;
      try { pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10); } catch (e2) { pid = 0; }
      if (holderAlive(pid)) return { ok: false, heldBy: pid };
      // Holder is gone: break the lock once, then retry the mkdir.
      try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch (e2) { /* racing peer */ }
    }
  }
  return { ok: false, heldBy: 0 };
}

function release() {
  try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

module.exports = { acquire, release, LOCK_DIR, holderAlive };
