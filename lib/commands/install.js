'use strict';
const path = require('path');
const fs = require('fs');
const markers = require('../markers');
const repos = require('../repos');

// One pointer, three conventions. Kept short on purpose: this text is prepended to
// every agent session in the repo, so it buys its context budget by naming the file
// and explaining what each status means -- nothing else.
function pointerBody(factsRel) {
  return [
    '## Repo truth: check facts before assuming',
    '',
    'Before assuming anything about this ecosystem, read `' + factsRel + '` — verified',
    'facts with evidence and runnable checks.',
    '',
    '- `verified` — a check re-ran and passed. Trust it.',
    '- `human-asserted` — probable, but no offline proof. Confirm before relying on it.',
    '- `failed` — DISPROVEN. Do not rely on it; the claim was tested and contradicted.',
    '',
    'If that file is not in the working tree, the table lives on the default branch,',
    'not on your feature branch. Read it without checking anything out:',
    '',
    '```sh',
    'git -C ~/user-dashboard show origin/main:repo-truth/facts.yaml',
    '```',
    '',
    'Run `gotcha preflight .` at session start for branch state and the facts that',
    'matter here — it resolves the table either way. Facts are re-verified by',
    '`gotcha verify`; do not edit statuses by hand.',
  ].join('\n');
}

const CURSOR_FRONTMATTER = '---\ndescription: Repo truth — verified facts, evidence and checks\nalwaysApply: true\n---\n\n';

function run(argv, flags) {
  const target = repos.resolve(argv[0] || '.', { root: flags.root });
  if (!repos.isRepo(target.repoPath)) {
    console.error('gotcha install: not a git repo: ' + target.repoPath);
    return 2;
  }
  // Point at the repo's own table when it has one, otherwise at whichever tracked
  // repo's table covers this repo. Discovery goes through table.findFor, which also
  // finds a table that exists on the default branch but is not currently checked
  // out -- writing `repo-truth/facts.yaml` into a repo that has no repo-truth/
  // directory sends every agent to a path that does not exist.
  const table = require('../table');
  let factsRel = 'repo-truth/facts.yaml';
  if (!fs.existsSync(target.factsPath)) {
    const found = table.findFor(target.repoPath);
    if (found && !found.own) {
      factsRel = path.join(repos.HOME, found.owner, 'repo-truth', 'facts.yaml').replace(repos.HOME, '~');
    } else {
      const owner = repos.tracked()
        .map((p) => path.join(p, 'repo-truth', 'facts.yaml'))
        .filter((p) => fs.existsSync(p))[0];
      if (owner) factsRel = owner.replace(repos.HOME, '~');
    }
  }
  const body = pointerBody(factsRel);

  const targets = [
    { rel: 'CLAUDE.md', prefix: '' },
    { rel: 'AGENTS.md', prefix: '' },
    { rel: path.join('.cursor', 'rules', 'repo-truth.mdc'), prefix: CURSOR_FRONTMATTER },
  ];
  console.log('gotcha install ' + target.repoPath);
  console.log('  pointing at: ' + factsRel);
  let changed = 0;
  for (const t of targets) {
    const dest = path.join(target.repoPath, t.rel);
    const result = markers.upsert(dest, body, t.prefix);
    if (result !== 'unchanged') changed++;
    console.log('  ' + String(result).padEnd(10) + ' ' + t.rel);
  }
  console.log('');
  console.log(changed ? '  ' + changed + ' file(s) changed — NOT committed. Review with: git -C ' + target.repoPath + ' status'
                      : '  already installed; nothing changed.');
  return 0;
}

module.exports = { run, pointerBody };
