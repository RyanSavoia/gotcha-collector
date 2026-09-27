'use strict';
// Scoring a fact against an imminent action.
//
// The first matcher keyed on anchor FILENAMES. Three facts anchored to some
// `page.tsx` then fired on every command that mentioned any page.tsx -- ten-plus
// times in one session, burying the two facts that actually helped. The lesson is
// that a filename is not what a task is about: `page.tsx` says nothing, while
// `gradeSelection` or `team_game_stats` says everything.
//
// So: score distinctive tokens far above generic ones, let a stoplisted anchor
// never fire a fact on its own, and cap what surfaces.

const path = require('path');

// Anchors and tokens so common they carry no information about the task. A fact
// whose ONLY overlap with a command is one of these stays quiet.
const STOP_BASENAMES = new Set([
  'page.tsx', 'page.ts', 'page.jsx', 'page.js',
  'route.ts', 'route.js', 'layout.tsx', 'layout.ts',
  'index.ts', 'index.tsx', 'index.js', 'index.jsx',
  'package.json', 'tsconfig.json', 'readme.md', 'types.ts', 'utils.ts',
  'config.ts', 'config.js', 'constants.ts', 'schema.ts', 'client.ts', 'server.ts',
  'main.ts', 'app.ts', 'helpers.ts', 'index.sql', 'middleware.ts',
]);

const STOP_TOKENS = new Set([
  'page', 'route', 'index', 'layout', 'app', 'src', 'lib', 'api', 'apis',
  'components', 'component', 'utils', 'util', 'types', 'type', 'config', 'configs',
  'test', 'tests', 'spec', 'json', 'tsx', 'jsx', 'file', 'files', 'code',
  'data', 'value', 'values', 'name', 'names', 'main', 'node', 'npm', 'npx', 'git',
  'true', 'false', 'null', 'const', 'from', 'this', 'that', 'with', 'which',
  'dashboard', 'client', 'server', 'public', 'build', 'dist', 'scripts', 'script',
]);

function tokens(text) {
  return String(text).toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 4);
}

/** Tokens that identify THIS fact and few others. */
function distinctiveTokens(fact) {
  const out = new Set();
  for (const a of fact.anchors || []) {
    const base = path.basename(a);
    if (!STOP_BASENAMES.has(base.toLowerCase())) {
      for (const t of tokens(base.replace(/\.[a-z0-9]+$/i, ''))) if (!STOP_TOKENS.has(t)) out.add(t);
    }
    // Directory segments can be distinctive ("featured", "tailored") even when the
    // filename is not.
    for (const seg of a.split('/').slice(0, -1)) {
      for (const t of tokens(seg)) if (!STOP_TOKENS.has(t)) out.add(t);
    }
  }
  for (const t of tokens(fact.claim)) if (!STOP_TOKENS.has(t)) out.add(t);
  return out;
}

/**
 * The terms a glossary fact defines. A glossary fact is a definition, so it is
 * relevant exactly when the task SAYS the word -- never because it touches a file
 * the definition happens to cite.
 *
 * Two sources, because owners write claims both ways: an explicitly quoted phrase
 * ("Admin tailored" is ...), and the fact id itself, which is the phrase in
 * kebab-case. The id is the reliable one; quotes are a bonus.
 */
function glossaryTerms(fact) {
  const out = new Set();
  const re = /["\u201c]([^"\u201d]{3,40})["\u201d]/g;
  let m;
  while ((m = re.exec(String(fact.claim)))) out.add(m[1].toLowerCase().trim());
  const fromId = String(fact.id).replace(/^glossary-/, '').replace(/-[0-9a-f]{6}$/, '');
  if (fromId.length >= 3) {
    out.add(fromId.replace(/-/g, ' '));   // "admin tailored"
    out.add(fromId);                       // "admin-tailored"
    out.add(fromId.replace(/-/g, '_'));    // "admin_tailored"
  }
  // A one-word term like "admin" would fire on half the repo. Keep a term only if
  // it is multi-word, or long enough to be a real piece of vocabulary.
  return Array.from(out).filter((t) => /[\s\-_]/.test(t) || t.length >= 6);
}

/**
 * Distinctive consecutive path fragments, e.g. "picks/featured".
 *
 * People name routes, not files: "add a nav link to /picks/featured" never
 * mentions page.tsx. A pair of adjacent segments is specific enough to trust on
 * its own, as long as neither half is a generic directory.
 */
function pathPairs(fact) {
  const out = new Set();
  for (const a of fact.anchors || []) {
    const segs = a.split('/').filter(Boolean);
    for (let i = 0; i + 1 < segs.length; i++) {
      const x = segs[i].toLowerCase(), y = segs[i + 1].toLowerCase();
      if (STOP_BASENAMES.has(x) || STOP_BASENAMES.has(y)) continue;
      // Either half being generic is enough to sink the pair: "user-dashboard/app"
      // is shared by every file in the repo and identifies nothing.
      if (STOP_TOKENS.has(x) || STOP_TOKENS.has(y)) continue;
      if (i === 0) continue;   // the leading segment is the repo name
      if (x.length < 3 || y.length < 3) continue;
      out.add(x + '/' + y);
    }
  }
  return Array.from(out);
}

// Runners a claim might name when it describes HOW to invoke something.
const RUNNERS = ['npm', 'npx', 'yarn', 'pnpm', 'bun', 'make', 'cargo', 'go', 'python3',
  'python', 'docker', 'bash', 'sh'];
// Bare tool names that ARE the invocation.
const RUNNER_TOOLS = ['vitest', 'jest', 'mocha', 'pytest', 'tsc', 'eslint', 'prettier',
  'tsx', 'ts-node', 'nodemon'];
// Generic actions. Normally stoplisted -- "test" must not fire facts on its own --
// but a fact that explicitly documents how to RUN something earns the word back,
// because running it is exactly when the fact matters.
const ACTIONS = ['test', 'tests', 'build', 'lint', 'deploy', 'migrate', 'typecheck'];

/**
 * Literal invocation phrases a fact is about.
 *
 * "Tests are executed via npx tsx --test, not vitest" anchors only to package.json,
 * which is stoplisted, so it scored zero on every command -- including the two that
 * actually ran the tests. A fact that documents how to invoke something should fire
 * when you invoke it, so the invocation itself becomes the match key.
 */
function invocations(fact) {
  const claim = String(fact.claim).toLowerCase();
  const out = new Set();
  const runnerRe = new RegExp('\\b(' + RUNNERS.join('|') + ')\\s+([a-z0-9@._/-]+(?:\\s+--?[a-z0-9-]+)*)', 'g');
  let m;
  while ((m = runnerRe.exec(claim))) {
    out.add((m[1] + ' ' + m[2]).trim());   // "npx tsx --test"
    out.add(m[2].trim());                   // "tsx --test"
  }
  for (const t of RUNNER_TOOLS) {
    if (new RegExp('(^|[^a-z0-9])' + t + '($|[^a-z0-9])').test(claim)) out.add(t);
  }
  if (!out.size) return [];
  // The claim describes an invocation, so pair each runner with the action word it
  // talks about: "npm test", "yarn test", "npm run test".
  for (const a of ACTIONS) {
    if (!new RegExp('(^|[^a-z0-9])' + a + '($|[^a-z0-9])').test(claim)) continue;
    for (const r of ['npm', 'yarn', 'pnpm', 'bun']) {
      out.add(r + ' ' + a);
      out.add(r + ' run ' + a);
    }
  }
  return Array.from(out).filter((x) => x.length >= 4);
}

/** Glossary terms match as whole words: "signals" must not hit "signals_ledger_v2". */
function hasTerm(hay, term) {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s_-]+');
  return new RegExp('(^|[^a-z0-9])' + esc + '($|[^a-z0-9])', 'i').test(hay);
}

function isGlossary(fact) { return /^glossary-/.test(String(fact.id)); }

/**
 * Score one fact against a command string (and the paths it mentions).
 * Returns { score, why } -- why is the strongest reason, for the message.
 */
function score(fact, subject) {
  const hay = String(subject).toLowerCase();

  // A glossary fact defines a phrase. It fires when the command SAYS the phrase,
  // never because it happens to touch a file the glossary cites.
  if (isGlossary(fact)) {
    for (const term of fact.terms || []) {
      if (hasTerm(hay, term)) return { score: 12, why: 'the term "' + term + '"' };
    }
    // Opening the exact file a definition is about is unambiguous -- and, unlike a
    // bare basename, cannot fire on an unrelated page.tsx.
    for (const a of fact.anchors || []) {
      if (a.indexOf('/') !== -1 && hay.indexOf(a.toLowerCase()) !== -1) {
        return { score: 10, why: a };
      }
    }
    return { score: 0, why: null };
  }

  let s = 0;
  let why = null;

  // A full anchor path in the command is the strongest signal there is.
  for (const a of fact.anchors || []) {
    if (hay.indexOf(a.toLowerCase()) !== -1) { s += 10; why = why || a; }
  }
  // A non-generic basename is good evidence; a stoplisted one is worth nothing.
  for (const a of fact.anchors || []) {
    const base = path.basename(a).toLowerCase();
    if (STOP_BASENAMES.has(base)) continue;
    if (base.length >= 6 && hay.indexOf(base) !== -1) { s += 6; why = why || base; }
  }
  // Running the thing a fact documents is the moment that fact is worth seeing.
  for (const inv of fact.invocations || []) {
    if (hay.indexOf(inv) !== -1) { s += 8; why = why || '`' + inv + '`'; }
  }
  // A route fragment like "picks/featured" names the thing without naming a file.
  for (const pair of fact.pairs || []) {
    if (hay.indexOf(pair) !== -1) { s += 8; why = why || '/' + pair; }
  }
  // Distinctive vocabulary: gradeSelection, team_game_stats, SETTLE_CRON.
  let tokenHits = 0;
  for (const t of fact.tokens || []) {
    if (t.length >= 6 && hay.indexOf(t) !== -1) { tokenHits++; why = why || t; }
  }
  s += Math.min(tokenHits, 3) * 3;
  return { score: s, why };
}

const THRESHOLD = 6;   // one distinctive basename, a path hit, or two strong tokens
const MAX_SHOWN = 3;

/** Rank facts for a command; at most MAX_SHOWN, strongest first. */
function rank(facts, subject) {
  const scored = [];
  for (const f of facts) {
    const r = score(f, subject);
    if (r.score >= THRESHOLD) scored.push({ f, score: r.score, why: r.why });
  }
  scored.sort((a, b) => {
    // A disproven claim outranks a merely relevant one at equal evidence.
    const rankOf = (x) => (x.f.status === 'failed' ? 0 : x.f.enforce ? 1 : 2);
    return (b.score - a.score) || (rankOf(a) - rankOf(b));
  });
  return scored.slice(0, MAX_SHOWN);
}

module.exports = {
  rank, score, tokens, distinctiveTokens, glossaryTerms, isGlossary, hasTerm, pathPairs,
  invocations,
  STOP_BASENAMES, STOP_TOKENS, THRESHOLD, MAX_SHOWN,
};
