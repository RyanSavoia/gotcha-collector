'use strict';
// `gotcha doctor` -- what a stranger runs when something is off.
// Every failure prints the command that fixes it.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const paths = require('../paths');
const config = require('../config');
const schedule = require('../schedule');
const repos = require('../repos');
const table = require('../table');
const budget = require('../budget');

function run(argv, flags) {
  let problems = 0;
  const ok = (m) => console.log('  ok    ' + m);
  const bad = (m, fix) => { problems++; console.log('  FAIL  ' + m); if (fix) console.log('        fix: ' + fix); };
  const warn = (m, fix) => { console.log('  warn  ' + m); if (fix) console.log('        fix: ' + fix); };

  console.log('gotcha doctor');
  console.log('');

  // --- runtime -------------------------------------------------------------
  console.log('[runtime]');
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 14) ok('node ' + process.versions.node + ' at ' + paths.nodeBin());
  else bad('node ' + process.versions.node + ' is too old (need >= 14)', 'install a newer node');
  try {
    const v = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
    ok('claude CLI present (' + v.split('\n')[0] + ')');
  } catch (e) {
    bad('the `claude` CLI is not on PATH — every model call goes through it',
      'install Claude Code: https://claude.com/claude-code');
  }

  // --- config --------------------------------------------------------------
  console.log('');
  console.log('[config]');
  if (!config.exists()) bad('no config at ' + paths.CONFIG_FILE.replace(paths.HOME, '~'), 'gotcha init');
  else ok('config at ' + paths.CONFIG_FILE.replace(paths.HOME, '~'));
  const cfg = config.load();
  if (!cfg.repos.length) bad('no repos configured', 'gotcha init --repo /path/to/repo');
  else {
    const missing = cfg.repos.filter((r) => !repos.isRepo(repos.expand(r)));
    if (missing.length) bad(missing.length + ' configured repo(s) are not git repos: ' + missing.join(', '), 'gotcha init --repo ...');
    else ok(cfg.repos.length + ' repo(s) tracked: ' + cfg.repos.map((r) => path.basename(r)).join(', '));
  }
  if (cfg.auth.mode === 'apiKey') {
    const key = config.apiKey();
    if (!key) bad('auth mode is apiKey but no key is stored', 'gotcha init --api-key sk-...');
    else {
      let mode = '';
      try { mode = (fs.statSync(paths.CREDENTIALS_FILE).mode & 0o777).toString(8); } catch (e) { mode = '?'; }
      if (mode !== '600') warn('credentials file mode is ' + mode + ', expected 600', 'chmod 600 ' + paths.CREDENTIALS_FILE);
      else ok('API key stored, mode 600');
    }
  } else ok('auth: using the machine\'s `claude` login (no key stored)');

  // --- a cheap live call ----------------------------------------------------
  if (!flags.offline) {
    console.log('');
    console.log('[model access]');
    const t = Date.now();
    try {
      const out = execFileSync('claude', ['-p', 'Reply with the single word OK.', '--model', cfg.models.harvest,
        '--output-format', 'json', '--no-session-persistence'],
        { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
      const j = JSON.parse(out);
      if (j.is_error) bad('the model call returned an error', 'check your auth: claude login');
      else ok('model reachable (' + cfg.models.harvest + ', ' + ((Date.now() - t) / 1000).toFixed(1) + 's, $' +
        (j.total_cost_usd || 0).toFixed(4) + ')');
    } catch (e) {
      bad('could not reach the model', 'claude login   (or: gotcha init --api-key ...)');
    }
  }

  // --- schedules -----------------------------------------------------------
  console.log('');
  console.log('[schedule]');
  for (const a of schedule.status()) {
    if (!a.installed) bad(a.id + ' agent not installed', 'gotcha init');
    else if (!a.loaded) bad(a.id + ' installed but not loaded', 'launchctl load ' + schedule.plistPath(a.id));
    else ok(a.id + ' — ' + a.desc);
  }

  // --- hooks ---------------------------------------------------------------
  console.log('');
  console.log('[hooks]');
  const cc = path.join(paths.HOME, '.claude', 'settings.json');
  let ccOk = false;
  try {
    const s = JSON.parse(fs.readFileSync(cc, 'utf8'));
    ccOk = JSON.stringify(s.hooks || {}).indexOf('gotcha-hook.js') !== -1;
  } catch (e) { ccOk = false; }
  ccOk ? ok('Claude Code PreToolUse hook registered') : warn('Claude Code hook not registered', 'gotcha hooks install');
  const cur = path.join(paths.HOME, '.cursor', 'hooks.json');
  let curOk = false;
  try { curOk = fs.readFileSync(cur, 'utf8').indexOf('gotcha-hook.js') !== -1; } catch (e) { curOk = false; }
  curOk ? ok('Cursor beforeShellExecution hook registered') : warn('Cursor hook not registered', 'gotcha hooks install');

  const idx = path.join(paths.DATA_DIR, 'hook-index.json');
  if (fs.existsSync(idx)) {
    // Prove it actually fires rather than merely being configured.
    try {
      const probe = execFileSync(paths.nodeBin(), [path.join(paths.installRoot(), 'scripts', 'gotcha-hook.js')], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo probe' } }),
        encoding: 'utf8', timeout: 5000,
      });
      JSON.parse(probe || '{}');
      ok('hook executes and returns valid JSON');
    } catch (e) { bad('the hook script failed to run', 'node ' + path.join(paths.installRoot(), 'scripts', 'gotcha-hook.js')); }
  } else warn('no hook index built yet', 'gotcha hooks install');

  // --- data ----------------------------------------------------------------
  console.log('');
  console.log('[data]');
  const found = cfg.repos.length ? table.findFor(repos.expand(cfg.repos[0])) : null;
  if (found) {
    try { ok(table.loadFound(found).facts.length + ' facts readable'); }
    catch (e) { bad('the fact table did not parse: ' + e.message, 'check repo-truth/facts.yaml'); }
  } else warn('no fact table found yet', 'gotcha audit <repo> to draft one, or gotcha install <repo>');
  const b = budget.status(cfg.budget.dailyUsd);
  ok('budget today: $' + b.spentUsd.toFixed(4) + ' of $' + b.cap.toFixed(2));

  console.log('');
  console.log(problems ? '  ' + problems + ' problem(s) found.' : '  All good.');
  return problems ? 1 : 0;
}

module.exports = { run };
