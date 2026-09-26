'use strict';
const fs = require('fs');
const path = require('path');
const repos = require('../repos');
const table = require('../table');
const markers = require('../markers');
const state = require('../state');

const CANDIDATE_DIR = path.join(repos.GOTCHA_HOME, 'candidates');
const DRAFT_DIR = path.join(repos.GOTCHA_HOME, 'drafts');

function ago(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms)) return 'never';
  const h = ms / 3600000;
  if (h < 1) return Math.max(1, Math.round(h * 60)) + 'm ago';
  if (h < 48) return Math.round(h) + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

function run() {
  const st = state.read();
  console.log('gotcha status');
  console.log('');
  console.log('TRACKED REPOS');
  const tracked = repos.tracked();
  if (!tracked.length) console.log('  none found');
  for (const repoPath of tracked) {
    const r = repos.resolve(repoPath);
    const b = repos.branchInfo(repoPath);
    const found = table.findFor(repoPath);
    let factLine = 'no fact table';
    if (found) {
      try {
        const doc = table.loadFound(found);
        const by = {};
        for (const f of doc.facts) by[f.status] = (by[f.status] || 0) + 1;
        const parts = Object.keys(by).sort().map((k) => by[k] + ' ' + k);
        factLine = doc.facts.length + ' facts (' + parts.join(', ') + ')';
        if (found.offTree) factLine += ' [from ' + found.ref + ', not in working tree]';
        else if (!found.own) factLine += ' [table in ' + found.owner + ']';
      } catch (e) { factLine = 'fact table unreadable: ' + e.message; }
    }
    const pointers = ['CLAUDE.md', 'AGENTS.md', path.join('.cursor', 'rules', 'repo-truth.mdc')]
      .filter((rel) => markers.present(path.join(repoPath, rel)));
    console.log('  ' + r.name);
    console.log('    branch    ' + b.branch + (b.base ? ' (+' + b.ahead + '/-' + b.behind + ' vs ' + b.base + ')' : ''));
    console.log('    facts     ' + factLine);
    console.log('    pointers  ' + (pointers.length ? pointers.length + '/3 installed (' + pointers.join(', ') + ')' : 'not installed — run: gotcha install ' + repoPath));
  }

  console.log('');
  console.log('CANDIDATES AWAITING REVIEW');
  let pending = 0;
  let files = [];
  try { files = fs.readdirSync(CANDIDATE_DIR).filter((f) => /\.yaml$/.test(f)).sort(); } catch (e) { files = []; }
  // .rejected/.duplicates are archives of what gotcha set aside; counting them as
  // "awaiting review" overstates the queue and invites re-reviewing discarded work.
  const isSidecar = (f) => /\.(rejected|duplicates)\.yaml$/.test(f);
  const sidecars = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(CANDIDATE_DIR, f), 'utf8');
    const n = (text.match(/^  - id: /gm) || []).length;
    if (isSidecar(f)) { sidecars.push({ f, n }); continue; }
    const promoted = (text.match(/^    promoted: /gm) || []).length;
    pending += n - promoted;
    console.log('  ' + f + ': ' + n + ' candidate(s)' + (promoted ? ', ' + promoted + ' promoted' : ''));
  }
  if (!files.length) console.log('  none — run: gotcha harvest');
  else console.log('  ' + pending + ' awaiting review — promote with: gotcha promote <id>');
  for (const s of sidecars) {
    console.log('  (' + s.f + ': ' + s.n + ' set aside, not awaiting review)');
  }

  let drafts = [];
  try { drafts = fs.readdirSync(DRAFT_DIR).filter((f) => /\.yaml$/.test(f)).sort(); } catch (e) { drafts = []; }
  if (drafts.length) {
    console.log('');
    console.log('AUDIT DRAFTS');
    for (const f of drafts) {
      const text = fs.readFileSync(path.join(DRAFT_DIR, f), 'utf8');
      console.log('  ' + f + ': ' + (text.match(/^  - id: /gm) || []).length + ' drafted fact(s)');
    }
  }

  const cfg = require('../config').load();
  const budget = require('../budget');
  const cap = (cfg.budget && cfg.budget.dailyUsd) || 5;
  const b = budget.status(cap);
  console.log('');
  console.log('SCHEDULE');
  console.log('  harvest   every 5 min (launchd com.gotcha.harvest-tick), incremental');
  console.log('            ' + Math.round(((cfg.harvest && cfg.harvest.graceMs) || 120000) / 1000) +
    's grace window; an idle tick makes no model call');
  console.log('  gauntlet  nightly 02:30, or early once the queue reaches ' +
    ((cfg.gauntlet && cfg.gauntlet.earlyTriggerCount) || 15) + ' adjudicable candidates');
  console.log('  verify    weekly Mon 03:15 (--baseline), then DIGEST.md');
  console.log('');
  console.log('TOKEN BUDGET (shared by ticks and the gauntlet)');
  console.log('  today     $' + b.spentUsd.toFixed(4) + ' of $' + cap.toFixed(2) +
    '  (' + b.calls + ' call(s), $' + b.remaining.toFixed(2) + ' left)');

  console.log('');
  console.log('LAST RUNS');
  console.log('  harvest   ' + ago(st.lastHarvest) + (st.lastHarvest ? ' (' + st.lastHarvest.slice(0, 16).replace('T', ' ') + ')' : ''));
  if (st.lastHarvestDeferred) console.log('  deferred  ' + ago(st.lastHarvestDeferred) + ' (budget cap reached; watermark held)');
  console.log('  gauntlet  ' + ago(st.lastGauntlet) + (st.lastGauntletResult ? ' — ' + st.lastGauntletResult : ''));
  console.log('  verify    ' + ago(st.lastVerify) + (st.lastVerifyResult ? ' — ' + st.lastVerifyResult : ''));
  console.log('  transcripts seen: ' + Object.keys(st.transcripts || {}).length);
  return 0;
}

module.exports = { run };
