'use strict';
// `gotcha uninstall` -- remove what gotcha added. Never touches repo-truth/: the
// facts are the user's data and long outlive the tool that collected them.

const fs = require('fs');
const path = require('path');
const paths = require('../paths');
const schedule = require('../schedule');

function stripHook(file, matcher) {
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return 'absent'; }
  const before = JSON.stringify(obj);
  const prune = (list) => list.filter((e) => JSON.stringify(e).indexOf('gotcha-hook.js') === -1 &&
    JSON.stringify(e).indexOf('gotcha-session-start.js') === -1);
  if (obj.hooks) {
    for (const ev of Object.keys(obj.hooks)) {
      if (Array.isArray(obj.hooks[ev])) {
        obj.hooks[ev] = prune(obj.hooks[ev]);
        if (!obj.hooks[ev].length) delete obj.hooks[ev];
      }
    }
    if (!Object.keys(obj.hooks).length) delete obj.hooks;
  }
  if (JSON.stringify(obj) === before) return 'unchanged';
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  return 'removed';
}

function run(argv, flags) {
  console.log('gotcha uninstall');
  console.log('');
  console.log('  launchd agents:');
  for (const a of schedule.uninstall()) {
    console.log('    ' + (a.removed ? 'removed  ' : 'absent   ') + a.id);
  }
  console.log('  hooks (only gotcha entries; everything else is left alone):');
  console.log('    ' + stripHook(path.join(paths.HOME, '.claude', 'settings.json')).padEnd(9) + 'Claude Code settings.json');
  console.log('    ' + stripHook(path.join(paths.HOME, '.cursor', 'hooks.json')).padEnd(9) + 'Cursor hooks.json');

  if (flags.purge) {
    for (const d of [paths.CONFIG_DIR, paths.DATA_DIR]) {
      try { fs.rmSync(d, { recursive: true, force: true }); console.log('    purged   ' + d.replace(paths.HOME, '~')); }
      catch (e) { console.log('    failed   ' + d + ': ' + e.message); }
    }
  } else {
    console.log('');
    console.log('  Config and data kept:');
    console.log('    ' + paths.CONFIG_DIR.replace(paths.HOME, '~') + '  (config, credentials)');
    console.log('    ' + paths.DATA_DIR.replace(paths.HOME, '~') + '  (candidates, state, logs)');
    console.log('    Pass --purge to delete them too.');
  }
  console.log('');
  console.log('  repo-truth/ directories are untouched — those facts are your data.');
  return 0;
}

module.exports = { run };
