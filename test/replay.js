#!/usr/bin/env node
'use strict';
// Regression replay: run a real session's tool calls past the matcher and count
// what fires.
//
// This exists because the matcher's failure mode is invisible in a unit test. It
// was not wrong about any single fact -- every fact it surfaced genuinely
// anchored to a file the command touched. It was wrong in AGGREGATE: three facts
// firing on ten-plus commands drowned out the two that mattered. Only a replay
// over a whole session shows that.

const fs = require('fs');
const path = require('path');
const relevance = require('../lib/relevance');

const FIXTURE = path.join(__dirname, 'fixtures', 'tracked-picks-session.json');

/** The matcher as it behaved before the task-aware rework, kept for comparison. */
function legacyRank(facts, subject) {
  const hay = subject.toLowerCase();
  const hits = [];
  for (const f of facts) {
    let why = null;
    for (const a of f.anchors || []) {
      if (hay.indexOf(a.toLowerCase()) !== -1) { why = a; break; }
    }
    if (!why) {
      for (const b of f.bases || []) {
        if (b.length >= 8 && hay.indexOf(b.toLowerCase()) !== -1) { why = b; break; }
      }
    }
    if (why) hits.push({ f, why });
    if (hits.length >= 12) break;
  }
  const rank = (h) => (h.f.status === 'failed' ? 0 : h.f.enforce ? 1 : 2);
  hits.sort((a, b) => rank(a) - rank(b));
  return hits.slice(0, 3);
}

function tally(facts, calls, ranker, dedupe) {
  const perFact = new Map();
  let fires = 0, noisyCalls = 0;
  const told = new Map();
  for (const c of calls) {
    let hits = ranker(facts, c.subject);
    if (dedupe) {
      hits = hits.filter((h) => {
        if (told.get(h.f.id) === h.f.status) return false;
        told.set(h.f.id, h.f.status);
        return true;
      });
    }
    if (hits.length) noisyCalls++;
    for (const h of hits) {
      fires++;
      perFact.set(h.f.id, (perFact.get(h.f.id) || 0) + 1);
    }
  }
  return { fires, noisyCalls, perFact };
}

function loadIndex() {
  const p = process.env.GOTCHA_HOOK_INDEX ||
    path.join(require('os').homedir(), '.local', 'share', 'gotcha', 'hook-index.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function run() {
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const idx = loadIndex();
  const before = tally(idx.facts, fx.calls, legacyRank, false);
  const after = tally(idx.facts, fx.calls, relevance.rank, true);
  return { fx, idx, before, after };
}

function top(perFact, n) {
  return Array.from(perFact.entries()).sort((a, b) => b[1] - a[1]).slice(0, n);
}

/**
 * Assertions that keep the fix from rotting. These are budgets, not exact
 * numbers -- facts.yaml grows, so the test pins the PROPERTY (no fact dominates
 * a session, generic anchors stay quiet) rather than a count that drifts.
 */
function check() {
  const { fx, idx, before, after } = run();
  const fails = [];
  const worst = Math.max(0, ...after.perFact.values());
  if (worst > 1) fails.push('a fact fired ' + worst + 'x in one session; once-per-session dedupe is broken');
  // A canary, not the real guarantee. The BEFORE baseline shrinks every time a
  // duplicate fact is merged away (it fell 57 -> 45 when the two /picks/featured
  // facts became one), so a tight ratio here fails for the good reason that the
  // table got better. The properties that actually matter are asserted below:
  // offenders silent, useful facts still firing, nothing repeating, cap of 3.
  if (after.fires > before.fires / 2) {
    fails.push('noise only fell from ' + before.fires + ' to ' + after.fires + '; expected at least a 2x cut');
  }
  // The three facts from the field report: all anchor to some page.tsx and all
  // fired 14x on a session that had nothing to do with them.
  for (const id of ['picks-featured-route-exists-but-has-no-f99d3d',
                    'the-route-file-picks-featured-exists-in-5afdf7',
                    'glossary-admin-tailored']) {
    const n = after.perFact.get(id) || 0;
    if (n > 0) fails.push(id + ' still fires ' + n + 'x on the tracked-picks session');
  }
  // The two facts the consumer agent said actually helped must survive the cut.
  // Silencing noise is only a win if the signal is still there.
  for (const id of ['tests-are-executed-via-npx-tsx-test-2ef93d',
                    'period-markets-grade-from-team-game-stats']) {
    if (!(after.perFact.get(id) > 0)) {
      fails.push(id + ' no longer fires on the session where it helped');
    }
  }
  // No single command may bury the agent.
  let worstCall = 0;
  for (const c of fx.calls) worstCall = Math.max(worstCall, relevance.rank(idx.facts, c.subject).length);
  if (worstCall > 3) fails.push('a single command surfaced ' + worstCall + ' facts (cap is 3)');

  // ...but they must still fire when the task is actually about them.
  const mustFire = [
    ['cat user-dashboard/app/picks/featured/page.tsx', 'picks-featured'],
    ['add a nav link to /picks/featured', 'picks-featured'],
    ['what is admin tailored?', 'glossary-admin-tailored'],
  ];
  for (const [cmd, want] of mustFire) {
    const hits = relevance.rank(idx.facts, cmd);
    if (!hits.some((h) => h.f.id.indexOf(want) !== -1)) {
      fails.push('no fact matching "' + want + '" fired on: ' + cmd);
    }
  }
  // A generic anchor must never carry a fact on its own. Note `npm run build` is
  // deliberately NOT in this list: it is an invocation, and a fact about what the
  // build does or does not prove SHOULD fire when you run it.
  for (const cmd of ['cat app/tracked-picks/page.tsx', 'vim app/games/[sport]/page.tsx',
                     'cat package.json', 'ls -la app/dashboard']) {
    const hits = relevance.rank(idx.facts, cmd);
    if (hits.length) fails.push('generic anchor fired ' + hits.length + ' fact(s) on: ' + cmd);
  }
  return { fails, before, after, fx, idx };
}

// The fixture is built from a real session in private repos, so it is not part of
// the public release. Without it there is nothing to replay, which is a skip, not
// a failure.
function haveFixture() {
  try { return fs.existsSync(FIXTURE); } catch (e) { return false; }
}

if (process.argv.indexOf('--check') !== -1) {
  if (!haveFixture()) {
    console.log('  replay SKIPPED (no session fixture in this checkout)');
    process.exit(0);
  }
  const { fails, before, after } = check();
  if (fails.length) {
    for (const f of fails) console.error('  FAIL ' + f);
    process.exit(1);
  }
  console.log('  replay OK: ' + before.fires + ' -> ' + after.fires + ' fact fires, no fact repeats');
  process.exit(0);
}

if (require.main === module) {
  const { fx, idx, before, after } = run();
  console.log('replay: ' + fx.calls.length + ' tool calls, ' + idx.facts.length + ' indexed facts');
  console.log('');
  console.log('  BEFORE (filename matching, no dedupe)');
  console.log('    total fact fires:     ' + before.fires);
  console.log('    calls with a fact:    ' + before.noisyCalls);
  console.log('    worst offenders:');
  for (const [id, n] of top(before.perFact, 5)) console.log('      ' + n + 'x  ' + id);
  console.log('');
  console.log('  AFTER (task-aware scoring + once-per-session)');
  console.log('    total fact fires:     ' + after.fires);
  console.log('    calls with a fact:    ' + after.noisyCalls);
  console.log('    facts surfaced:');
  for (const [id, n] of top(after.perFact, 10)) console.log('      ' + n + 'x  ' + id);
}

module.exports = { run, check, legacyRank, tally, FIXTURE };
