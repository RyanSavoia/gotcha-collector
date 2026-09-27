'use strict';
// `gotcha init` -- first run on a fresh machine.
//
// Interactive by default, fully flag-drivable for scripting. Idempotent: running it
// twice repairs (rewrites plists, re-merges hook entries) rather than duplicating.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const paths = require('../paths');
const config = require('../config');
const schedule = require('../schedule');
const repos = require('../repos');
const extractor = require('../extractor');
const scaffold = require('../scaffold');

function ask(rl, question, fallback) {
  return new Promise((resolve) => {
    rl.question(question + (fallback ? ' [' + fallback + ']' : '') + ' ', (a) => {
      resolve((a || '').trim() || fallback || '');
    });
  });
}

/** Is the machine's `claude` CLI already logged in? Then no key is needed. */
function cliAuthed() {
  try {
    const out = execFileSync('claude', ['-p', 'say OK', '--model', 'haiku', '--output-format', 'json',
      '--no-session-persistence'], { encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'ignore'] });
    const j = JSON.parse(out);
    return !j.is_error;
  } catch (e) { return false; }
}

function haveClaudeCli() {
  try { execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 10000 }); return true; }
  catch (e) { return false; }
}

async function run(argv, flags) {
  const interactive = !flags.yes && process.stdin.isTTY;
  const cfg = config.load();
  console.log('gotcha init');
  console.log('');

  // --- repos ---------------------------------------------------------------
  let repoList = [];
  if (flags.repo) repoList = String(flags.repo).split(',').map((s) => s.trim()).filter(Boolean);
  else if (argv.length) repoList = argv.slice();
  else if (cfg.repos.length) repoList = cfg.repos.slice();

  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    if (!repoList.length && rl) {
      const here = process.cwd();
      const guess = repos.isRepo(here) ? here : '';
      const a = await ask(rl, 'Repos to track (comma-separated paths):', guess);
      repoList = a.split(',').map((s) => s.trim()).filter(Boolean);
    }
    repoList = repoList.map((r) => path.resolve(repos.expand(r)));
    const good = repoList.filter(repos.isRepo);
    const bad = repoList.filter((r) => !repos.isRepo(r));
    for (const b of bad) console.log('  skipping (not a git repo): ' + b);

    // --- auth --------------------------------------------------------------
    let authMode = flags.auth || cfg.auth.mode;
    let key = flags['api-key'] || '';
    if (!flags.auth && !key) {
      if (!haveClaudeCli()) {
        console.log('  the `claude` CLI is not installed — gotcha calls it for every model request.');
        console.log('  install it first: https://claude.com/claude-code');
        if (!flags.force) return 2;
      }
      const authed = haveClaudeCli() && cliAuthed();
      if (authed) {
        authMode = 'cli';
        console.log('  auth: using this machine\'s existing `claude` login (no key stored)');
      } else if (rl) {
        console.log('  the `claude` CLI is not logged in.');
        const a = await ask(rl, '  Paste an Anthropic API key (or press enter to run `claude login` yourself):', '');
        if (a) { authMode = 'apiKey'; key = a; }
      }
    }
    if (key) {
      const p = config.saveApiKey(key);
      const mode = (fs.statSync(p).mode & 0o777).toString(8);
      console.log('  key stored at ' + p.replace(paths.HOME, '~') + ' (mode ' + mode + ')');
      authMode = 'apiKey';
    }

    // --- repo-truth scaffolding --------------------------------------------
    // Without this a fresh install has no fact table and no verifier, and the
    // gauntlet rolls every batch back against whatever verify.sh it can find.
    try {
      const names = good.map((r) => path.basename(r));
      const factsRepoPath = flags['facts-repo']
        ? path.resolve(repos.expand(String(flags['facts-repo'])))
        : (good[0] || '');
      if (factsRepoPath) {
        const made = scaffold.ensure(factsRepoPath, names);
        if (made.created.length) {
          console.log('  scaffolded in ' + path.basename(factsRepoPath) + ': ' + made.created.join(', '));
          console.log('    verifier is written against: ' + names.join(' '));
        } else {
          console.log('  repo-truth/ already present in ' + path.basename(factsRepoPath) + ' — left alone');
        }
      }
    } catch (e) {
      console.log('  could not scaffold repo-truth/: ' + e.message);
    }

    // --- extractor binary --------------------------------------------------
    // Must happen while we still have the owner's environment. A scheduled run
    // does not: launchd hands the job /usr/bin:/bin and nothing else.
    const extractorBin = extractor.discover() || '';
    if (extractorBin) {
      console.log('  extractor: ' + extractorBin);
    } else {
      console.log('  extractor: NOT FOUND — harvest cannot extract until `claude` is installed.');
      console.log('             Install Claude Code, then re-run `gotcha init`.');
    }

    // --- models + budget ---------------------------------------------------
    let examiner = flags.model || cfg.models.examiner;
    let daily = flags.budget !== undefined ? parseFloat(flags.budget) : cfg.budget.dailyUsd;
    if (rl && !flags.model) examiner = await ask(rl, 'Examiner model (audits claims; stronger is better):', examiner);
    if (rl && flags.budget === undefined) {
      const a = await ask(rl, 'Daily token budget in USD:', String(daily));
      const n = parseFloat(a);
      if (!Number.isNaN(n)) daily = n;
    }

    const next = Object.assign({}, cfg, {
      repos: good,
      factsRepo: flags['facts-repo'] ? path.resolve(repos.expand(String(flags['facts-repo']))) : (cfg.factsRepo || good[0] || ''),
      githubOwner: flags.owner || cfg.githubOwner || '',
      gotchaRepo: flags['gotcha-repo'] || cfg.gotchaRepo || '',
      // Resolved here, once, under a login shell. Scheduled runs get a bare PATH,
      // so a bare `claude` is unfindable from launchd -- and a failed spawn used to
      // look exactly like "found nothing", quietly consuming transcript content.
      extractor_bin: extractorBin,
      auth: Object.assign({}, cfg.auth, { mode: authMode }),
      models: Object.assign({}, cfg.models, { examiner }),
      budget: Object.assign({}, cfg.budget, { dailyUsd: daily }),
      examinerDirs: good,
    });
    const saved = config.save(next);
    paths.ensureDirs();
    console.log('  config written to ' + saved.replace(paths.HOME, '~'));
    console.log('  tracking ' + good.length + ' repo(s): ' + good.map((r) => path.basename(r)).join(', '));

    // --- schedules ---------------------------------------------------------
    if (!flags['no-schedule']) {
      console.log('');
      console.log('  schedules (launchd — your crontab is not touched):');
      for (const a of schedule.install()) {
        console.log('    ' + String(a.result).padEnd(9) + (a.loaded ? 'loaded  ' : 'NOT LOADED  ') + a.id + '  — ' + a.desc);
      }
    }

    // --- hooks -------------------------------------------------------------
    if (!flags['no-hooks']) {
      console.log('');
      console.log('  agent hooks:');
      const hooks = require('./hooks');
      hooks.run(['install'], { quiet: true });
    }

    console.log('');
    console.log('  Done. Next:');
    console.log('    gotcha install <repo>   # pointer files so agents find the fact table');
    console.log('    gotcha doctor           # check everything is wired');
    return 0;
  } finally { if (rl) rl.close(); }
}

module.exports = { run, cliAuthed, haveClaudeCli };
