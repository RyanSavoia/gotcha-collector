'use strict';
// `gotcha audit-claim <candidate-id>` -- run Level 2 alone, for inspection.
const fs = require('fs');
const path = require('path');
const facts = require('../facts');
const repos = require('../repos');
const config = require('../config');
const examiner = require('../examiner');
const { candidateFiles } = require('./gauntlet-run');

function findCandidate(id) {
  for (const file of candidateFiles()) {
    const doc = facts.parse(fs.readFileSync(file, 'utf8'), { strict: false });
    const f = doc.facts.find((x) => x.id === id);
    if (f) return { f, file };
  }
  // also allow auditing a fact already in the table
  const t = config.factsPath();
  if (fs.existsSync(t)) {
    const doc = facts.parse(fs.readFileSync(t, 'utf8'), { strict: false });
    const f = doc.facts.find((x) => x.id === id);
    if (f) return { f, file: t };
  }
  return null;
}

function run(argv, flags) {
  const id = argv[0];
  if (!id) { console.error('usage: gotcha audit-claim <candidate-id> [--model M] [--no-db]'); return 2; }
  const hit = findCandidate(id);
  if (!hit) { console.error('gotcha audit-claim: no candidate or fact with id ' + id); return 2; }
  const cfg = config.load();
  const model = flags.model || cfg.models.examiner;

  console.log('auditing ' + id);
  console.log('  examiner model: ' + model + '  (harvest used: ' + cfg.models.harvest + ')');
  console.log('  the examiner sees ONLY the claim, scope and check — never the transcript');
  console.log('');
  const t = Date.now();
  const r = examiner.examine(hit.f, cfg, { model, noDb: !!flags['no-db'] });
  console.log('  VERDICT: ' + r.verdict + '   (' + ((Date.now() - t) / 1000).toFixed(0) + 's)');
  console.log('');
  console.log('  EVIDENCE: ' + r.evidence);
  if (r.queries.length) {
    console.log('');
    console.log('  DB queries run (' + r.queries.length + ', logged):');
    for (const q of r.queries.slice(0, 8)) console.log('    ' + q.slice(0, 160));
  }
  return r.verdict === 'DISPROVEN' ? 1 : 0;
}

module.exports = { run };
