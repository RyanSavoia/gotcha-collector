'use strict';
// Secret scrubbing for transcript text.
//
// SECRET_PATTERNS and the line-dropping strategy (including stateful PEM-block
// handling) are adapted from code-recall (MIT) -- see ATTRIBUTION.md. Dropping the
// whole line rather than masking the match is deliberate: a token's surroundings
// ("export GITHUB_TOKEN=..." , "psql postgres://user:pw@host/db") leak nearly as
// much as the token, and a partially-masked line invites someone to reconstruct it.
//
// This runs before ANY egress: before a chunk reaches the LLM, before a candidate
// is written, and before anything is logged.

const SECRET_PATTERNS = [
  /\bbearer\s+[A-Za-z0-9._\-\/+=]{12,}/i,
  /\bauthorization\s*[:=]/i,
  /passw(?:or)?d\s*[:=]\s*\S+/i,
  /\bsk-[A-Za-z0-9_\-]{16,}/,                        // OpenAI-style keys
  /\bsk-ant-[A-Za-z0-9_\-]{16,}/,                    // Anthropic keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,                    // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,                  // GitHub fine-grained PAT
  /\bglpat-[A-Za-z0-9_\-]{16,}/,                     // GitLab PAT
  /\bAIza[0-9A-Za-z_\-]{30,}/,                       // Google API key
  /\bxox[baprs]-[A-Za-z0-9\-]{10,}/,                 // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/,                            // AWS access key id
  /aws_secret_access_key/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:access|refresh|session|api)[_-]?(?:token|key|secret)\s*[:=]\s*\S{8,}/i,
  /\beyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\./, // JWT
  // Connection strings carrying inline credentials.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:[^\s@\/]+@/i,
  /\bSUPABASE_[A-Z_]*KEY\s*[:=]/i,
  /\bSTRIPE_(?:SECRET|RESTRICTED)_KEY\s*[:=]/i,
  /\b(?:secret|token|apikey|api_key|client_secret)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i,
];

const PEM_BEGIN_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END_RE = /-----END [A-Z ]*PRIVATE KEY-----/;
const DROPPED = '[gotcha: line removed -- matched secret pattern]';
const DROPPED_PEM = '[gotcha: line removed -- private key block]';
const MAX_LINE = 400;

/** Scrub text. Returns { text, removed } where `removed` counts dropped lines. */
function scrub(text) {
  let inPem = false;
  let removed = 0;
  const out = String(text).split('\n').map((line) => {
    if (inPem) {
      if (PEM_END_RE.test(line)) inPem = false;
      removed++;
      return DROPPED_PEM;
    }
    if (PEM_BEGIN_RE.test(line)) {
      if (!PEM_END_RE.test(line)) inPem = true;
      removed++;
      return DROPPED_PEM;
    }
    for (const re of SECRET_PATTERNS) {
      if (re.test(line)) { removed++; return DROPPED; }
    }
    return line.length > MAX_LINE ? line.slice(0, MAX_LINE) + ' [...]' : line;
  }).join('\n');
  return { text: out, removed };
}

// Patterns that match actual credential MATERIAL -- high-entropy shapes that cannot
// plausibly be a template or a variable name. The broad list above is right for
// scrubbing (dropping a line costs nothing); this narrower one is for decisions
// where a false positive is expensive, like refusing a release. A gate that cries
// wolf on the word "authorization" is a gate people learn to bypass.
const SECRET_MATERIAL = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bsk-ant-[A-Za-z0-9_\-]{16,}/,
  /\bsk-[A-Za-z0-9_\-]{20,}/,
  /\bglpat-[A-Za-z0-9_\-]{16,}/,
  /\bAIza[0-9A-Za-z_\-]{30,}/,
  /\bxox[baprs]-[A-Za-z0-9\-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:[^\s@\/]{6,}@/i,
];

/** Does this contain something that is unmistakably a credential? */
function looksSecretStrict(text) {
  const s = String(text);
  for (const re of SECRET_MATERIAL) if (re.test(s)) return true;
  return false;
}

/**
 * Last line of defence: does this string still contain anything secret-shaped?
 * Used to assert on everything we are about to write or send, so a pattern that
 * only matches mid-line (rather than at line granularity) still cannot escape.
 */
function looksSecret(text) {
  const s = String(text);
  for (const re of SECRET_PATTERNS) if (re.test(s)) return true;
  return false;
}

module.exports = { scrub, looksSecret, looksSecretStrict, SECRET_PATTERNS, SECRET_MATERIAL, DROPPED, DROPPED_PEM };
