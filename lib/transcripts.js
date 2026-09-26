'use strict';
// Discovery and incremental reading of agent session transcripts.
// Three tools, three JSONL shapes; everything is normalized to {role, text}.
// Reading is offset-based: we consume only whole lines, so a session still being
// written to is picked up from the right place on the next run.

const fs = require('fs');
const path = require('path');
const repos = require('./repos');

const DEFAULT_SOURCES = [
  { tool: 'cursor', root: path.join(repos.HOME, '.cursor', 'projects') },
  { tool: 'claude-code', root: path.join(repos.HOME, '.claude', 'projects') },
  { tool: 'codex', root: path.join(repos.HOME, '.codex', 'sessions') },
];

/**
 * GOTCHA_TRANSCRIPT_ROOTS overrides the scan locations, as
 * "tool=/path:tool=/path". Exists so the redaction tests can run against a scratch
 * corpus instead of writing fixtures into the user's real Cursor/Codex data.
 */
function sources() {
  const override = process.env.GOTCHA_TRANSCRIPT_ROOTS;
  if (!override) return DEFAULT_SOURCES;
  return override.split(':').map((part) => {
    const eq = part.indexOf('=');
    return eq === -1
      ? { tool: 'cursor', root: part }
      : { tool: part.slice(0, eq), root: part.slice(eq + 1) };
  }).filter((s) => s.root);
}

const SOURCES = DEFAULT_SOURCES;

function walk(dir, out, depth) {
  if (depth > 8) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) walk(p, out, depth + 1);
      else if (e.isFile() && /\.jsonl$/.test(e.name)) out.push(p);
    } catch (err) { /* unreadable entry: skip */ }
  }
  return out;
}

/** All transcript files, plus which tools were missing entirely. */
function discover() {
  const files = [];
  const missing = [];
  for (const src of sources()) {
    if (!fs.existsSync(src.root)) { missing.push(src); continue; }
    for (const f of walk(src.root, [], 0)) {
      let st;
      try { st = fs.statSync(f); } catch (e) { continue; }
      files.push({ tool: src.tool, file: f, size: st.size, mtime: st.mtime });
    }
  }
  return { files, missing };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

// Cursor wraps the human's words in <user_query> and prepends a <timestamp> block.
function cleanCursor(text) {
  const q = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
  let out = q ? q[1] : text.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '');
  return out.trim();
}

/** Normalize one JSONL event into {role, text} or null. */
function toTurn(tool, obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (tool === 'cursor') {
    if (obj.role !== 'user' && obj.role !== 'assistant') return null;
    const text = textOf(obj.message && obj.message.content);
    if (!text.trim()) return null;
    return { role: obj.role, text: obj.role === 'user' ? cleanCursor(text) : text.trim() };
  }
  if (tool === 'claude-code') {
    if (obj.type !== 'user' && obj.type !== 'assistant') return null;
    const text = textOf(obj.message && obj.message.content);
    if (!text.trim()) return null;
    return { role: obj.type, text: text.trim() };
  }
  if (tool === 'codex') {
    if (obj.type !== 'response_item') return null;
    const p = obj.payload;
    if (!p || p.type !== 'message') return null;
    if (p.role !== 'user' && p.role !== 'assistant') return null;   // skip developer/system
    const text = textOf(p.content);
    if (!text.trim()) return null;
    return { role: p.role, text: text.trim() };
  }
  return null;
}

/**
 * Read a transcript from `offset` to EOF. Returns { turns, offset, bytes }.
 * Only whole lines are consumed; `offset` advances to the last newline seen, so a
 * partially-flushed final line is re-read (not skipped) next time.
 */
function readNew(entry, offset) {
  let st;
  try { st = fs.statSync(entry.file); } catch (e) { return null; }
  // A file that shrank was rotated or replaced: start over rather than seek past EOF.
  let from = (typeof offset === 'number' && offset <= st.size) ? offset : 0;
  if (from === st.size) return { turns: [], offset: from, bytes: 0 };

  let buf;
  try {
    const fd = fs.openSync(entry.file, 'r');
    try {
      const len = st.size - from;
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, from);
    } finally { fs.closeSync(fd); }
  } catch (e) { return null; }

  const raw = buf.toString('utf8');
  const lastNl = raw.lastIndexOf('\n');
  const usable = lastNl === -1 ? '' : raw.slice(0, lastNl + 1);
  const consumed = Buffer.byteLength(usable, 'utf8');

  const turns = [];
  for (const line of usable.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (e) { continue; }   // skip unparseable lines
    const t = toTurn(entry.tool, obj);
    if (t) turns.push(t);
  }
  return { turns, offset: from + consumed, bytes: consumed };
}

module.exports = { discover, readNew, toTurn, sources, SOURCES: DEFAULT_SOURCES };
