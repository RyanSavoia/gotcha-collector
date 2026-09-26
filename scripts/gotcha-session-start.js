#!/usr/bin/env node
'use strict';
// sessionStart hook: offer `gotcha preflight` at the top of a session.
//
// Cursor's documented stdout for sessionStart is { env, additional_context } --
// NOT agent_message, which belongs to the blocking events (beforeShellExecution,
// preToolUse).
//
// IMPORTANT, and the reason this is a complement rather than a replacement: as of
// 2026-09-26 Cursor drops sessionStart additional_context entirely (confirmed by
// Cursor staff; a timing bug). `env` from the same hook still works. So on Cursor
// today this injects NOTHING into the agent, and the CLAUDE.md / AGENTS.md /
// .cursor/rules pointer remains load-bearing. The field name is correct for when
// the fix ships; until then this fails open and costs a few hundred milliseconds.
//
// Fails open, always: a session that cannot start because a memory tool errored is
// a worse outcome than a session with no memory.

const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

const GOTCHA = path.join(__dirname, '..', 'bin', 'gotcha');
const BUDGET_MS = 3000;

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); process.exit(0); }

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('error', () => out({}));
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(raw) || {}; } catch (e) { payload = {}; }
  // Cursor gives the workspace root; Claude Code gives cwd. Either way, preflight
  // wants a repo path.
  const repo = payload.workspace_roots && payload.workspace_roots[0]
    ? payload.workspace_roots[0]
    : (payload.cwd || process.cwd());

  let text = '';
  try {
    text = execFileSync('node', [GOTCHA, 'preflight', repo], {
      encoding: 'utf8', timeout: BUDGET_MS, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    return out({});                       // no memory beats a broken session
  }
  if (!text.trim()) return out({});
  // additional_context is the documented field. env is set too: it is the half of
  // this hook that currently survives, so a shell or later hook can still see that
  // preflight ran and where to read it.
  out({
    additional_context: 'Verified facts for this repo (gotcha preflight):\n' + text.trim(),
    env: {
      GOTCHA_PREFLIGHT_REPO: repo,
      GOTCHA_PREFLIGHT_AT: new Date().toISOString(),
    },
  });
});
