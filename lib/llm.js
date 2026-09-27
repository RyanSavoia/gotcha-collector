'use strict';
// Every model call goes through here so its real cost is known and charged to the
// shared daily budget. Estimating spend from token guesses was the alternative; the
// CLI reports total_cost_usd, so there is no reason to guess.

const { execFileSync } = require('child_process');
const budget = require('./budget');
const extractor = require('./extractor');
const config = require('./config');

// Resolved once per process. Under launchd there is no inherited PATH worth
// trusting, so the bare name 'claude' is never used.
let BIN = null;
function bin() {
  if (BIN) return BIN;
  let cfg = null;
  try { cfg = config.load(); } catch (e) { cfg = null; }
  BIN = extractor.resolve(cfg);
  return BIN;
}

/**
 * Run `claude -p` and return { text, costUsd, error, infra }.
 *
 * `infra` marks a failure of the MACHINERY rather than of the model: the binary is
 * missing, the process died, or it produced something unparseable. Callers must
 * treat that differently from "the model ran and found nothing" -- the harvester
 * holds its watermarks on infra, because content that was never actually read
 * must not be marked as consumed.
 *
 * Always requests JSON so the cost comes back with the answer.
 */
function call(prompt, opts) {
  const options = opts || {};
  const args = ['-p', prompt, '--model', options.model || 'haiku',
    '--output-format', 'json', '--no-session-persistence'];
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
  if (options.allowedTools) args.push('--allowedTools', ...options.allowedTools);
  if (options.disallowedTools) args.push('--disallowedTools', ...options.disallowedTools);
  for (const d of options.addDirs || []) args.push('--add-dir', d);

  const exe = bin();
  if (!exe) {
    return { text: '', costUsd: 0, infra: true,
      error: 'the `claude` binary could not be found (run `gotcha init` to record its path)' };
  }

  let raw = '';
  try {
    raw = execFileSync(exe, args, {
      encoding: 'utf8',
      timeout: options.timeout || 180000,
      maxBuffer: 16 * 1024 * 1024,
      input: options.input,
      cwd: options.cwd,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    });
  } catch (e) {
    raw = (e && e.stdout) || '';
    if (!raw) {
      return { text: '', costUsd: 0, infra: true, error: (e && e.message) || 'claude failed' };
    }
  }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
  // We asked for --output-format json. Anything else means the call did not
  // complete the way we asked, so it is an infrastructure failure, not an answer.
  if (!parsed) {
    return { text: String(raw), costUsd: 0, infra: true, error: 'unparseable model output' };
  }

  const costUsd = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0;
  if (costUsd) budget.charge(costUsd, 1);
  // is_error covers the CLI refusing to work at all -- not logged in, rate limited,
  // no credits. That is the machinery failing, not the model declining to answer,
  // so callers must hold their watermarks on it exactly as they would on ENOENT.
  if (parsed.is_error) {
    const detail = String(parsed.result || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return {
      text: String(parsed.result || ''),
      costUsd,
      infra: true,
      error: 'the extractor refused the call' + (detail ? ': ' + detail : ''),
    };
  }
  return { text: String(parsed.result || ''), costUsd, infra: false, error: null };
}

module.exports = { call, bin };
