'use strict';
const facts = require('../facts');
const repos = require('../repos');
const table = require('../table');

const BUDGET = 2048;      // output must stay pasteable into an agent's context
const CLAIM_CHARS = 150;

function clip(text, n) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function run(argv, flags) {
  const target = repos.resolve(argv[0] || '.', { root: flags.root });
  const out = [];
  out.push('PREFLIGHT ' + target.name);

  if (!repos.isRepo(target.repoPath)) {
    out.push('  not a git repo: ' + target.repoPath);
    process.stdout.write(out.join('\n') + '\n');
    return 2;
  }

  const b = repos.branchInfo(target.repoPath);
  let line = '  branch ' + b.branch;
  if (b.base) {
    line += ' vs ' + b.base;
    if (b.ahead !== null) line += ' (+' + b.ahead + '/-' + b.behind + ')';
  } else line += ' (no remote default)';
  out.push(line);

  const u = repos.untracked(target.repoPath);
  out.push('  untracked ' + u.total + ': ' + u.source.length + ' source-looking, ' + u.scratch.length + ' scratch/diagnostic');
  if (u.source.length) out.push('    source: ' + clip(u.source.slice(0, 3).join(', ') + (u.source.length > 3 ? ', +' + (u.source.length - 3) + ' more' : ''), 110));

  const found = table.findFor(target.repoPath);
  if (!found) {
    out.push('  NO FACT TABLE found for this repo.');
    process.stdout.write(out.join('\n') + '\n');
    return 0;
  }
  let doc;
  try { doc = table.loadFound(found); }
  catch (e) { out.push('  fact table unreadable: ' + e.message); process.stdout.write(out.join('\n') + '\n'); return 1; }

  const mine = doc.facts.filter((f) => f.scope.indexOf(target.name) !== -1 || f.scope.indexOf('cross-repo') !== -1);
  const failed = doc.facts.filter((f) => f.status === 'failed');
  let src = found.own ? '' : ' (table in ' + found.owner + ')';
  if (found.offTree) src = ' (from ' + found.ref + '; not in this working tree)';
  out.push('  facts ' + doc.facts.length + ' total, ' + mine.length + ' in scope' + src);

  // Every disproven claim, always: these are the beliefs an agent must not act on.
  if (failed.length) {
    out.push('');
    out.push('  DISPROVEN — do not rely on these:');
    for (const f of failed) out.push('   x ' + f.id + ': ' + clip(f.claim, CLAIM_CHARS));
  }

  const top = table.pick(mine.filter((f) => f.status !== 'failed'), target.name, 5);
  if (top.length) {
    out.push('');
    out.push('  Most relevant facts:');
    for (const f of top) {
      const mark = f.status === 'verified' ? 'v' : f.status === 'human-asserted' ? '?' : '~';
      out.push('   ' + mark + ' ' + f.id + ': ' + clip(f.claim, CLAIM_CHARS));
    }
  }
  out.push('');
  out.push('  v verified  ? human-asserted (probable, unproven)  x failed (DISPROVEN)  ~ runtime');

  let text = out.join('\n') + '\n';
  // Hard budget: trim relevant facts (never the disproven ones) until it fits.
  while (Buffer.byteLength(text, 'utf8') > BUDGET && top.length) {
    top.pop();
    const idx = out.lastIndexOf('  Most relevant facts:');
    out.splice(idx + 1 + top.length, 1);
    text = out.join('\n') + '\n';
  }
  process.stdout.write(text);
  return 0;
}

module.exports = { run };
