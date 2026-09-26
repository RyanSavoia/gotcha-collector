'use strict';
// Which files does a fact depend on?
//
// A fact's evidence lines and its check both name paths. Those paths are the fact's
// anchors: if a pull request touches one, the fact's claim might no longer hold, and
// that is the moment to re-check it -- not next Monday.
//
// Paths are repo-prefixed in the table ("user-dashboard/app/x.ts") because checks
// resolve against a directory holding all three clones. A PR reports repo-relative
// paths ("app/x.ts"), so matching strips the prefix for the repo under test.

// Repo names are configured, not compiled in. A path anchor is "<repo>/<path>",
// so the set of repo names IS the grammar -- baking in one user's repos made the
// tool silently useless to anyone else.
function repoNames() {
  try {
    const cfg = require('./config').load();
    const names = (cfg.repos || []).map((r) => require('path').basename(require('./repos').expand(r)));
    if (names.length) return names;
  } catch (e) { /* fall through */ }
  return [];
}

function pathRe(names) {
  const list = (names && names.length ? names : repoNames());
  if (!list.length) return /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_\-./@]+\.[A-Za-z0-9]+/g;
  const alt = list.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp('\\b(?:' + alt + ')\\/[A-Za-z0-9_\\-./@]+\\.[A-Za-z0-9]+', 'g');
}

/** Repo-prefixed anchor paths a fact depends on (evidence + check), deduped. */
function anchorsOf(fact) {
  const hay = [].concat(fact.evidence || []).join('\n') + '\n' + String(fact.check || '');
  const found = hay.match(pathRe()) || [];
  return Array.from(new Set(found.map((p) => p.replace(/[:#].*$/, ''))));
}

function splitAnchor(anchor) {
  const i = anchor.indexOf('/');
  return i === -1 ? { repo: null, rel: anchor } : { repo: anchor.slice(0, i), rel: anchor.slice(i + 1) };
}

/**
 * Facts whose anchors intersect the changed files of one repo.
 * changed: repo-relative paths, as a PR reports them.
 * Returns [{ fact, hits: [anchor...] }].
 */
function affected(allFacts, repoName, changed) {
  const changedSet = new Set(changed);
  const out = [];
  for (const fact of allFacts) {
    const hits = anchorsOf(fact).filter((a) => {
      const s = splitAnchor(a);
      return s.repo === repoName && changedSet.has(s.rel);
    });
    if (hits.length) out.push({ fact, hits });
  }
  return out;
}

/** Does every anchor still exist under root? A moved/deleted anchor cannot be checked. */
function missingAnchors(fact, root, fs, path) {
  return anchorsOf(fact).filter((a) => !fs.existsSync(path.join(root, a)));
}

module.exports = { anchorsOf, affected, splitAnchor, missingAnchors, repoNames, pathRe };
