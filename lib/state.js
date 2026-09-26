'use strict';
// Single JSON state file. Holds harvest progress (which transcript files and how
// many bytes of each have been consumed) plus last-run timestamps. No database:
// losing this file costs a re-scan, never correctness.

const fs = require('fs');
const path = require('path');
const repos = require('./repos');
const { writeFileAtomic } = require('./util');

const STATE_PATH = path.join(repos.GOTCHA_HOME, 'state.json');

function read() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (e) {
    return { version: 1, transcripts: {}, lastHarvest: null, lastVerify: null };
  }
}

function write(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Write only the named keys, re-reading first so nothing else is clobbered.
 *
 * A harvest reads state at the start and writes it at the end, but charges the
 * budget in between -- through this module, on the same file. A plain write of the
 * stale in-memory copy silently reverted every charge, so a run could spend real
 * money and report a zero balance. Callers that own part of the state must say so
 * rather than writing the whole object back.
 */
function patch(fields) {
  const cur = read();
  for (const k of Object.keys(fields)) cur[k] = fields[k];
  write(cur);
  return cur;
}

module.exports = { read, write, patch, STATE_PATH };
