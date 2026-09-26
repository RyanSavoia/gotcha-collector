#!/usr/bin/env node
'use strict';
// Pre-action hook: surface a relevant fact at the MOMENT an action is about to
// happen, not at session start.
//
// Reading the fact table at startup does not mean the agent still honours it forty
// minutes later. This runs immediately before a tool call, matches the imminent
// action against fact anchors, and injects the fact into context.
//
// Budget: under 100ms. No model call, no YAML parse -- a prebuilt index only.
// Warn-only by default: it returns `allow` and adds context. It denies ONLY for a
// fact the owner has explicitly marked `enforce: "true"` by hand, and only for shell
// commands. Nothing ships with enforce set.
//
// TWO PROTOCOLS, one script. The payload tells us which:
//   Claude Code PreToolUse -> { tool_name, tool_input }        -> hookSpecificOutput
//   Cursor beforeShellExecution -> { command }                 -> { permission, agent_message }
//   Cursor preToolUse -> { tool_name/tool_input } is Claude-shaped; Cursor sends its
//     own shape, so we key off `command` first and fall back to tool_input.
// Exit codes differ too: Claude Code blocks on exit 2; Cursor treats exit 2 as block
// and any other non-zero as fail-open (unless failClosed). We always exit 0 and say
// what we mean in the JSON, so a crash can never wedge either editor.

const fs = require('fs');
const path = require('path');
const os = require('os');

// The index is DATA, so it follows the data dir (or GOTCHA_HOME when overridden).
const INDEX = process.env.GOTCHA_HOOK_INDEX || (function () {
  if (process.env.GOTCHA_HOME) return path.join(process.env.GOTCHA_HOME, 'hook-index.json');
  const xdg = process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME)
    ? process.env.XDG_DATA_HOME : path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'gotcha', 'hook-index.json');
}());
const MAX_FACTS = 3;

function read(stream, cb) {
  let data = '';
  stream.setEncoding('utf8');
  stream.on('data', (c) => { data += c; });
  stream.on('end', () => cb(data));
  stream.on('error', () => cb(''));
}

function allow() { process.stdout.write('{}\n'); process.exit(0); }

read(process.stdin, (raw) => {
  let payload;
  try { payload = JSON.parse(raw); } catch (e) { return allow(); }

  // Cursor's shell hook puts the command at the top level; Claude Code nests it.
  const cursorShell = typeof payload.command === 'string' && !payload.tool_name;
  const tool = payload.tool_name || (cursorShell ? 'Shell' : '');
  const input = payload.tool_input || {};
  const isShell = cursorShell || tool === 'Bash' || tool === 'Shell';

  let subject = '';
  if (cursorShell) subject = String(payload.command || '');
  else if (tool === 'Bash') subject = String(input.command || '');
  else subject = String(input.file_path || input.path || input.notebook_path || payload.file_path || '');
  if (!subject.trim()) return allow();

  let idx;
  try { idx = JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch (e) { return allow(); }
  if (!idx || !Array.isArray(idx.facts)) return allow();

  const hay = subject.toLowerCase();
  const hits = [];
  for (const f of idx.facts) {
    let why = null;
    for (const a of f.anchors) {
      if (hay.indexOf(a.toLowerCase()) !== -1) { why = a; break; }
    }
    if (!why) {
      for (const b of f.bases) {
        // Basenames are short; require a distinctive one to avoid matching "index.ts".
        if (b.length >= 8 && hay.indexOf(b.toLowerCase()) !== -1) { why = b; break; }
      }
    }
    if (why) hits.push({ f, why });
    if (hits.length >= 12) break;
  }
  if (!hits.length) return allow();

  // A disproven claim is the most valuable thing to surface, then enforced ones.
  const rank = (h) => (h.f.status === 'failed' ? 0 : h.f.enforce ? 1 : 2);
  hits.sort((a, b) => rank(a) - rank(b));
  const shown = hits.slice(0, MAX_FACTS);

  const lines = shown.map((h) => {
    const tag = h.f.status === 'failed' ? 'DISPROVEN fact' : 'Relevant verified fact';
    return tag + ': ' + h.f.claim +
      ' (status ' + h.f.status + ', verified ' + h.f.verified_at + '). Evidence: ' + h.why + '.';
  });

  // Enforcement is opt-in per fact, shell commands only, and never for a fact that
  // is merely disproven -- blocking on "we know this is false" would stop the very
  // work that fixes it.
  const blocking = isShell && shown.find((h) => h.f.enforce && h.f.status !== 'failed');
  const body = lines.join('\n');
  const summary = 'gotcha: ' + shown.length + ' relevant fact(s) — ' + shown.map((h) => h.f.id).join(', ');

  if (cursorShell) {
    // Cursor: permission + agent_message. Warn-only is allow + the fact text.
    const out = blocking
      ? { permission: 'deny',
          agent_message: 'Blocked by an enforced fact: ' + blocking.f.claim + ' (fact ' + blocking.f.id + ')',
          user_message: 'gotcha blocked this command (fact ' + blocking.f.id + ')' }
      : { permission: 'allow', agent_message: body, user_message: summary };
    process.stdout.write(JSON.stringify(out) + '\n');
    return process.exit(0);
  }

  const out = {
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: body },
  };
  if (blocking) {
    out.hookSpecificOutput.permissionDecision = 'deny';
    out.hookSpecificOutput.permissionDecisionReason =
      'Blocked by an enforced fact: ' + blocking.f.claim + ' (fact ' + blocking.f.id + ')';
  } else {
    out.hookSpecificOutput.permissionDecision = 'allow';
    out.hookSpecificOutput.permissionDecisionReason = 'gotcha: surfacing ' + shown.length + ' relevant fact(s)';
    out.systemMessage = summary;
  }
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
});
