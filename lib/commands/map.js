'use strict';
// `gotcha map` -- answer relationship questions offline from the graph.
//
//   gotcha map url data.thebettinginsider.com   -> which repo powers this URL
//   gotcha map repo client-platform             -> everything attached to a repo
//   gotcha map verify                           -> re-check every edge

const fs = require('fs');
const path = require('path');
const topo = require('../topology');
const checks = require('../checks');
const repos = require('../repos');
const config = require('../config');
const { writeFileAtomic, today } = require('../util');

function findTopology() {
  const p = topo.topologyPathFor(config.factsRepo());
  return fs.existsSync(p) ? p : null;
}

function describe(e) {
  return '  ' + e.from + '  --[' + e.type + ']-->  ' + e.to + '\n' +
    '      status: ' + e.status + ' (verified ' + e.verified_at + ')\n' +
    '      evidence: ' + (e.evidence || []).join('; ');
}

function run(argv, flags) {
  const p = flags.file ? path.resolve(repos.expand(String(flags.file))) : findTopology();
  if (!p) { console.error('gotcha map: no repo-truth/topology.yaml found'); return 2; }
  let doc;
  try { doc = topo.load(p, { strict: false }); }
  catch (e) { console.error('gotcha map: ' + e.message); return 2; }

  const kind = argv[0];
  const name = argv[1];

  if (kind === 'verify') {
    const root = path.resolve(repos.expand(String(flags.root || repos.HOME)));
    const here = path.dirname(p);
    let pass = 0, fail = 0, runtime = 0;
    const updates = [];
    for (const e of doc.edges) {
      if (/^\s*unresolved /.test(e.check)) { runtime++; console.log('  RUNTIME-NOT-RECHECKED ' + e.id); continue; }
      const r = checks.runCheck(e.check, { root, here });
      if (r.rc === 0) { pass++; console.log('  PASS ' + e.id); }
      else { fail++; console.log('  FAIL ' + e.id + ' -- ' + (r.output || '')); updates.push(e.id); }
    }
    console.log('');
    console.log('  edges=' + doc.edges.length + ' pass=' + pass + ' fail=' + fail + ' runtime=' + runtime);
    return fail ? 1 : 0;
  }

  if (!kind) {
    console.log('topology: ' + doc.edges.length + ' edges');
    const nodes = new Set();
    for (const e of doc.edges) { nodes.add(e.from); nodes.add(e.to); }
    console.log('  nodes: ' + nodes.size);
    for (const e of doc.edges) console.log(describe(e));
    return 0;
  }

  const node = name ? kind + ':' + name : kind;
  const outward = topo.out(doc.edges, node);
  const inward = topo.into(doc.edges, node);
  if (!outward.length && !inward.length) {
    console.log('gotcha map: nothing recorded for ' + node);
    console.log('  Known nodes of this kind: ' +
      Array.from(new Set(doc.edges.flatMap((e) => [e.from, e.to]).filter((n) => n.indexOf(kind + ':') === 0)))
        .join(', ') || '(none)');
    return 1;
  }
  console.log(node);
  for (const e of outward) {
    console.log('');
    console.log(describe(e));
    // One hop further: "which repo" usually wants the repo's branch and deploy too.
    for (const n of topo.out(doc.edges, e.to)) {
      console.log('      -> ' + n.to + ' [' + n.type + ']');
    }
  }
  for (const e of inward) {
    console.log('');
    console.log(describe(e) + '   (incoming)');
  }
  return 0;
}

module.exports = { run, findTopology };
