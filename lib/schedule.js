'use strict';
// launchd agents for the three schedules. All three, deliberately: editing a user's
// crontab is fragile (on this machine `crontab <file>` hangs, and a killed write
// empties it), and it is rude to mutate a file the user also hand-edits.
//
// Every path written into a plist is derived at runtime -- the node binary from
// process.execPath, the CLI from __dirname -- so an npm-global install, a clone and
// a curl install all produce correct agents.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const paths = require('./paths');

const LAUNCH_DIR = path.join(paths.HOME, 'Library', 'LaunchAgents');
const PREFIX = 'com.gotcha.';

const AGENTS = [
  { id: 'harvest-tick', args: ['harvest', '--incremental'], interval: 300,
    desc: 'every 5 min — incremental harvest (idle tick ≈100ms, no model call)' },
  { id: 'nightly-gauntlet', args: ['promote'], hour: 2, minute: 30,
    desc: 'nightly 02:30 — gauntlet batch, then digest', then: ['digest', '--quiet'] },
  { id: 'weekly-verify', args: ['verify', '--baseline', path.join(paths.DATA_DIR, 'weekly-baseline.json')],
    weekday: 1, hour: 3, minute: 15, desc: 'weekly Mon 03:15 — verify + map verify + digest',
    then: ['digest', '--quiet'] },
];

function label(id) { return PREFIX + id; }
function plistPath(id) { return path.join(LAUNCH_DIR, label(id) + '.plist'); }

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function renderPlist(agent) {
  const log = path.join(paths.DATA_DIR, 'logs', agent.id + '.log');
  const argv = [paths.nodeBin(), paths.cliPath()].concat(agent.args);
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">');
  lines.push('<plist version="1.0">');
  lines.push('<dict>');
  lines.push('  <key>Label</key><string>' + label(agent.id) + '</string>');
  lines.push('  <!-- ' + esc(agent.desc) + ' -->');
  lines.push('  <key>ProgramArguments</key>');
  lines.push('  <array>');
  for (const a of argv) lines.push('    <string>' + esc(a) + '</string>');
  lines.push('  </array>');
  if (agent.interval) {
    lines.push('  <key>StartInterval</key><integer>' + agent.interval + '</integer>');
  } else {
    lines.push('  <key>StartCalendarInterval</key>');
    lines.push('  <dict>');
    if (agent.weekday !== undefined) lines.push('    <key>Weekday</key><integer>' + agent.weekday + '</integer>');
    lines.push('    <key>Hour</key><integer>' + agent.hour + '</integer>');
    lines.push('    <key>Minute</key><integer>' + agent.minute + '</integer>');
    lines.push('  </dict>');
  }
  lines.push('  <key>RunAtLoad</key><false/>');
  lines.push('  <key>ProcessType</key><string>Background</string>');
  lines.push('  <key>LowPriorityIO</key><true/>');
  lines.push('  <key>StandardOutPath</key><string>' + esc(log) + '</string>');
  lines.push('  <key>StandardErrorPath</key><string>' + esc(log) + '</string>');
  lines.push('  <key>EnvironmentVariables</key>');
  lines.push('  <dict>');
  lines.push('    <key>PATH</key><string>' + esc(path.dirname(paths.nodeBin()) + ':/usr/bin:/bin:/usr/sbin:/sbin') + '</string>');
  if (process.env.GOTCHA_HOME) lines.push('    <key>GOTCHA_HOME</key><string>' + esc(process.env.GOTCHA_HOME) + '</string>');
  lines.push('  </dict>');
  lines.push('</dict>');
  lines.push('</plist>');
  return lines.join('\n') + '\n';
}

function launchctl(args) {
  try { execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return true; }
  catch (e) { return false; }
}

/** Idempotent: rewriting an identical plist and reloading repairs rather than duplicates. */
function install() {
  fs.mkdirSync(LAUNCH_DIR, { recursive: true });
  paths.ensureDirs();
  const out = [];
  for (const agent of AGENTS) {
    const p = plistPath(agent.id);
    const body = renderPlist(agent);
    const before = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    if (before !== body) fs.writeFileSync(p, body, 'utf8');
    launchctl(['unload', p]);
    const loaded = launchctl(['load', p]);
    out.push({ id: agent.id, label: label(agent.id), path: p, desc: agent.desc,
      result: before === null ? 'created' : (before === body ? 'unchanged' : 'updated'),
      loaded });
  }
  return out;
}

function uninstall() {
  const out = [];
  for (const agent of AGENTS) {
    const p = plistPath(agent.id);
    const existed = fs.existsSync(p);
    if (existed) { launchctl(['unload', p]); fs.unlinkSync(p); }
    out.push({ id: agent.id, removed: existed });
  }
  return out;
}

function status() {
  let listed = '';
  try { listed = execFileSync('launchctl', ['list'], { encoding: 'utf8' }); } catch (e) { listed = ''; }
  return AGENTS.map((a) => ({
    id: a.id, label: label(a.id), desc: a.desc,
    installed: fs.existsSync(plistPath(a.id)),
    loaded: listed.indexOf(label(a.id)) !== -1,
  }));
}

module.exports = { install, uninstall, status, AGENTS, plistPath, label, LAUNCH_DIR, renderPlist };
