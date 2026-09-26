'use strict';
// `gotcha promote <candidate-id>` -- move a reviewed candidate into a repo's real
// fact table. The candidate's check is RUN first: if it passes offline the fact
// enters as `verified`, otherwise as `human-asserted`. Never commits.

const fs = require('fs');
const path = require('path');
const facts = require('../facts');
const checks = require('../checks');
const repos = require('../repos');
const redact = require('../redact');
const { writeFileAtomic, today } = require('../util');

const CANDIDATE_DIR = path.join(repos.GOTCHA_HOME, 'candidates');

function candidateFiles() {
  try {
    return fs.readdirSync(CANDIDATE_DIR).filter((f) => /\.yaml$/.test(f)).sort()
      .map((f) => path.join(CANDIDATE_DIR, f));
  } catch (e) { return []; }
}

function findCandidate(id) {
  for (const file of candidateFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    let doc;
    try { doc = facts.parse(text, { strict: false }); } catch (e) { continue; }
    const hit = doc.facts.find((f) => f.id === id);
    if (hit) return { file, text, doc, fact: hit };
  }
  return null;
}

function run(argv, flags) {
  const id = argv[0];
  // No id: the gauntlet decides, with no human in the loop. This is the normal path.
  if (!id) return require('./gauntlet-run').run(argv, flags);
  if (!flags.force && !flags.list) {
    console.error('gotcha promote: promoting a single candidate bypasses the gauntlet.');
    console.error('  Run `gotcha promote` with no id to let the gauntlet decide, or');
    console.error('  `gotcha promote ' + id + ' --force` to override it deliberately.');
    return 2;
  }
  if (flags.list) {
    console.error('usage: gotcha promote <candidate-id> [--repo PATH]');
    const all = [];
    for (const file of candidateFiles()) {
      try {
        for (const f of facts.parse(fs.readFileSync(file, 'utf8'), { strict: false }).facts) {
          all.push('  ' + f.id + (f.promoted ? '  (promoted ' + f.promoted + ')' : ''));
        }
      } catch (e) { /* skip */ }
    }
    if (all.length) { console.error('\navailable candidates:'); console.error(all.join('\n')); }
    return 2;
  }

  const found = findCandidate(id);
  if (!found) { console.error('gotcha promote: no candidate with id ' + id); return 2; }
  if (found.fact.promoted) {
    console.error('gotcha promote: ' + id + ' was already promoted on ' + found.fact.promoted);
    return 2;
  }

  const target = repos.resolve(flags.repo || argv[1] || path.join(repos.HOME, 'user-dashboard'), { root: flags.root });
  if (!fs.existsSync(target.factsPath)) {
    console.error('gotcha promote: no fact table at ' + target.factsPath);
    const head = repos.git(target.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const table = require('../table');
    const blob = table.fromDefaultBranch(target.repoPath);
    if (head) console.error('  ' + target.name + ' is on branch ' + head + '.');
    if (blob) {
      console.error('  The table DOES exist on ' + blob.ref + ', just not in this working tree.');
      console.error('');
      console.error('  Promotion writes a file, so it needs the table checked out. Safest option is a');
      console.error('  worktree, which leaves your current branch and uncommitted work untouched:');
      console.error('');
      console.error('    git -C ' + target.repoPath + ' worktree add ../' + target.name + '-main ' +
        blob.ref.replace(/^origin\//, ''));
      console.error('    gotcha promote ' + (argv[0] || '<id>') + ' --repo ../' + target.name + '-main');
      console.error('');
      console.error('  Remove it afterwards with: git -C ' + target.repoPath + ' worktree remove ../' + target.name + '-main');
      console.error('');
      console.error('  Note: the worktree holds the TABLE. The checks still run against the clones');
      console.error('  under --root (default: ' + target.root + '), which is what you want for');
      console.error('  cross-repo facts -- but it means a check sees your CURRENT branch, not main.');
    } else {
      console.error('  Promotion writes to the repo, so the table must be in the working tree.');
    }
    return 2;
  }

  const cand = found.fact;
  // Run the check before trusting it. This is the whole point of the product:
  // a claim earns `verified` by passing, not by being asserted confidently.
  const { rc, output } = checks.runCheck(cand.check, { root: target.root, here: target.here });
  const runnable = !/^\s*unresolved /.test(cand.check);
  const status = (runnable && rc === 0) ? 'verified' : 'human-asserted';

  const note = [
    cand.note || '',
    'Promoted from candidate ' + cand.id + ' on ' + today() + '.',
    status === 'verified' ? 'Check passed at promotion.' :
      (runnable ? 'Check did not pass at promotion (exit ' + rc + '): ' + (output || 'no output') + ' Confirm manually.'
                : 'No offline check available; confirm with the owner.'),
  ].filter(Boolean).join(' ');

  const promoted = {
    id: cand.id,
    claim: cand.claim,
    scope: cand.scope,
    evidence: cand.evidence,
    check: cand.check,
    status,
    verified_at: today(),
    note: redact.scrub(note).text.replace(/\s+/g, ' ').trim(),
  };
  if (redact.looksSecret(JSON.stringify(promoted))) {
    console.error('gotcha promote: refusing -- candidate still matches a secret pattern.');
    return 2;
  }

  const src = fs.readFileSync(target.factsPath, 'utf8');
  const doc = facts.parse(src, { strict: false });
  if (doc.facts.some((f) => f.id === promoted.id)) {
    console.error('gotcha promote: ' + promoted.id + ' already exists in ' + target.factsPath);
    return 2;
  }
  const lines = src.split('\n');
  const last = doc.facts[doc.facts.length - 1];
  const at = last ? last.end + 1 : lines.length;
  lines.splice(at, 0, ...facts.render(promoted));
  const updated = lines.join('\n');
  // Re-parse strictly: never leave a table the CI verifier would reject.
  try { facts.parse(updated, { strict: true }); }
  catch (e) { console.error('gotcha promote: refusing -- result would not parse: ' + e.message); return 2; }
  writeFileAtomic(target.factsPath, updated);

  // Mark the candidate so it is not promoted twice.
  const marked = found.text.split('\n');
  const cdoc = facts.parse(found.text, { strict: false });
  const cf = cdoc.facts.find((f) => f.id === id);
  marked.splice(cf.end + 1, 0, '    promoted: ' + facts.encodeScalar(today()));
  writeFileAtomic(found.file, marked.join('\n'));

  console.log('promoted ' + promoted.id + ' -> ' + target.factsPath);
  console.log('  status: ' + status + (runnable ? ' (check exit ' + rc + ')' : ' (no runnable check)'));
  if (output) console.log('  check output: ' + output);
  console.log('  NOT committed. Review with: git -C ' + target.repoPath + ' diff -- repo-truth/facts.yaml');
  return 0;
}

module.exports = { run };
