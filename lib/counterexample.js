'use strict';
// Level 4: test the test.
//
// A check that passes proves nothing unless it would FAIL when the claim is false.
// `has 'file' 'x'` where x appears in six other places, or a check anchored to a
// line no edit would touch, passes forever and discriminates nothing -- it is a
// green light wired to no sensor.
//
// So we mutate: build an isolated scratch mirror, break the anchored evidence so the
// claim becomes false, and require the check to fail there. This is done
// MECHANICALLY rather than by asking the examiner to do it -- a deterministic
// mutation is cheaper, repeatable, and cannot be talked into a wrong answer. The
// real checkouts are never touched; the mutant is symlinks plus one real copy.

const fs = require('fs');
const path = require('path');
const os = require('os');
const anchors = require('./anchors');
const checks = require('./checks');

/** Strings the check looks for, so we know what to break. */
function needles(check) {
  const out = [];
  const re = /'((?:[^'\\]|\\.){3,})'|"((?:[^"\\]|\\.){3,})"/g;
  let m;
  while ((m = re.exec(String(check)))) {
    const v = (m[1] || m[2] || '');
    if (!v) continue;
    if (/^(?:user-dashboard|client-platform|ios-app)\//.test(v)) continue;   // that's a path
    out.push(v.replace(/\\'/g, "'"));
  }
  return out;
}

/**
 * Build a mirror of `root` where one file is replaced by a mutated copy.
 * Everything else is symlinked, so this costs a few inodes rather than a repo copy.
 */
function buildMutant(root, relPath, mutate, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const parts = relPath.split('/');
  for (const entry of fs.readdirSync(root)) {
    const src = path.join(root, entry);
    const dst = path.join(dir, entry);
    if (entry === parts[0]) continue;              // rebuilt below
    try { fs.symlinkSync(src, dst); } catch (e) { /* already there */ }
  }
  // Rebuild the chain down to the file, symlinking every sibling on the way.
  let curSrc = root;
  let curDst = dir;
  for (let i = 0; i < parts.length - 1; i++) {
    curSrc = path.join(curSrc, parts[i]);
    curDst = path.join(curDst, parts[i]);
    fs.mkdirSync(curDst, { recursive: true });
    for (const entry of fs.readdirSync(curSrc)) {
      if (entry === parts[i + 1]) continue;
      const s = path.join(curSrc, entry);
      const d = path.join(curDst, entry);
      if (fs.existsSync(d)) continue;
      try { fs.symlinkSync(s, d); } catch (e) { /* ignore */ }
    }
  }
  const realFile = path.join(root, relPath);
  const mutantFile = path.join(dir, relPath);
  const original = fs.readFileSync(realFile, 'utf8');
  const mutated = mutate(original);
  if (mutated === original) return null;           // nothing to break
  fs.writeFileSync(mutantFile, mutated, 'utf8');
  return mutantFile;
}

/**
 * Try to demonstrate that this fact's check discriminates.
 * Returns { outcome: 'demonstrated'|'not-constructible', detail }.
 */
function demonstrate(fact, ctx) {
  const check = String(fact.check || '');
  if (/^\s*unresolved /.test(check)) {
    return { outcome: 'not-constructible', detail: 'no runnable check to falsify' };
  }
  const paths = anchors.anchorsOf(fact).filter((p) => fs.existsSync(path.join(ctx.root, p)));
  if (!paths.length) return { outcome: 'not-constructible', detail: 'check names no file that exists under the root' };
  const ns = needles(check);

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'gotcha-mutant-'));
  try {
    for (const rel of paths) {
      const full = path.join(ctx.root, rel);
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }   // binary or unreadable

      // Prefer breaking the exact string the check looks for; otherwise blank the file.
      const hit = ns.find((n) => text.indexOf(n) !== -1);
      const mutate = hit
        ? (s) => s.split(hit).join('GOTCHA_MUTANT_REMOVED')
        : () => '// GOTCHA_MUTANT: file emptied to falsify the claim\n';

      const dir = path.join(tmpBase, 'root-' + paths.indexOf(rel));
      let mutantFile;
      try { mutantFile = buildMutant(ctx.root, rel, mutate, dir); }
      catch (e) { continue; }
      if (!mutantFile) continue;

      const r = checks.runCheck(check, { root: dir, here: ctx.here, timeout: 60000 });
      if (r.rc !== 0) {
        return {
          outcome: 'demonstrated',
          detail: 'mutating ' + rel + (hit ? ' (removed ' + JSON.stringify(hit.slice(0, 60)) + ')' : ' (emptied)') +
            ' makes the check fail, so it discriminates',
        };
      }
    }
    return {
      outcome: 'not-constructible',
      detail: 'the check still passed with every anchored file broken — it does not discriminate this claim',
    };
  } finally {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
}

module.exports = { demonstrate, needles, buildMutant };
