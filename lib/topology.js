'use strict';
// The relationship map: a small typed graph over the same evidence discipline as
// facts. Every edge carries evidence and a runnable check, and is re-verified in the
// weekly sweep. Model only what can be proven -- a graph of guesses is worse than no
// graph, because it looks authoritative.
//
// Nodes are "kind:name" strings (url:, repo:, branch:, db:, deploy:, service:).
// The grammar mirrors facts.yaml deliberately: same quoting, same check block, so
// the same reviewer instincts apply.

const fs = require('fs');
const path = require('path');
const facts = require('./facts');

const REQUIRED = ['from', 'to', 'type', 'evidence', 'check', 'status', 'verified_at'];
const OPTIONAL = ['note', 'recheck'];
const STATUSES = ['verified', 'verified-runtime', 'human-asserted', 'failed'];

function parse(text, opts) {
  const strict = !(opts && opts.strict === false);
  const lines = text.split('\n');
  const edges = [];
  let cur = null;
  let inCheck = false;

  const finish = (end) => {
    if (!cur) return;
    while (end > cur.start && lines[end].trim() === '') end--;
    cur.end = end;
    cur.check = cur.checkLines.join('\n');
    if (cur.check && !/\n$/.test(cur.check)) cur.check += '\n';
    delete cur.checkLines;
    if (strict) {
      for (const f of REQUIRED) {
        if (cur[f] === undefined || cur[f] === '') throw new Error('edge ' + cur.id + ': missing ' + f);
      }
      if (STATUSES.indexOf(cur.status) === -1) throw new Error('edge ' + cur.id + ': invalid status');
    }
    edges.push(cur);
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf('  - id: ') === 0) {
      finish(i - 1);
      cur = { id: line.slice(8).trim(), evidence: [], checkLines: [], start: i, end: i, optionalOrder: [] };
      inCheck = false;
      continue;
    }
    if (!cur) continue;
    if (inCheck) {
      if (line.indexOf('      ') === 0) { cur.checkLines.push(line.slice(6)); continue; }
      inCheck = false;
    }
    if (line === '    check: |') { inCheck = true; continue; }
    const m = /^    ([a-z_]+): (.*)$/.exec(line);
    if (!m) continue;
    const k = m[1];
    let v = m[2];
    try { v = JSON.parse(v); } catch (e) { /* inline array or bare */ }
    if (k === 'evidence' && typeof v === 'string') { try { v = JSON.parse(m[2]); } catch (e) { v = [m[2]]; } }
    cur[k] = v;
    if (OPTIONAL.indexOf(k) !== -1) cur.optionalOrder.push(k);
  }
  finish(lines.length - 1);
  return { lines, edges };
}

function render(e) {
  const out = ['  - id: ' + e.id];
  out.push('    from: ' + facts.encodeScalar(e.from));
  out.push('    to: ' + facts.encodeScalar(e.to));
  out.push('    type: ' + facts.encodeScalar(e.type));
  out.push('    evidence: ' + facts.encodeList(e.evidence));
  out.push('    check: |');
  for (const l of String(e.check).replace(/\n+$/, '').split('\n')) out.push('      ' + l);
  out.push('    status: ' + e.status);
  out.push('    verified_at: ' + facts.encodeScalar(e.verified_at));
  const order = (e.optionalOrder || []).slice();
  for (const f of OPTIONAL) if (order.indexOf(f) === -1) order.push(f);
  for (const f of order) if (e[f]) out.push('    ' + f + ': ' + facts.encodeScalar(e[f]));
  return out;
}

function serialize(edges, header) {
  return (header || 'schema_version: 1\nedges:') + '\n' + edges.map((e) => render(e).join('\n')).join('\n') + '\n';
}

function load(p, opts) {
  return parse(fs.readFileSync(p, 'utf8'), opts);
}

function topologyPathFor(repoPath) {
  return path.join(repoPath, 'repo-truth', 'topology.yaml');
}

/** Follow edges out of a node. */
function out(edges, node) { return edges.filter((e) => e.from === node); }
function into(edges, node) { return edges.filter((e) => e.to === node); }

module.exports = { parse, render, serialize, load, out, into, topologyPathFor, REQUIRED, OPTIONAL, STATUSES };
