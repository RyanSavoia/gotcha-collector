'use strict';
// Create repo-truth/ in a repo that has none.
//
// gotcha shipped with pointer files, a harvester and a gauntlet, but nothing that
// produced the one thing they all read: the fact table and its verifier. The only
// verify.sh in existence was the author's, and it hardcoded `for repo in
// user-dashboard client-platform ios-app`. A clean-account acceptance run got all
// the way to a PROMOTE verdict and then rolled the batch back with
// "INFRA-FAIL missing clone user-dashboard".
//
// The template is the shipped verifier with its two repo-specific spots turned
// into variables; test/run.sh diffs them to keep it that way.

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./util');

const TEMPLATE = path.join(__dirname, 'templates', 'verify.sh');

// verify.sh rejects a table with no facts ("SCHEMA-ERROR header: zero facts"), so
// a scaffolded table cannot be empty. The seed is a real, checkable claim about the
// table itself: true the moment it is written, and it doubles as a worked example
// of the format for whoever writes the second fact.
function seedTable(repoName, when) {
  return [
    'schema_version: 1',
    '# Facts this repo asserts about itself. Each carries evidence and a check that',
    '# can re-prove it; `bash repo-truth/verify.sh <dir-with-the-clones>` runs them',
    '# all. A claim whose check stops passing becomes status: failed, not deleted.',
    'facts:',
    '  - id: repo-truth-is-verified-offline',
    '    claim: "This repo\'s fact table is checked by repo-truth/verify.sh, which runs offline using only bash and git and never executes application code."',
    '    scope: [' + JSON.stringify(repoName) + ']',
    '    evidence: [' + JSON.stringify(repoName + '/repo-truth/verify.sh') + ']',
    '    check: |',
    '      file ' + JSON.stringify(repoName + '/repo-truth/verify.sh'),
    '    status: verified',
    '    verified_at: ' + JSON.stringify(when),
    '    note: "Seeded by `gotcha init` so the table is valid from the first run. Safe to delete once you have facts of your own."',
    '',
  ].join('\n');
}

function renderVerifier(repoNames) {
  const names = (repoNames || []).filter(Boolean);
  if (!names.length) throw new Error('scaffold: at least one repo name is required');
  return fs.readFileSync(TEMPLATE, 'utf8')
    .replace('__GOTCHA_REPOS__', names.join(' '))
    .replace('__GOTCHA_ORPHAN_REPO__', names[0]);
}

/**
 * Ensure <repo>/repo-truth exists. Never overwrites: an existing verifier or table
 * is the owner's, and silently replacing either would be the worst kind of help.
 */
function ensure(factsRepo, repoNames) {
  const dir = path.join(factsRepo, 'repo-truth');
  const verifier = path.join(dir, 'verify.sh');
  const table = path.join(dir, 'facts.yaml');
  const created = [];
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(verifier)) {
    writeFileAtomic(verifier, renderVerifier(repoNames));
    fs.chmodSync(verifier, 0o755);
    created.push('repo-truth/verify.sh');
  }
  if (!fs.existsSync(table)) {
    writeFileAtomic(table, seedTable(path.basename(factsRepo), new Date().toISOString().slice(0, 10)));
    created.push('repo-truth/facts.yaml');
  }
  return { dir, created, verifier, table };
}

module.exports = { ensure, renderVerifier, seedTable, TEMPLATE };
