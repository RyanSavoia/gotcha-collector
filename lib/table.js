'use strict';
// Locating the fact table that governs a given repo. A repo may carry its own
// repo-truth/facts.yaml; in this ecosystem one table (user-dashboard's) covers all
// three repos via each fact's `scope`, so we also accept a tracked repo's table
// that scopes the repo we were asked about.

const fs = require('fs');
const path = require('path');
const facts = require('./facts');
const repos = require('./repos');

/**
 * Read repo-truth/facts.yaml out of a repo's default branch without touching the
 * working tree. A table that exists on main but not on the checked-out feature
 * branch is precisely when an agent most needs its warnings, and checking out a
 * branch under the owner is not ours to do. Read-only callers only: the sidecar
 * files the shared check helpers need (orphan-candidates.txt, web-route-groups.tsv)
 * are not materialized here, so `verify` must not use this path.
 */
function fromDefaultBranch(repoPath) {
  const b = repos.branchInfo(repoPath);
  const refs = [];
  if (b.base) refs.push(b.base);
  refs.push('origin/main', 'origin/master', 'main', 'master');
  for (const ref of refs) {
    const text = repos.git(repoPath, ['show', ref + ':repo-truth/facts.yaml']);
    if (text) return { text, ref };
  }
  return null;
}

function findFor(repoPath) {
  const target = repos.resolve(repoPath);
  if (fs.existsSync(target.factsPath)) {
    return { factsPath: target.factsPath, here: target.here, owner: target.name, own: true };
  }
  const blob = fromDefaultBranch(target.repoPath);
  if (blob) {
    return { text: blob.text, ref: blob.ref, here: target.here, owner: target.name, own: true, offTree: true };
  }
  // No table of its own: fall back to a tracked repo whose table scopes this repo.
  // In this ecosystem user-dashboard's table covers all three.
  for (const other of repos.tracked()) {
    const r = repos.resolve(other);
    if (r.repoPath === target.repoPath) continue;
    let source = null;
    if (fs.existsSync(r.factsPath)) source = { factsPath: r.factsPath };
    else {
      const otherBlob = fromDefaultBranch(r.repoPath);
      if (otherBlob) source = { text: otherBlob.text, ref: otherBlob.ref, offTree: true };
    }
    if (!source) continue;
    try {
      const doc = source.text !== undefined
        ? facts.parse(source.text, { strict: false })
        : facts.load(source.factsPath, { strict: false });
      if (doc.facts.some((f) => f.scope.indexOf(target.name) !== -1)) {
        return Object.assign({ here: r.here, owner: r.name, own: false }, source);
      }
    } catch (e) { /* skip unreadable table */ }
  }
  return null;
}

// Facts a human starting a session actually needs. Mechanical endpoint contracts
// (contract-api-*) are numerous and low-surprise, so they lose to the facts that
// encode traps: things already disproven, retired, contradictory or malformed.
function relevance(fact, repoName) {
  let score = 0;
  if (fact.scope.indexOf(repoName) !== -1) score += 10;
  if (fact.scope.length === 1 && fact.scope[0] === repoName) score += 5;
  if (fact.scope.indexOf('cross-repo') !== -1) score += 2;
  if (/^(failed|retired|contradiction|malformed|dead|orphan)/.test(fact.id)) score += 6;
  if (fact.note) score += 2;
  if (fact.open_decision) score += 3;
  if (/^contract-api-/.test(fact.id)) score -= 6;
  if (fact.status === 'human-asserted') score += 1;
  return score;
}

function rank(list, repoName) {
  return list.slice().sort((a, b) => relevance(b, repoName) - relevance(a, repoName) || a.id.localeCompare(b.id));
}

/**
 * Top-n by relevance, but at most one fact per id family on the first pass.
 * The table has families of near-identical facts (vercel-*, contract-api-*); five
 * slots spent on five Vercel cron entries tells a session almost nothing, whereas
 * five different families is a real briefing. Remaining slots are backfilled by
 * score once every family has had a turn.
 */
function pick(list, repoName, n) {
  const ranked = rank(list, repoName);
  const chosen = [];
  const seen = Object.create(null);
  for (const f of ranked) {
    const family = String(f.id).split('-')[0];
    if (seen[family]) continue;
    seen[family] = true;
    chosen.push(f);
    if (chosen.length >= n) return chosen;
  }
  for (const f of ranked) {
    if (chosen.indexOf(f) !== -1) continue;
    chosen.push(f);
    if (chosen.length >= n) break;
  }
  return chosen;
}

/** Parse whichever source findFor() returned. */
function loadFound(found) {
  if (found.text !== undefined) return facts.parse(found.text, { strict: false });
  return facts.load(found.factsPath, { strict: false });
}

module.exports = { findFor, loadFound, rank, pick, relevance, fromDefaultBranch };
