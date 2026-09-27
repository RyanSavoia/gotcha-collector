'use strict';
// Once-per-session fact suppression.
//
// A fact is a thing you learn, not a thing you get told repeatedly. The field
// report was blunt: the same three facts fired on ten-plus commands in one
// session, which trains an agent to skim past the hook entirely. So each fact
// speaks once per session -- and gets exactly one more turn if its STATUS
// changes, because "this became false since I told you" is new information.
//
// State is per-session files under the state dir. No database, no locking: a
// single small JSON per session, rewritten in place. Concurrent tool calls in one
// session can race, and the worst outcome is a fact firing twice. That is cheaper
// than a lock on a 100ms budget.

const fs = require('fs');
const path = require('path');
const os = require('os');

const TTL_MS = 48 * 60 * 60 * 1000;

function stateDir() {
  if (process.env.GOTCHA_SEEN_DIR) return process.env.GOTCHA_SEEN_DIR;
  const xdg = process.env.XDG_STATE_HOME && path.isAbsolute(process.env.XDG_STATE_HOME)
    ? process.env.XDG_STATE_HOME : path.join(os.homedir(), '.local', 'state');
  return path.join(xdg, 'gotcha', 'seen');
}

/** Session files older than the TTL are dead weight; drop a few per run. */
function prune(dir, now) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  let budget = 40;   // bounded work so a long-lived machine never pays a big bill
  for (const n of names) {
    if (budget-- <= 0) return;
    if (n.charAt(0) === '.') continue;
    const p = path.join(dir, n);
    try {
      if (now - fs.statSync(p).mtimeMs > TTL_MS) fs.unlinkSync(p);
    } catch (e) { /* vanished or unreadable; nothing to clean */ }
  }
}

/** A session id safe to use as a filename. */
function slug(sessionId) {
  const s = String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '');
  return s.slice(0, 120) || 'nosession';
}

function load(sessionId, now) {
  const dir = stateDir();
  const file = path.join(dir, slug(sessionId) + '.json');
  let seen = {};
  try {
    const st = fs.statSync(file);
    if (now - st.mtimeMs > TTL_MS) seen = {};          // stale session: start over
    else seen = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (e) { seen = {}; }
  return { dir, file, seen };
}

/**
 * Filter hits down to the ones this session has not been told yet.
 * Returns the fresh hits; records them as told.
 */
function filter(sessionId, hits, opts) {
  const now = (opts && opts.now) || Date.now();
  if (!hits.length) return hits;
  const { dir, file, seen } = load(sessionId, now);

  const fresh = [];
  for (const h of hits) {
    const prev = seen[h.f.id];
    // Unseen, or seen under a different status -- a status change earns one re-fire.
    if (!prev || prev.status !== h.f.status) {
      fresh.push(h);
      seen[h.f.id] = { status: h.f.status, at: now };
    }
  }
  if (!fresh.length) return fresh;

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(seen));
    prune(dir, now);
  } catch (e) { /* unwritable state must never block a tool call */ }
  return fresh;
}

module.exports = { filter, stateDir, slug, TTL_MS };
