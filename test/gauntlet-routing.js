'use strict';
// Routing decisions that must hold WITHOUT any model call. A gauntlet that spends a
// model call to discover a claim has no check is wasting money on every run.
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const g = require(path.join(ROOT, 'lib', 'gauntlet.js'));
const cfg = require(path.join(ROOT, 'lib', 'config.js')).load();

const root = process.argv[2];
fs.mkdirSync(path.join(root, 'repo'), { recursive: true });
fs.writeFileSync(path.join(root, 'repo', 'thing.ts'), 'export const Y = 2\n');
const ctx = { root, here: root, cfg, opts: {}, existing: [] };
const Q = String.fromCharCode(39);

const noCheck = { id: 't-nocheck', claim: 'x'.repeat(40), scope: ['repo'],
  check: 'unresolved ' + Q + 'nothing to run' + Q + '\n' };
const r1 = g.runLevels(noCheck, ctx);
if (r1.outcome !== 'no-check') { console.error('expected no-check, got ' + r1.outcome); process.exit(1); }

const bad = { id: 't-l1', claim: 'y'.repeat(40), scope: ['repo'],
  check: 'has ' + Q + 'repo/thing.ts' + Q + ' ' + Q + 'NOT_PRESENT_ANYWHERE' + Q + '\n' };
const r2 = g.runLevels(bad, ctx);
if (r2.outcome !== 'level1-fail') { console.error('expected level1-fail, got ' + r2.outcome); process.exit(1); }
process.exit(0);
