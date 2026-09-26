'use strict';
// A tiny, pre-computed index for the pre-action hook.
//
// The hook runs before EVERY matching tool call, so it cannot afford to parse a
// 90KB fact table or call a model. It reads this instead: one small JSON of the
// only things a matcher needs. Rebuilt by `gotcha hooks install`, and cheap enough
// to rebuild after a verify or gauntlet run.

const fs = require('fs');
const path = require('path');
const facts = require('./facts');
const anchors = require('./anchors');
const repos = require('./repos');
const { writeFileAtomic } = require('./util');

const INDEX_PATH = path.join(repos.GOTCHA_HOME, 'hook-index.json');

function build(factsPath) {
  const doc = facts.parse(fs.readFileSync(factsPath, 'utf8'), { strict: false });
  const entries = [];
  for (const f of doc.facts) {
    const a = anchors.anchorsOf(f);
    // A fact with no anchor and no scope cannot be matched against an action.
    if (!a.length && !(f.scope || []).length) continue;
    entries.push({
      id: f.id,
      claim: String(f.claim).replace(/\s+/g, ' ').slice(0, 300),
      status: f.status,
      verified_at: f.verified_at,
      scope: f.scope || [],
      anchors: a,
      // Basenames let a shell command match without a full path.
      bases: Array.from(new Set(a.map((p) => path.basename(p)))),
      enforce: f.enforce === 'true' || f.enforce === true,
    });
  }
  return { version: 1, built: new Date().toISOString(), source: factsPath, facts: entries };
}

function write(factsPath) {
  const idx = build(factsPath);
  writeFileAtomic(INDEX_PATH, JSON.stringify(idx) + '\n');
  return idx;
}

module.exports = { build, write, INDEX_PATH };
