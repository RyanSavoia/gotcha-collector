'use strict';
// `gotcha promote` with no id: run the gauntlet over every eligible candidate.
// This is what replaces human approval in the normal path.

const fs = require('fs');
const path = require('path');
const facts = require('../facts');
const repos = require('../repos');
const config = require('../config');
const gauntlet = require('../gauntlet');
const state = require('../state');
const { writeFileAtomic, today } = require('../util');
const { execFileSync } = require('child_process');

const CANDIDATE_DIR = path.join(repos.GOTCHA_HOME, 'candidates');

function candidateFiles() {
  try {
    return fs.readdirSync(CANDIDATE_DIR)
      .filter((f) => /\.yaml$/.test(f) && !/\.(rejected|duplicates)\.yaml$/.test(f))
      .sort().map((f) => path.join(CANDIDATE_DIR, f));
  } catch (e) { return []; }
}

/** Mark a candidate as handled so a later run does not re-spend tokens on it. */
function stamp(file, id, field, value) {
  const src = fs.readFileSync(file, 'utf8');
  const doc = facts.parse(src, { strict: false });
  const f = doc.facts.find((x) => x.id === id);
  if (!f) return;
  const lines = src.split('\n');
  lines.splice(f.end + 1, 0, '    ' + field + ': ' + facts.encodeScalar(value));
  writeFileAtomic(file, lines.join('\n'));
}

function run(argv, flags) {
  const cfg = config.load();
  const target = repos.resolve(flags.repo || path.join(repos.HOME, 'user-dashboard-main'), { root: flags.root });
  if (!fs.existsSync(target.factsPath)) {
    console.error('gotcha promote: no fact table at ' + target.factsPath);
    return 2;
  }
  const cap = parseInt(flags.max, 10) || cfg.gauntlet.maxRunsPerBatch;
  const ctx = {
    root: target.root, here: target.here, cfg,
    opts: { model: flags.model, noDb: !!flags['no-db'] },
    existing: facts.parse(fs.readFileSync(target.factsPath, 'utf8'), { strict: false }).facts,
  };
  const inTable = new Set(ctx.existing.map((f) => f.id));

  // Eligible: not promoted, not already adjudicated, not already in the table.
  const eligible = [];
  for (const file of candidateFiles()) {
    const doc = facts.parse(fs.readFileSync(file, 'utf8'), { strict: false });
    for (const f of doc.facts) {
      if (f.promoted || f.gauntlet || inTable.has(f.id)) continue;
      eligible.push({ f, file });
    }
  }
  const runnable = eligible.filter((e) => !/^\s*unresolved /.test(String(e.f.check || '')));
  const noCheck = eligible.filter((e) => /^\s*unresolved /.test(String(e.f.check || '')));
  const batch = runnable.slice(0, cap);

  console.log('gotcha gauntlet');
  console.log('  eligible: ' + eligible.length + ' (' + runnable.length + ' with a runnable check, ' +
    noCheck.length + ' human-asserted track)');
  console.log('  examiner: ' + (flags.model || cfg.models.examiner) + '   cap: ' + cap + '   running: ' + batch.length);
  if (!batch.length) { console.log('  nothing to run.'); return 0; }

  // Snapshot the table so the whole batch can be rolled back as one unit.
  const preBatch = fs.readFileSync(target.factsPath, 'utf8');
  const results = { promoted: [], disputed: [], cannotVerify: [], level1Fail: [] };
  const pending = [];

  for (let i = 0; i < batch.length; i++) {
    const { f, file } = batch[i];
    process.stdout.write('  [' + (i + 1) + '/' + batch.length + '] ' + f.id.slice(0, 52) + ' ... ');
    let r;
    try { r = gauntlet.runLevels(f, ctx); }
    catch (e) { r = { outcome: 'cannot-verify', l2: { verdict: 'CANNOT-VERIFY', evidence: 'gauntlet error: ' + e.message, model: 'n/a' } }; }

    if (r.outcome === 'promote') {
      pending.push({ f, file, fact: gauntlet.toFact(f, r.l2, r.l4) });
      results.promoted.push({ id: f.id, evidence: r.l2.evidence, model: r.l2.model, ce: r.l4 && r.l4.outcome });
      console.log('PROMOTE' + (r.l4 && r.l4.outcome === 'demonstrated' ? ' (counterexample demonstrated)' : ' (counterexample not-constructible)'));
    } else if (r.outcome === 'disputed') {
      results.disputed.push({ id: f.id, level: r.level, path: r.disputePath });
      stamp(file, f.id, 'gauntlet', 'disputed ' + today() + ' (L' + r.level + ')');
      console.log('DISPUTED (L' + r.level + ')');
    } else if (r.outcome === 'cannot-verify') {
      results.cannotVerify.push({ id: f.id, note: r.l2 && r.l2.evidence });
      stamp(file, f.id, 'gauntlet', 'cannot-verify ' + today() + ': ' + String((r.l2 && r.l2.evidence) || '').slice(0, 180));
      console.log('CANNOT-VERIFY');
    } else {
      results.level1Fail.push({ id: f.id, reason: r.reason });
      console.log('L1 FAIL');
    }
  }

  // --- write the batch, then prove the file is still valid ------------------
  if (pending.length) {
    let src = fs.readFileSync(target.factsPath, 'utf8');
    for (const p of pending) {
      const doc = facts.parse(src, { strict: false });
      const lines = src.split('\n');
      const last = doc.facts[doc.facts.length - 1];
      lines.splice(last ? last.end + 1 : lines.length, 0, ...facts.render(p.fact));
      src = lines.join('\n');
    }
    let ok = true;
    let why = '';
    try { facts.parse(src, { strict: true }); } catch (e) { ok = false; why = 'strict parse: ' + e.message; }
    if (ok) {
      writeFileAtomic(target.factsPath, src);
      try {
        execFileSync('bash', [path.join(target.here, 'verify.sh'), target.root],
          { encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        const out = ((e && e.stdout) || '') + ((e && e.stderr) || '');
        if (/SCHEMA-ERROR|INFRA-FAIL/.test(out)) { ok = false; why = 'verify.sh rejected the batch: ' + out.split('\n').filter((l) => /SCHEMA-ERROR|INFRA-FAIL/.test(l))[0]; }
      }
    }
    if (!ok) {
      // Roll the whole batch back. Partial credit is not worth a broken table.
      writeFileAtomic(target.factsPath, preBatch);
      const q = path.join(gauntlet.DISPUTED_DIR, today() + '-batch-rollback.yaml');
      fs.mkdirSync(gauntlet.DISPUTED_DIR, { recursive: true });
      writeFileAtomic(q, '# Batch rolled back; facts.yaml restored to its pre-batch bytes.\nreason: ' +
        facts.encodeScalar(why) + '\ncandidates:\n' + pending.map((p) => '  - ' + facts.encodeScalar(p.f.id)).join('\n') + '\n');
      console.log('');
      console.log('  BATCH ROLLED BACK — ' + why);
      console.log('  facts.yaml restored; ' + pending.length + ' candidate(s) quarantined -> ' + q);
      return 1;
    }
    for (const p of pending) stamp(p.file, p.f.id, 'promoted', today());
  }

  state.patch({
    lastGauntlet: new Date().toISOString(),
    lastGauntletResult: results.promoted.length + ' promoted, ' + results.disputed.length + ' disputed, ' +
      results.cannotVerify.length + ' cannot-verify',
  });

  console.log('');
  console.log('  promoted      ' + results.promoted.length + '  (auto, no human approval)');
  console.log('  disputed      ' + results.disputed.length + (results.disputed.length ? '  <- needs arbitration: ' + gauntlet.DISPUTED_DIR : ''));
  console.log('  cannot-verify ' + results.cannotVerify.length + '  (stay candidates)');
  if (results.level1Fail.length) console.log('  level-1 fail  ' + results.level1Fail.length);
  console.log('  human-asserted queue: ' + noCheck.length + '  (no runnable check; see `gotcha digest`)');
  console.log('  remaining eligible after cap: ' + Math.max(0, runnable.length - batch.length));
  return 0;
}

module.exports = { run, candidateFiles };
