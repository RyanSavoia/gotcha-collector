'use strict';
const os = require('os');
// Configuration. Every machine-specific value lives here or is derived at runtime;
// nothing about one user's laptop may be compiled into the tool.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

class ConfigError extends Error {}

function expandHome(p) {
  return p.indexOf('~') === 0 ? path.join(os.homedir(), p.slice(1)) : p;
}

const DEFAULTS = {
  // Repos gotcha tracks. Absolute paths or ~-relative. `gotcha init` fills this in;
  // empty means "nothing configured yet", not "use mine".
  repos: [],
  // Which repo holds repo-truth/. Empty => the first tracked repo that has one.
  factsRepo: '',
  // GitHub org/owner, used only for `gotcha audit --org` and generated workflows.
  githubOwner: '',
  // Where CI fetches gotcha itself from, for generated workflows.
  gotchaRepo: '',
  gotchaRef: 'v1',
  // Absolute path to the `claude` binary used for extraction. Recorded by
  // `gotcha init` under a LOGIN shell, because scheduled runs (launchd, cron)
  // inherit a bare PATH and cannot find it on their own.
  extractor_bin: '',
  models: {
    harvest: 'haiku',                // fast + cheap: generating candidates at volume
    examiner: 'sonnet',              // stronger + DIFFERENT: auditing a clean claim
    coherence: 'haiku',
  },
  auth: {
    // 'cli'    — use the machine's existing `claude` login (no key stored)
    // 'apiKey' — use a key from credentials.json, exported per call
    mode: 'cli',
    provider: 'anthropic',
  },
  gauntlet: {
    maxRunsPerBatch: 20,
    examinerTimeoutMs: 300000,
    earlyTriggerCount: 15,
  },
  harvest: {
    graceMs: 120000,
    limit: 40,
  },
  budget: { dailyUsd: 5 },
  db: { envFile: '', statementTimeoutMs: 15000, enabled: false },
  // Directories the examiner may read. Empty => the tracked repos.
  examinerDirs: [],
};

function deepMerge(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over)) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) out[k] = deepMerge(base[k] || {}, over[k]);
    else if (over[k] !== undefined) out[k] = over[k];
  }
  return out;
}

function legacyFile() {
  // A pre-XDG install kept config beside the code. Read it so upgrading does not
  // silently reset someone's settings.
  return path.join(paths.installRoot(), 'config.json');
}

function load() {
  let user = null;
  for (const p of [paths.CONFIG_FILE, legacyFile()]) {
    try { user = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch (e) { /* try next */ }
  }
  const cfg = deepMerge(DEFAULTS, user);
  if (!cfg.examinerDirs.length) cfg.examinerDirs = cfg.repos.slice();
  return cfg;
}

/**
 * Absolute path to the repo holding repo-truth/, or a hard error.
 *
 * Seven call sites used to fall back to `~/user-dashboard-main` -- the author's own
 * directory name, compiled into the tool. On anyone else's machine that silently
 * resolved to nothing, and the command reported "no on-disk fact table" as though
 * the user had configured something wrong. A missing config is a setup error and
 * must say so, by name, once.
 */
function factsRepo(cfg) {
  const c = cfg || load();
  const raw = process.env.GOTCHA_FACTS_REPO || c.factsRepo;
  if (!raw) {
    throw new ConfigError(
      'no facts repo configured.\n' +
      '  gotcha needs to know which repo holds repo-truth/facts.yaml.\n' +
      '  Fix: gotcha init --facts-repo /path/to/repo');
  }
  const abs = path.resolve(expandHome(String(raw)));
  if (!fs.existsSync(abs)) {
    throw new ConfigError(
      'the configured facts repo does not exist: ' + abs + '\n' +
      '  Fix: gotcha init --facts-repo /path/to/repo');
  }
  return abs;
}

/** Where the fact table itself lives inside that repo. */
function factsPath(cfg) {
  return path.join(factsRepo(cfg), 'repo-truth', 'facts.yaml');
}

function save(cfg) {
  fs.mkdirSync(paths.CONFIG_DIR, { recursive: true });
  fs.writeFileSync(paths.CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  return paths.CONFIG_FILE;
}

function exists() {
  try { fs.accessSync(paths.CONFIG_FILE); return true; } catch (e) { return false; }
}

/** API key, if the user chose key auth. Never logged, never written to a repo. */
function apiKey() {
  try {
    const c = JSON.parse(fs.readFileSync(paths.CREDENTIALS_FILE, 'utf8'));
    return c.apiKey || '';
  } catch (e) { return ''; }
}

function saveApiKey(key) {
  fs.mkdirSync(paths.CONFIG_DIR, { recursive: true });
  fs.writeFileSync(paths.CREDENTIALS_FILE, JSON.stringify({ apiKey: key }, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(paths.CREDENTIALS_FILE, 0o600); } catch (e) { /* best effort */ }
  return paths.CREDENTIALS_FILE;
}

module.exports = {
  factsRepo, factsPath, ConfigError, load, save, exists, apiKey, saveApiKey, DEFAULTS };
