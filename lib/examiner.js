'use strict';
// Level 2: adversarial audit.
//
// The asymmetry this exploits: generating a claim from a noisy transcript is
// error-prone, but auditing a clean, already-written claim against the real code is
// reliable. So a fresh examiner re-derives the answer from scratch.
//
// INDEPENDENCE IS THE WHOLE MECHANISM. The examiner receives ONLY the claim, its
// scope and its check. It never sees the transcript, the harvester's reasoning, the
// wrong assumption that produced the claim, or sibling candidates. If it inherited
// any of that it would inherit the misreading too, and would be confirming the
// harvester rather than the world. It also runs on a DIFFERENT model than extraction,
// so the two do not share blind spots.

const { execFileSync } = require('child_process');
const llm = require('./llm');
const fs = require('fs');
const path = require('path');
const repos = require('./repos');
const redact = require('./redact');

const DB_SCRIPT = path.join(require('./paths').installRoot(), 'scripts', 'db-readonly.sh');

function prompt(fact, dbAvailable) {
  const lines = [
    'You are auditing a single factual claim about a software ecosystem.',
    '',
    'YOUR JOB IS TO DISPROVE IT. Do not give the claim the benefit of the doubt. Do not',
    'reason about whether it sounds plausible. Go and look at the actual code and data.',
    'A claim that is almost right is wrong: if the claim says "hourly" and the code says',
    'every 30 minutes, that is DISPROVEN, not CONFIRMED.',
    '',
    '--- CLAIM UNDER AUDIT ---',
    fact.claim,
    '',
    'scope: ' + (fact.scope || []).join(', '),
    '',
    'A check was written for this claim. The check passing only proves the anchor text',
    'exists -- it does NOT prove the claim. Treat the check as a hint about where to',
    'look, and verify the CLAIM independently:',
    String(fact.check || '').trim(),
    '--- END CLAIM ---',
    '',
    'Investigate using the repositories you have read access to.',
  ];
  if (dbAvailable) {
    lines.push(
      'You also have READ-ONLY Postgres access. Run queries with exactly this command:',
      '  ' + DB_SCRIPT + ' "SELECT ..."',
      'It is SELECT-only and every statement is logged. Do not attempt any write.',
      'app_db and sports_db are separate schemas/databases in this cluster.');
  } else {
    lines.push('No database access is available in this run. If settling the claim requires',
      'data rather than code, that is a CANNOT-VERIFY, not a CONFIRMED.');
  }
  lines.push(
    '',
    'Then answer in EXACTLY this format, nothing else:',
    '',
    'VERDICT: <DISPROVEN|CONFIRMED|CANNOT-VERIFY>',
    'EVIDENCE: <what YOU found yourself. Cite file:line, or the query you ran and what',
    'it returned. Evidence must be something you independently located -- do not restate',
    'the claim or the check as evidence.>',
    '',
    'Rules for the verdict:',
    '- CONFIRMED  : you independently found evidence the claim is true, in full.',
    '- DISPROVEN  : you found evidence contradicting the claim, in whole or in part.',
    '- CANNOT-VERIFY: you could not settle it. Say what you would need.',
    'Partial truth is DISPROVEN. Guessing is CANNOT-VERIFY.');
  return lines.join('\n');
}

function parseVerdict(out) {
  const text = String(out || '');
  const vm = /VERDICT:\s*(DISPROVEN|CONFIRMED|CANNOT-VERIFY)/i.exec(text);
  const em = /EVIDENCE:\s*([\s\S]*)$/i.exec(text);
  return {
    verdict: vm ? vm[1].toUpperCase() : 'CANNOT-VERIFY',
    evidence: (em ? em[1] : text).replace(/\s+/g, ' ').trim().slice(0, 1200),
    parsed: !!vm,
  };
}

/**
 * Audit one fact. Returns { verdict, evidence, model, queries, raw }.
 * Everything sent to the model is scrubbed first; the claim itself is already
 * secret-free by construction, but a candidate is untrusted input like any other.
 */
function examine(fact, cfg, opts) {
  const options = opts || {};
  const model = options.model || cfg.models.examiner;
  const dbAvailable = cfg.db.enabled && fs.existsSync(DB_SCRIPT) && !options.noDb;
  const safe = Object.assign({}, fact, {
    claim: redact.scrub(String(fact.claim)).text,
    check: redact.scrub(String(fact.check || '')).text,
  });
  const p = redact.scrub(prompt(safe, dbAvailable)).text;

  const logPath = path.join(repos.GOTCHA_HOME, 'logs', 'db-queries.log');
  let logBefore = 0;
  try { logBefore = fs.statSync(logPath).size; } catch (e) { logBefore = 0; }

  const addDirs = cfg.examinerDirs.map((d) => repos.expand(d)).filter((d) => fs.existsSync(d));
  // Through llm.call so the examiner's real cost is charged to the same daily budget
  // the 5-minute harvest ticks draw on.
  const res = llm.call(p, {
    model,
    permissionMode: 'dontAsk',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash(' + DB_SCRIPT + ' *)'],
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'],
    addDirs,
    timeout: cfg.gauntlet.examinerTimeoutMs,
    cwd: repos.GOTCHA_HOME,
  });
  const out = res.text;
  const error = res.error;

  // Capture exactly the queries this examiner ran, for the dispute record.
  let queries = [];
  try {
    const all = fs.readFileSync(logPath, 'utf8');
    queries = all.slice(logBefore).split('\n').filter(Boolean).slice(0, 40);
  } catch (e) { queries = []; }

  const parsed = parseVerdict(out);
  if (error && !parsed.parsed) {
    return { verdict: 'CANNOT-VERIFY', evidence: 'examiner did not complete: ' + error, model, queries, raw: out };
  }
  return Object.assign(parsed, { model, queries, raw: String(out).slice(0, 4000) });
}

module.exports = { examine, prompt, parseVerdict, DB_SCRIPT };
