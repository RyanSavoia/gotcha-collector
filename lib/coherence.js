'use strict';
// Level 3: coherence scan.
//
// Levels 1 and 2 ask "is this claim true?". Level 3 asks "does the table still make
// sense with it in?". A claim can be independently true and still contradict a fact
// already recorded -- and when two facts contradict, one of them is wrong. That is
// precisely the thing a human should look at, so a contradiction quarantines BOTH
// rather than picking a winner.

const { execFileSync } = require('child_process');
const redact = require('./redact');
const { similarity } = require('./commands/harvest');

const SHORTLIST = 40;   // compare against the nearest facts, not all 139

function shortlist(claim, existing, n) {
  return existing
    .map((f) => ({ f, s: similarity(claim, f.claim) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n || SHORTLIST)
    .map((x) => x.f);
}

function prompt(claim, candidates) {
  return [
    'You are checking one NEW claim against claims already recorded as true.',
    '',
    'Report a conflict ONLY for a real contradiction: both cannot be true at once',
    '(different values for the same thing, opposite states, incompatible behaviour).',
    'Do NOT report overlap, related topics, one being more specific than the other, or',
    'one adding detail the other lacks. Those coexist fine.',
    '',
    'NEW CLAIM:',
    claim,
    '',
    'EXISTING FACTS:',
    candidates.map((f) => '- ' + f.id + ': ' + String(f.claim).replace(/\s+/g, ' ').slice(0, 220)).join('\n'),
    '',
    'Answer with ONLY a comma-separated list of conflicting fact ids, or the single',
    'word NONE. No explanation.',
  ].join('\n');
}

/** Returns { conflicts: [ids], raw }. Fails safe: on error, no conflict claimed. */
function scan(claim, existing, cfg, opts) {
  const model = (opts && opts.model) || cfg.models.coherence;
  const cands = shortlist(claim, existing);
  if (!cands.length) return { conflicts: [], raw: '' };
  const p = redact.scrub(prompt(String(claim), cands)).text;
  let out = '';
  try {
    out = execFileSync('claude', ['-p', p, '--model', model, '--output-format', 'text',
      '--no-session-persistence', '--permission-mode', 'dontAsk',
      '--disallowedTools', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch'], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) { return { conflicts: [], raw: 'coherence scan failed: ' + ((e && e.message) || 'error') }; }

  const text = String(out).trim();
  if (/^\s*NONE\b/i.test(text)) return { conflicts: [], raw: text };
  const known = new Set(cands.map((f) => f.id));
  // Only trust ids we actually showed it; a hallucinated id must not quarantine a fact.
  const conflicts = (text.match(/[a-z0-9][a-z0-9-]{4,}/gi) || [])
    .map((s) => s.toLowerCase())
    .filter((id) => known.has(id));
  return { conflicts: Array.from(new Set(conflicts)), raw: text.slice(0, 600) };
}

module.exports = { scan, shortlist, prompt };
