'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
// GOTCHA_HOME relocates state.json, candidates/ and drafts/. Set by the test
// suite so a test run cannot race or clobber a real harvest's state file.
// Data lives in the XDG data dir (or GOTCHA_HOME when overridden), never beside
// the code -- an npm-global install has no writable directory of its own.
const GOTCHA_HOME = require('./paths').DATA_DIR;

function git(repoPath, args, opts) {
  try {
    return execFileSync('git', ['-C', repoPath].concat(args), {
      encoding: 'utf8', timeout: (opts && opts.timeout) || 10000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (e) { return null; }
}

function isRepo(p) {
  return !!p && fs.existsSync(path.join(p, '.git'));
}

/**
 * Resolve a repo path into the locations gotcha needs.
 * `here` is the directory holding facts.yaml; `root` is the directory the checks'
 * relative paths resolve against -- the parent of the repo, matching verify.sh's
 * default of $HERE/../.. (checks read "user-dashboard/app/...", not "app/...").
 */
/**
 * The repo's canonical name, taken from its origin remote rather than its directory.
 * A worktree lives in `client-platform-main` but IS `client-platform`, and fact scopes
 * and check paths are written against the real repo name -- matching on the directory
 * silently fails to find the table that covers it.
 */
function canonicalName(repoPath) {
  const url = git(repoPath, ['remote', 'get-url', 'origin']);
  if (url) {
    const m = /([^/:]+?)(?:\.git)?\/?$/.exec(url.trim());
    if (m && m[1]) return m[1];
  }
  return path.basename(repoPath);
}

function resolve(repoPath, opts) {
  const abs = path.resolve(expand(repoPath || '.'));
  const here = path.join(abs, 'repo-truth');
  const factsPath = path.join(here, 'facts.yaml');
  const root = (opts && opts.root) ? path.resolve(expand(opts.root)) : path.dirname(abs);
  return { repoPath: abs, name: canonicalName(abs), dirName: path.basename(abs), here, factsPath, root };
}

function expand(p) {
  if (p === '~') return HOME;
  if (p.indexOf('~/') === 0) return path.join(HOME, p.slice(2));
  return p;
}

/** Current branch plus ahead/behind against the remote default branch. */
function branchInfo(repoPath) {
  const branch = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']) || '(unknown)';
  let base = git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (!base) {
    for (const cand of ['origin/main', 'origin/master']) {
      if (git(repoPath, ['rev-parse', '--verify', '--quiet', cand])) { base = cand; break; }
    }
  }
  let ahead = null, behind = null;
  if (base) {
    const counts = git(repoPath, ['rev-list', '--left-right', '--count', base + '...HEAD']);
    if (counts) {
      const parts = counts.split(/\s+/);
      behind = parseInt(parts[0], 10);
      ahead = parseInt(parts[1], 10);
    }
  }
  return { branch, base, ahead, behind };
}

// In this ecosystem an underscore-prefixed file under scripts/ is diagnostic
// scratch, not source -- the owner's one-off audit/dig scripts all look like
// scripts/_audit-fb-final.mjs. Classifying them separately keeps preflight's
// untracked count from reading as "60 files of uncommitted work".
function isScratch(rel) {
  const base = path.basename(rel);
  if (/(^|\/)scripts\//.test(rel) && base.charAt(0) === '_') return true;
  if (base.charAt(0) === '_' && /\.(ts|tsx|js|mjs|cjs|sql|py)$/.test(base)) return true;
  if (/\.(log|tmp|bak|orig)$/.test(base)) return true;
  if (/^(out|tmp|scratch)\//.test(rel)) return true;
  return false;
}

function untracked(repoPath) {
  const out = git(repoPath, ['ls-files', '--others', '--exclude-standard']);
  const files = out ? out.split('\n').filter(Boolean) : [];
  const scratch = files.filter(isScratch);
  const source = files.filter((f) => !isScratch(f));
  return { total: files.length, scratch, source };
}

/**
 * Repos gotcha tracks. Configured only -- there is no default list, because a
 * default list is someone else's machine. `gotcha init` populates it.
 */
function tracked() {
  try {
    const cfg = require('./config').load();
    return (cfg.repos || []).map(expand).filter(isRepo);
  } catch (e) { return []; }
}

module.exports = { git, isRepo, resolve, canonicalName, expand, branchInfo, untracked, isScratch, tracked, HOME, GOTCHA_HOME };
