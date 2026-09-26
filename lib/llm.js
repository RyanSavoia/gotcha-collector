'use strict';
// Every model call goes through here so its real cost is known and charged to the
// shared daily budget. Estimating spend from token guesses was the alternative; the
// CLI reports total_cost_usd, so there is no reason to guess.

const { execFileSync } = require('child_process');
const budget = require('./budget');

/**
 * Run `claude -p` and return { text, costUsd, error }.
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

  let raw = '';
  try {
    raw = execFileSync('claude', args, {
      encoding: 'utf8',
      timeout: options.timeout || 180000,
      maxBuffer: 16 * 1024 * 1024,
      input: options.input,
      cwd: options.cwd,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    });
  } catch (e) {
    raw = (e && e.stdout) || '';
    if (!raw) return { text: '', costUsd: 0, error: (e && e.message) || 'claude failed' };
  }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
  if (!parsed) return { text: String(raw), costUsd: 0, error: null };

  const costUsd = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0;
  if (costUsd) budget.charge(costUsd, 1);
  return { text: String(parsed.result || ''), costUsd, error: parsed.is_error ? 'model reported an error' : null };
}

module.exports = { call };
