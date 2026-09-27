'use strict';
// Refuse to promote gotcha's own test debris into a real fact table.
//
// On 2026-09-26 a candidate reading "Queued test candidate number 3 with a runnable
// check" went through the full gauntlet -- mechanical check, an independent sonnet
// examiner that CONFIRMED it, the coherence scan -- and was written into
// facts.yaml. It survived only because that write was never committed. Nothing in
// three levels of adjudication noticed it was a fixture, because every level asks
// "is this claim true?" and a fixture's claim generally is.
//
// So this asks a different question, before any of them: does this look like
// something a test made? A real lesson comes from a transcript of real work. A
// fixture announces itself -- in its id, in its wording, or in a source path inside
// the collector's own tree.
//
// Legitimate test flows opt in with `synthetic_ok: "true"` on the candidate, which
// is deliberately noisy to write and trivial to grep for.

const path = require('path');

// Ids a fixture generator produces.
//
// A bare /^tests?[-_]/ is NOT enough: it flags the real fact
// `tests-are-executed-via-npx-tsx-test-2ef93d`, which is exactly the kind of
// honest fact about a test suite this must never touch. So `test-` only counts
// when what follows is itself fixture vocabulary or a bare number.
const ID_MARKERS = [
  /^queued[-_]candidate/i,
  /^tests?[-_](candidate|fact|claim|fixture|lesson|entry|artifact|\d+$)/i,
  /^planted[-_]/i,
  /^(fixture|dummy|placeholder|sample|example|scratch|throwaway)[-_]/i,
  /^(foo|bar|baz|qux)[-_]/i,
];

// Wording that only a fixture uses. These must stay narrow: "test" alone appears in
// plenty of real facts about test suites.
const TEXT_MARKERS = [
  /\bqueued test candidate\b/i,
  /\btest candidate number\b/i,
  /\bplanted (lesson|fact|candidate)\b/i,
  /\bsynthetic (fact|candidate|lesson)\b/i,
  /\b(dummy|placeholder) (fact|claim|candidate)\b/i,
  /\bthis is a test (fact|claim|candidate)\b/i,
  /\blorem ipsum\b/i,
];

// A source inside the collector's own tree is conclusive: real lessons come from
// transcripts of real work, never from our fixtures.
const SOURCE_MARKERS = [
  /gotcha-collector[\/\\]test[\/\\]/i,
  /[\/\\]test[\/\\]fixtures?[\/\\]/i,
  /[\/\\]__tests__[\/\\]/i,
  /\bfixture\b/i,
];

function allowed(fact) {
  const v = fact.synthetic_ok;
  return v === true || v === 'true';
}

/**
 * Does this candidate look like a test artifact?
 * Returns { synthetic, reasons } -- reasons is empty when it does not.
 */
function detect(fact, opts) {
  if (allowed(fact)) return { synthetic: false, reasons: [], allowed: true };
  const reasons = [];

  const id = String(fact.id || '');
  if (ID_MARKERS.some((re) => re.test(id))) {
    reasons.push('its id "' + id + '" begins with a test-fixture marker');
  }

  const text = [fact.claim, (fact.evidence || []).join(' '), fact.note].filter(Boolean).join(' ');
  for (const re of TEXT_MARKERS) {
    if (re.test(text)) { reasons.push('its text reads as a fixture (matched ' + re + ')'); break; }
  }

  const src = String(fact.source || '') + ' ' + String(fact.provenance || '');
  for (const re of SOURCE_MARKERS) {
    if (re.test(src)) { reasons.push('its source points inside a test tree: ' + src.trim()); break; }
  }

  // A source file physically inside the installed collector is conclusive however
  // it is spelled.
  const installRoot = (opts && opts.installRoot) || path.join(__dirname, '..');
  const m = /(?:transcript|source)\s+(\S+)/i.exec(src);
  if (m && m[1].indexOf(installRoot) === 0) {
    reasons.push('its source file lives inside the collector itself: ' + m[1]);
  }

  return { synthetic: reasons.length > 0, reasons, allowed: false };
}

module.exports = { detect, ID_MARKERS, TEXT_MARKERS, SOURCE_MARKERS, allowed };
