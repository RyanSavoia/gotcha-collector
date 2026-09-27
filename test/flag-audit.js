#!/usr/bin/env node
'use strict';
// Every flag the CLI reads must be declared as value-taking or boolean.
//
// A flag missing from VALUE_FLAGS is parsed as a boolean, so `--org X` becomes
// `{org: true}` and X is dropped. That shipped three times: `gh repo list true`
// once queried a real GitHub organisation named "true", and a clean-account
// install resolved `--facts-repo` to "<cwd>/true". The bug is invisible in review
// because the call site looks perfectly correct -- the declaration is somewhere
// else entirely. So the two lists are checked against actual usage instead.

const fs = require('fs');
const path = require('path');
const { VALUE_FLAGS, BOOLEAN_FLAGS } = require('../lib/util');

function scan(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scan(p, out);
    else if (/\.js$/.test(e.name)) {
      const src = fs.readFileSync(p, 'utf8');
      const re = /flags(?:\[['"]([a-z0-9-]+)['"]\]|\.([a-z0-9_]+))/g;
      let m;
      while ((m = re.exec(src))) {
        const k = m[1] || m[2];
        if (!out.has(k)) out.set(k, new Set());
        out.get(k).add(path.relative(path.join(__dirname, '..'), p));
      }
    }
  }
  return out;
}

function run() {
  const used = scan(path.join(__dirname, '..', 'lib'), new Map());
  used.delete('e');   // `catch (e)` inside a flags expression, not a flag
  const undeclared = [];
  const both = [];
  for (const [k, where] of used) {
    const v = VALUE_FLAGS.has(k), b = BOOLEAN_FLAGS.has(k);
    if (!v && !b) undeclared.push(k + '  (read in ' + Array.from(where).join(', ') + ')');
    if (v && b) both.push(k);
  }
  return { undeclared, both, count: used.size };
}

if (process.argv.indexOf('--check') !== -1) {
  const r = run();
  if (r.undeclared.length || r.both.length) {
    for (const u of r.undeclared) {
      console.error('  FAIL --' + u + ' is in neither VALUE_FLAGS nor BOOLEAN_FLAGS');
    }
    for (const b of r.both) console.error('  FAIL --' + b + ' is in BOTH sets');
    console.error('  Declare it in lib/util.js. A flag that takes a value MUST be in');
    console.error('  VALUE_FLAGS, or its value is silently dropped and it becomes `true`.');
    process.exit(1);
  }
  console.log('  flag audit OK: ' + r.count + ' flag(s), all declared');
  process.exit(0);
}

if (require.main === module) console.log(JSON.stringify(run(), null, 2));
module.exports = { run };
