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

  // --- health --------------------------------------------------------------
  // Only runs that ATTEMPTED extraction are recorded -- an idle tick with nothing
  // new past the watermark proves nothing either way, so counting it would dilute
  // the signal. "run" below therefore means "extraction run", not "tick".
  // The failure this exists for: the extractor was unreachable from launchd for
  // fifteen consecutive ticks. Each one found correction-shaped windows, spawned
  // nothing, wrote "0 candidate(s)", and advanced the watermarks. Every individual
  // line looked normal. Only the PATTERN -- lessons found, none extracted -- says
  // the machine is broken, so that pattern gets its own loud check.
  const hist = Array.isArray(st.tickHistory) ? st.tickHistory : [];
  const recent = hist.slice(-10);
  const withWindows = recent.filter((t) => t.windows > 0);
  const barren = withWindows.filter((t) => !t.candidates);
  const infra = recent.filter((t) => t.infra > 0);
  const problems = [];
  if (infra.length) {
    problems.push(infra.length + ' of the last ' + recent.length +
      ' extraction run(s) hit an EXTRACTOR FAILURE (watermarks were held)');
  }
  if (withWindows.length >= 3 && barren.length === withWindows.length) {
    problems.push('the last ' + withWindows.length + ' extraction run(s) found ' +
      withWindows.reduce((n, t) => n + t.windows, 0) +
      ' lesson-shaped window(s) and extracted ZERO candidates');
  }
  const bin = require('../extractor').resolve(cfg);
  if (!bin) problems.push('the `claude` binary cannot be found — harvest cannot extract at all');

  console.log('');
  if (problems.length) {
    console.log('HEALTH  *** ATTENTION ***');
    for (const p of problems) console.log('  !! ' + p);
    console.log('  Run `gotcha doctor`. A run that finds lessons but extracts none is');
    console.log('  broken infrastructure, not a quiet day.');
  } else if (!hist.length) {
    console.log('HEALTH  no extraction runs recorded yet');
  } else {
    const c = recent.reduce((n, t) => n + t.candidates, 0);
    console.log('HEALTH  ok — last ' + recent.length + ' extraction run(s): ' +
      recent.reduce((n, t) => n + t.windows, 0) + ' window(s), ' + c + ' candidate(s), ' +
      'extractor at ' + bin);
  }
  return 0;
}

module.exports = { run };
