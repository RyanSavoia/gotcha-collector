'use strict';
// Where gotcha keeps things on ANY machine.
//
// Config and credentials follow XDG so a fresh install writes somewhere predictable
// and never inside a repo. Data (candidates, state, logs) is separate from config so
// a user can back up or wipe either independently.
//
// Nothing here may hardcode a username, a home directory, or an interpreter path --
// that is what made the first version of this tool unshippable.

const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = os.homedir();

function xdg(envVar, fallback) {
  const v = process.env[envVar];
  return v && path.isAbsolute(v) ? v : path.join(HOME, fallback);
}

// GOTCHA_HOME overrides everything: one switch for tests and for a second profile.
const OVERRIDE = process.env.GOTCHA_HOME ? path.resolve(process.env.GOTCHA_HOME) : null;

const CONFIG_DIR = OVERRIDE || path.join(xdg('XDG_CONFIG_HOME', '.config'), 'gotcha');
const DATA_DIR = OVERRIDE || path.join(xdg('XDG_DATA_HOME', path.join('.local', 'share')), 'gotcha');

const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json');

/** The node binary running this process — never a guessed path. */
function nodeBin() { return process.execPath; }

/** Absolute path to the installed gotcha CLI entry point. */
function cliPath() { return path.join(__dirname, '..', 'bin', 'gotcha'); }

/** The gotcha install root (works from npm global, a clone, or a curl install). */
function installRoot() { return path.join(__dirname, '..'); }

function ensureDirs() {
  for (const d of [CONFIG_DIR, DATA_DIR, path.join(DATA_DIR, 'candidates'),
    path.join(DATA_DIR, 'disputed'), path.join(DATA_DIR, 'logs')]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

module.exports = {
  HOME, CONFIG_DIR, DATA_DIR, CONFIG_FILE, CREDENTIALS_FILE,
  nodeBin, cliPath, installRoot, ensureDirs,
};
