#!/usr/bin/env node
'use strict';
// How much does discovery mining widen the prefilter?
//
// Discoveries were added because the two most valuable lessons of 2026-09-26 were
// findings, not corrections, and the correction cues scored both zero. But every
// extra window is a chunk somebody pays for, and discovery language is far more
// common than "no, that's wrong". The agreed budget was: windows/day may roughly
// double, no more. This measures that against the real transcript corpus rather
// than trusting a hand-tuned threshold.

const fs = require('fs');
const path = require('path');
const os = require('os');
const harvest = require('../lib/commands/harvest');
const transcripts = require('../lib/transcripts');

const LIMIT = 2.2;   // corrections + discoveries may be at most this many x corrections

function corpus(n) {
  const dir = path.join(os.homedir(), '.claude', 'projects');
  const files = [];
  (function walk(d, depth) {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.jsonl$/.test(e.name)) files.push(p);
    }
  }(dir, 0));
  return files
    .map((f) => { try { return { f, m: fs.statSync(f).mtimeMs }; } catch (e) { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.m - a.m)
    .slice(0, n)
    .map((x) => x.f);
}

function measure(files) {
  let corrections = 0, discoveries = 0, turns = 0;
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch (e) { continue; }
    let r;
    try {
      r = transcripts.readNew({ file: f, tool: 'claude-code', size: st.size, mtime: st.mtime }, 0);
    } catch (e) { continue; }
    turns += r.turns.length;
    for (const t of r.turns) {
      if (t.role === 'user' && !harvest.SYNTHETIC_USER.test(t.text)) {
        if (harvest.score(t.text, harvest.CUES) >= 3) corrections++;
      } else if (t.role === 'assistant') {
        if (harvest.score(t.text, harvest.AGENT_CUES) >= 3) corrections++;
        else if (harvest.score(t.text, harvest.DISCOVERY_CUES) >= harvest.DISCOVERY_MIN) discoveries++;
      }
    }
  }
  return { corrections, discoveries, turns };
}

function run(n) {
  const files = corpus(n || 40);
  const m = measure(files);
  const growth = (m.corrections + m.discoveries) / Math.max(m.corrections, 1);
  return Object.assign(m, { files: files.length, growth });
}

if (process.argv.indexOf('--check') !== -1) {
  const r = run(40);
  if (!r.corrections) {
    console.log('  SKIP cue growth (no correction windows in the local corpus)');
    process.exit(0);
  }
  if (r.growth > LIMIT) {
    console.error('  FAIL discovery mining widened the prefilter ' + r.growth.toFixed(2) +
      'x (limit ' + LIMIT + 'x): ' + r.corrections + ' correction + ' +
      r.discoveries + ' discovery window(s). Raise DISCOVERY_MIN or tighten the cues.');
    process.exit(1);
  }
  console.log('  cue growth OK: ' + r.growth.toFixed(2) + 'x (' + r.corrections +
    ' correction + ' + r.discoveries + ' discovery)');
  process.exit(0);
}

if (require.main === module) {
  const r = run(parseInt(process.argv[2], 10) || 40);
  console.log(r.files + ' transcripts, ' + r.turns + ' turns');
  console.log('  correction windows: ' + r.corrections);
  console.log('  discovery windows:  ' + r.discoveries);
  console.log('  growth:             ' + r.growth.toFixed(2) + 'x  (limit ' + LIMIT + 'x)');
}

module.exports = { run, measure, corpus, LIMIT };
