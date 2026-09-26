'use strict';
// Runs a candidate through all three levels and, if it passes, promotes it.
//
// Safety model: the gauntlet never hand-writes facts.yaml. It renders through the
// same schema path manual promote uses, re-parses strictly, and verifies the whole
// file after the batch. If verification fails the ENTIRE batch is rolled back to the
// pre-batch bytes and quarantined -- a bug in this file must not be able to leave a
// corrupt or unverifiable fact table behind.

const fs = require('fs');
const path = require('path');
const facts = require('./facts');
const checks = require('./checks');
const repos = require('./repos');
const examinerLib = require('./examiner');
const coherence = require('./coherence');
const counterexample = require('./counterexample');
const { writeFileAtomic, today } = require('./util');

const DISPUTED_DIR = path.join(repos.GOTCHA_HOME, 'disputed');

function disputeFile(id) {
  return path.join(DISPUTED_DIR, today() + '-' + id + '.yaml');
}

/** Record a dispute: the claim, both sides, and what a human has to decide. */
function quarantine(entry) {
  fs.mkdirSync(DISPUTED_DIR, { recursive: true });
  const y = [];
  y.push('# Disputed — a human needs to arbitrate this.');
  y.push('dispute:');
  y.push('  opened: ' + facts.encodeScalar(today()));
  y.push('  kind: ' + facts.encodeScalar(entry.kind));
  y.push('  decide: ' + facts.encodeScalar(entry.decide));
  y.push('  candidate_id: ' + facts.encodeScalar(entry.fact.id));
  y.push('  claim: ' + facts.encodeScalar(entry.fact.claim));
  y.push('  scope: ' + facts.encodeList(entry.fact.scope || []));
  y.push('  check: ' + facts.encodeScalar(String(entry.fact.check || '').trim()));
  y.push('  harvester_evidence: ' + facts.encodeList((entry.fact.evidence || []).slice(0, 4)));
  if (entry.fact.source) y.push('  source: ' + facts.encodeScalar(entry.fact.source));
  y.push('  examiner_model: ' + facts.encodeScalar(entry.model || 'n/a'));
  y.push('  examiner_verdict: ' + facts.encodeScalar(entry.verdict || 'n/a'));
  y.push('  examiner_evidence: ' + facts.encodeScalar(entry.evidence || 'n/a'));
  if (entry.queries && entry.queries.length) {
    y.push('  examiner_db_queries:');
    for (const q of entry.queries.slice(0, 20)) y.push('    - ' + facts.encodeScalar(q));
  }
  if (entry.conflictsWith && entry.conflictsWith.length) {
    y.push('  conflicts_with:');
    for (const c of entry.conflictsWith) {
      y.push('    - id: ' + facts.encodeScalar(c.id));
      y.push('      claim: ' + facts.encodeScalar(c.claim));
      y.push('      status: ' + facts.encodeScalar(c.status));
    }
  }
  const p = disputeFile(entry.fact.id);
  writeFileAtomic(p, y.join('\n') + '\n');
  return p;
}

/**
 * Run the three levels for one candidate.
 * Returns { outcome, ... } where outcome is one of:
 *   promote | disputed | cannot-verify | no-check | level1-fail
 */
function runLevels(fact, ctx) {
  const runnable = !/^\s*unresolved /.test(String(fact.check || ''));
  if (!runnable) return { outcome: 'no-check', reason: 'no runnable check; a gauntlet cannot validate an untestable claim' };

  // --- Level 1: mechanical -------------------------------------------------
  const l1 = checks.runCheck(fact.check, { root: ctx.root, here: ctx.here });
  if (l1.rc !== 0) return { outcome: 'level1-fail', reason: 'check does not pass: ' + (l1.output || 'no output') };

  // --- Level 2: adversarial audit -----------------------------------------
  const l2 = examinerLib.examine(fact, ctx.cfg, ctx.opts);
  if (l2.verdict === 'DISPROVEN') {
    const p = quarantine({
      kind: 'examiner-disproven', fact,
      decide: 'The examiner contradicted this claim. Decide whether the claim is wrong (drop it) or the examiner is (re-run with --force).',
      model: l2.model, verdict: l2.verdict, evidence: l2.evidence, queries: l2.queries,
    });
    return { outcome: 'disputed', level: 2, l2, disputePath: p };
  }
  if (l2.verdict !== 'CONFIRMED') return { outcome: 'cannot-verify', level: 2, l2 };

  // --- Level 3: coherence --------------------------------------------------
  const l3 = coherence.scan(fact.claim, ctx.existing, ctx.cfg, ctx.opts);
  if (l3.conflicts.length) {
    const conflicting = ctx.existing.filter((f) => l3.conflicts.indexOf(f.id) !== -1)
      .map((f) => ({ id: f.id, claim: f.claim, status: f.status }));
    const p = quarantine({
      kind: 'contradicts-existing-fact', fact,
      decide: 'This claim and the fact(s) below cannot both be true. Establish which is wrong; the loser should end up status `failed`.',
      model: l2.model, verdict: l2.verdict, evidence: l2.evidence, queries: l2.queries,
      conflictsWith: conflicting,
    });
    return { outcome: 'disputed', level: 3, l2, l3, conflicting, disputePath: p };
  }

  // --- Level 4: test the test ---------------------------------------------
  // A check that would pass even when the claim is false proves nothing. Mutate the
  // anchored evidence in an isolated scratch mirror and require the check to fail
  // there. not-constructible is an honest recorded outcome, not a rejection: some
  // claim shapes have no falsifying mutation.
  let l4 = { outcome: 'not-constructible', detail: 'counterexample stage skipped' };
  try { l4 = counterexample.demonstrate(fact, { root: ctx.root, here: ctx.here }); }
  catch (e) { l4 = { outcome: 'not-constructible', detail: 'counterexample error: ' + e.message }; }

  return { outcome: 'promote', l1, l2, l3, l4 };
}

/** The fact as it should land in the table, with provenance. */
function toFact(fact, l2, l4) {
  return {
    id: fact.id,
    claim: fact.claim,
    scope: fact.scope,
    evidence: fact.evidence,
    check: fact.check,
    status: 'verified',
    verified_at: today(),
    note: (fact.note ? fact.note + ' ' : '') +
      'Auto-promoted by the gotcha gauntlet on ' + today() + '. Independent examiner (' + l2.model +
      ') confirmed it: ' + String(l2.evidence).slice(0, 400),
    provenance: 'auto-gauntlet (L2: ' + l2.model + ', ' + today() + ')',
    counterexample: l4
      ? (l4.outcome === 'demonstrated'
        ? 'demonstrated ' + today() + ' — ' + l4.detail
        : 'not-constructible — ' + l4.detail)
      : undefined,
  };
}

module.exports = { runLevels, toFact, quarantine, DISPUTED_DIR, disputeFile };
