'use strict';
// `gotcha hooks install` -- wire the pre-action hook into each tool, idempotently.
//
// settings.json is JSON and cannot carry a marker comment, so identity comes from
// the command path itself: an entry whose command contains scripts/gotcha-hook.js is
// ours, and re-running replaces exactly that entry and nothing else. Every other
// hook, permission and setting in the file is preserved.

const fs = require('fs');
const path = require('path');
const os = require('os');
const repos = require('../repos');
const config = require('../config');
const hookindex = require('../hookindex');
const table = require('../table');
const { writeFileAtomic } = require('../util');

// Scripts ship WITH the code, so they resolve from the install root. Looking them
// up under the data dir worked only because the first install had both in one
// folder; an npm-global or XDG install separates them.
const HOOK = path.join(require('../paths').installRoot(), 'scripts', 'gotcha-hook.js');
const MATCHER = 'Bash|Edit|Write|NotebookEdit';

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function isOurs(entry) {
  return !!(entry && Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => typeof h.command === 'string' && h.command.indexOf('gotcha-hook.js') !== -1));
}

function installClaudeCode(dry) {
  const p = path.join(os.homedir(), '.claude', 'settings.json');
  const existing = readJson(p);
  if (existing === null && fs.existsSync(p)) {
    return { tool: 'claude-code', path: p, result: 'REFUSED — settings.json is not valid JSON; fix it first (a malformed file silently disables every setting in it)' };
  }
  const settings = existing || {};
  settings.hooks = settings.hooks || {};
  const list = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  const ours = {
    matcher: MATCHER,
    hooks: [{
      type: 'command',
      command: 'node ' + JSON.stringify(HOOK).slice(1, -1),
      timeout: 5,
      statusMessage: 'checking stored facts',
    }],
  };
  const before = JSON.stringify(list);
  const kept = list.filter((e) => !isOurs(e));
  kept.push(ours);
  settings.hooks.PreToolUse = kept;
  const changed = before !== JSON.stringify(kept);
  if (!dry && changed) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeFileAtomic(p, JSON.stringify(settings, null, 2) + '\n');
  }
  return { tool: 'claude-code', path: p, result: changed ? (existing ? 'updated' : 'created') : 'unchanged' };
}

const SESSION_HOOK = path.join(require('../paths').installRoot(), 'scripts', 'gotcha-session-start.js');

/**
 * Where does the hook environment find node? Cursor runs hooks with its own PATH,
 * and a bare "node" that resolves in your shell may not resolve there -- the docs
 * say verify rather than assume. So we resolve it once and write the absolute path.
 */
function resolveNode() {
  // The interpreter running this process, by definition present and correct.
  // Guessing at /opt/homebrew first was a Homebrew-on-Apple-Silicon assumption.
  return require('../paths').nodeBin();
}

/**
 * Cursor hooks.json. Schema per Cursor's hook docs:
 *   { version: 1, hooks: { <event>: [ { command, matcher?, timeout?, failClosed? } ] } }
 * Events used: beforeShellExecution (matcher runs against the whole command string)
 * and sessionStart.
 *
 * NO MATCHER is written. Matchers are JavaScript regex, not POSIX, and a matcher
 * that silently fails to match produces a hook that never fires and looks installed
 * -- the worst failure mode for this tool. The script already filters in ~79ms, so
 * filtering in the config buys nothing and can only go wrong.
 *
 * failClosed is left off deliberately: a memory tool must never be able to block
 * work by crashing.
 */
function installCursor(dry, opts) {
  const options = opts || {};
  const projectRoot = options.project ? path.resolve(repos.expand(String(options.project))) : null;
  const p = projectRoot
    ? path.join(projectRoot, '.cursor', 'hooks.json')
    : path.join(os.homedir(), '.cursor', 'hooks.json');
  const existing = readJson(p);
  if (existing === null && fs.existsSync(p)) {
    return { tool: 'cursor', path: p, result: 'REFUSED — hooks.json is not valid JSON; fix it first' };
  }
  const nodeBin = resolveNode();
  const cfg = existing || { version: 1, hooks: {} };
  cfg.version = cfg.version || 1;
  cfg.hooks = cfg.hooks || {};

  const wanted = { beforeShellExecution: [{ command: nodeBin + ' ' + HOOK, timeout: 5 }] };
  if (options.sessionStart !== false) {
    // Installed for when Cursor ships the fix. As of 2026-09-26 Cursor drops
    // sessionStart additional_context, so this reaches the agent NOWHERE today --
    // see fact cursor-sessionstart-context-dropped. The pointer files stay
    // load-bearing on Cursor; this hook is a complement, not a replacement.
    wanted.sessionStart = [{ command: nodeBin + ' ' + SESSION_HOOK, timeout: 10 }];
  }

  let changed = false;
  for (const event of Object.keys(wanted)) {
    const list = Array.isArray(cfg.hooks[event]) ? cfg.hooks[event] : [];
    const kept = list.filter((e) => !(e && typeof e.command === 'string' &&
      /gotcha-(hook|session-start)\.js/.test(e.command)));
    for (const w of wanted[event]) kept.push(w);
    if (JSON.stringify(list) !== JSON.stringify(kept)) changed = true;
    cfg.hooks[event] = kept;
  }
  if (!dry && changed) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeFileAtomic(p, JSON.stringify(cfg, null, 2) + '\n');
  }
  return {
    tool: 'cursor' + (projectRoot ? ' (project)' : ' (user)'),
    path: p,
    result: changed ? (existing ? 'updated' : 'created') : 'unchanged',
    node: nodeBin,
    events: Object.keys(wanted).join(', '),
  };
}

function run(argv, flags) {
  const sub = argv[0] || 'install';
  if (sub === 'index') {
    const found = table.findFor(config.factsRepo());
    if (!found || !found.factsPath) { console.error('gotcha hooks: no on-disk fact table to index'); return 2; }
    const idx = hookindex.write(found.factsPath);
    console.log('indexed ' + idx.facts.length + ' fact(s) -> ' + hookindex.INDEX_PATH);
    return 0;
  }
  if (sub !== 'install') { console.error('usage: gotcha hooks install [--dry-run]'); return 2; }

  if (!fs.existsSync(HOOK)) { console.error('gotcha hooks: missing ' + HOOK); return 2; }
  const found = table.findFor(config.factsRepo());
  if (!found || !found.factsPath) {
    console.error('gotcha hooks: no on-disk fact table; the hook needs an index to match against.');
    return 2;
  }
  const idx = hookindex.write(found.factsPath);

  console.log('gotcha hooks install');
  console.log('  indexed ' + idx.facts.length + ' fact(s) from ' + found.factsPath.replace(repos.HOME, '~'));
  const enforced = idx.facts.filter((f) => f.enforce);
  console.log('  enforcing (blocking): ' + enforced.length + (enforced.length ? ' — ' + enforced.map((f) => f.id).join(', ') : ' — warn-only, as shipped'));
  const cursorOpts = { project: flags.project, sessionStart: flags['no-session-start'] ? false : true };
  for (const r of [installClaudeCode(flags['dry-run']), installCursor(flags['dry-run'], cursorOpts)]) {
    console.log('  ' + String(r.result).padEnd(10) + ' ' + r.tool + '  ' + r.path.replace(repos.HOME, '~'));
    if (r.node) console.log('             node: ' + r.node + '   events: ' + r.events);
    if (r.note) console.log('             ' + r.note);
  }
  console.log('');
  console.log('  Warn-only: the hook returns allow and adds context. It blocks only for a');
  console.log('  fact you mark `enforce: "true"` by hand, and only for shell commands.');
  console.log('  Cursor reloads hooks.json on save — confirm in Settings > Hooks, or the');
  console.log('  Hooks output channel. No matcher is written: Cursor matchers are JS regex,');
  console.log('  and one that silently fails to match looks installed but never fires.');
  console.log('');
  console.log('  beforeShellExecution is the path that works today.');
  console.log('  sessionStart is installed but Cursor currently DROPS its additional_context');
  console.log('  (confirmed by Cursor staff, 2026-09-26). Nothing is injected on Cursor until');
  console.log('  that ships, so keep the CLAUDE.md / AGENTS.md / .cursor/rules pointer — it is');
  console.log('  still load-bearing there, not redundant.');
  return 0;
}

module.exports = { run, installClaudeCode, installCursor, HOOK, MATCHER };
