'use strict';
// `gotcha audit` -- onboarding for an ecosystem that has no fact table yet.
// Reads git metadata, manifests, CI workflows and deploy configs, probes any URL it
// finds, and drafts facts.yaml. Every drafted fact carries evidence; structural
// facts carry a runnable check so the verifier can re-prove them later. Anything
// that depends on the outside world (is this host still serving?) is drafted as a
// runtime observation with a documented recheck, never as an offline "verified".

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const repos = require('../repos');
const facts = require('../facts');
const { writeFileAtomic, today } = require('../util');

const STALE_DAYS = 90;

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
function readIf(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function listIf(p) { try { return fs.readdirSync(p); } catch (e) { return []; } }

/** A single-quoted bash literal for use inside a generated check. */
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

/** Registrable-ish domain: last two labels (good enough for classification). */
function registrable(host) {
  const parts = String(host).split('.');
  return parts.length <= 2 ? String(host) : parts.slice(-2).join('.');
}

function gh(args) {
  if (args.some((a) => typeof a !== 'string')) return null;
  try {
    return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', timeout: 25000, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (e) { return null; }
}

/** HTTP status for a URL, or null when unreachable. Network, by design. */
function probe(url) {
  try {
    const code = execFileSync('curl', ['--silent', '--show-error', '--location', '--output', '/dev/null',
      '--write-out', '%{http_code}', '--max-time', '10', url],
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^\d{3}$/.test(code) && code !== '000' ? code : null;
  } catch (e) { return null; }
}

const URL_RE = /https?:\/\/[A-Za-z0-9._~:\/?#@!$&'()*+,;=%-]+/g;
// Hosts that say nothing about this ecosystem's own deployments.
const BORING_HOST = /(^|\.)(github\.com|githubusercontent\.com|npmjs\.com|nodejs\.org|json-schema\.org|schemas?\.|w3\.org|apache\.org|opensource\.org|mit-license\.org|example\.com|localhost|127\.0\.0\.1|vercel\.com|docs\.|developer\.apple\.com|registry\.npmjs\.org|fonts\.g)/i;

function harvestUrls(repoPath, repoName, out) {
  const candidates = ['vercel.json', 'package.json', 'README.md', 'MIGRATION_HANDOFF.md',
    'docker-compose.yml', 'docker-compose.yaml', 'next.config.js', 'next.config.mjs', 'app.json'];
  for (const wf of listIf(path.join(repoPath, '.github', 'workflows'))) candidates.push(path.join('.github', 'workflows', wf));
  for (const rel of candidates) {
    const text = readIf(path.join(repoPath, rel));
    if (!text) continue;
    const found = text.match(URL_RE) || [];
    for (const raw of found) {
      const url = raw.replace(/[).,'"`\]]+$/, '');
      let host;
      try { host = new URL(url).host; } catch (e) { continue; }
      if (BORING_HOST.test(host)) continue;
      const origin = 'https://' + host;
      if (!out[origin]) out[origin] = { origin, host, sources: [] };
      const where = repoName + '/' + rel;
      if (out[origin].sources.indexOf(where) === -1) out[origin].sources.push(where);
    }
  }
}

function auditRepo(repoPath, drafted, urls) {
  const r = repos.resolve(repoPath);
  const name = r.name;
  const rel = (p) => name + '/' + p;
  const push = (f) => drafted.push(f);

  // --- default branch ------------------------------------------------------
  const b = repos.branchInfo(repoPath);
  if (b.base) {
    const branch = b.base.replace(/^origin\//, '');
    push({
      id: slug(name + '-default-branch-' + branch),
      claim: name + ' tracks ' + branch + ' as its remote default branch; work merged elsewhere does not ship.',
      scope: [name],
      evidence: [rel('.git/refs/remotes/origin/HEAD')],
      check: 'default_branch ' + shq(name) + ' ' + shq(branch) + '\n',
      status: 'verified',
      verified_at: today(),
    });
  }

  // --- package manifest ----------------------------------------------------
  const pkgRaw = readIf(path.join(repoPath, 'package.json'));
  if (pkgRaw) {
    let pkg = null;
    try { pkg = JSON.parse(pkgRaw); } catch (e) { pkg = null; }
    const deps = pkg ? Object.assign({}, pkg.dependencies, pkg.devDependencies) : {};
    for (const framework of ['next', 'express', 'fastify', 'react-native']) {
      if (!deps[framework]) continue;
      push({
        id: slug(name + '-uses-' + framework),
        claim: name + ' declares ' + framework + ' ' + deps[framework] + ' in package.json; it is a ' + framework + ' codebase.',
        scope: [name],
        evidence: [rel('package.json')],
        check: 'has ' + shq(rel('package.json')) + ' ' + shq('"' + framework + '"') + '\n',
        status: 'verified',
        verified_at: today(),
      });
    }
    if (pkg && pkg.scripts && pkg.scripts.build) {
      push({
        id: slug(name + '-build-script'),
        claim: name + ' builds with `' + String(pkg.scripts.build).slice(0, 80) + '`.',
        scope: [name],
        evidence: [rel('package.json')],
        check: 'has ' + shq(rel('package.json')) + ' ' + shq(String(pkg.scripts.build).slice(0, 80)) + '\n',
        status: 'verified',
        verified_at: today(),
      });
    }
  }

  // --- CI workflows --------------------------------------------------------
  for (const wf of listIf(path.join(repoPath, '.github', 'workflows'))) {
    if (!/\.ya?ml$/.test(wf)) continue;
    const wfRel = path.join('.github', 'workflows', wf);
    const text = readIf(path.join(repoPath, wfRel));
    if (!text) continue;
    const nameLine = /^name:\s*(.+)$/m.exec(text);
    const wfName = nameLine ? nameLine[1].trim() : wf;
    const deploys = /deploy|ssh|ec2|rsync|vercel|fly |docker push/i.test(text);
    push({
      id: slug(name + '-workflow-' + (nameLine ? wfName : wf.replace(/\.ya?ml$/, ''))),
      claim: name + ' defines the "' + wfName + '" GitHub Actions workflow' +
        (deploys ? ', which performs deployment steps; merging can ship code.' : '.'),
      scope: [name],
      evidence: [rel(wfRel)],
      check: 'has ' + shq(rel(wfRel)) + ' ' + shq(nameLine ? 'name: ' + wfName : 'on:') + '\n',
      status: 'verified',
      verified_at: today(),
      note: deploys ? 'Deployment-capable workflow: review triggers before merging.' : undefined,
    });
  }

  // --- vercel cron ---------------------------------------------------------
  const vercelRaw = readIf(path.join(repoPath, 'vercel.json'));
  if (vercelRaw) {
    let v = null;
    try { v = JSON.parse(vercelRaw); } catch (e) { v = null; }
    const crons = (v && Array.isArray(v.crons)) ? v.crons : [];
    if (crons.length) {
      push({
        id: slug(name + '-vercel-crons'),
        claim: name + ' schedules ' + crons.length + ' Vercel cron job(s); these run in production on a timer.',
        scope: [name],
        evidence: [rel('vercel.json')],
        check: 'has ' + shq(rel('vercel.json')) + ' ' + shq('"crons"') + '\n',
        status: 'verified',
        verified_at: today(),
      });
    }
  }

  // --- docker compose ------------------------------------------------------
  for (const cf of ['docker-compose.yml', 'docker-compose.yaml']) {
    const text = readIf(path.join(repoPath, cf));
    if (!text) continue;
    const services = [];
    const svcBlock = /^services:\s*$/m.exec(text);
    if (svcBlock) {
      const after = text.slice(svcBlock.index);
      const re = /^ {2}([A-Za-z0-9_-]+):\s*$/gm;
      let m;
      while ((m = re.exec(after))) services.push(m[1]);
    }
    if (services.length) {
      push({
        id: slug(name + '-compose-services'),
        claim: name + ' Compose declares ' + services.length + ' service(s): ' + services.slice(0, 8).join(', ') + '.',
        scope: [name],
        evidence: [rel(cf)],
        check: services.slice(0, 4).map((s) => 'has ' + shq(rel(cf)) + ' ' + shq('  ' + s + ':')).join(' && ') + '\n',
        status: 'verified',
        verified_at: today(),
      });
    }
  }

  harvestUrls(repoPath, name, urls);
  return name;
}

function run(argv, flags) {
  const drafted = [];
  const urls = {};
  const scanned = [];

  let targets = argv.map(repos.expand).filter(repos.isRepo);
  let orgRepos = null;
  const org = flags.org || (argv.length === 1 && !repos.isRepo(repos.expand(argv[0])) ? argv[0] : null);

  if (org && typeof org !== 'string') {
    console.error('gotcha audit: --org needs a value, e.g. --org your-github-org');
    return 2;
  }
  if (org) {
    orgRepos = gh(['repo', 'list', org, '--limit', '100', '--json', 'name,isArchived,pushedAt,defaultBranchRef,homepageUrl,description']);
    if (!orgRepos) console.error('  (gh repo list failed for ' + org + '; continuing with local paths only)');
    if (!targets.length) {
      targets = (orgRepos || []).map((r) => path.join(repos.HOME, r.name)).filter(repos.isRepo);
    }
  }
  if (!targets.length) targets = repos.tracked();

  console.log('gotcha audit');
  for (const t of targets) {
    scanned.push(auditRepo(t, drafted, urls));
    console.log('  scanned ' + path.basename(t));
  }

  // --- org-level: repos nobody has cloned, and their deploy URLs -----------
  if (orgRepos) {
    for (const r of orgRepos) {
      if (r.homepageUrl) {
        const origin = r.homepageUrl.replace(/\/+$/, '');
        if (!urls[origin]) urls[origin] = { origin, host: (() => { try { return new URL(origin).host; } catch (e) { return origin; } })(), sources: [] };
        urls[origin].sources.push('org:' + r.name + ' homepage');
        urls[origin].repo = r;
      }
      const days = Math.round((Date.now() - new Date(r.pushedAt).getTime()) / 86400000);
      const localClone = repos.isRepo(path.join(repos.HOME, r.name));
      if (days > STALE_DAYS || r.isArchived) {
        drafted.push({
          id: slug('repo-dormant-' + r.name),
          claim: r.name + ' has had no push for ' + days + ' days' + (r.isArchived ? ' and is archived' : '') +
            '; treat it as dormant unless a live deployment says otherwise.',
          scope: [r.name],
          evidence: ['GitHub API: ' + r.name + ' pushedAt=' + String(r.pushedAt).slice(0, 10) + (localClone ? '' : '; no local clone')],
          check: 'unresolved ' + shq('Dormancy is a GitHub/owner judgement, not an offline property. Confirm with the owner and re-check pushedAt before relying on it.') + '\n',
          status: 'human-asserted',
          verified_at: today(),
          note: 'Drafted by gotcha audit from GitHub metadata on ' + today() + '. Confirm with the owner.',
        });
      }
    }
  }

  // --- which hosts are OURS? ----------------------------------------------
  // A URL in a config can be our deployment or a link to someone's docs. Drafting
  // "nextjs.org is live" as an ecosystem fact is noise, and worse, calling it
  // "live but forgotten" is wrong. Treat a domain as ours when the org publishes it
  // as a repo homepage, when the owner names it with --domain, or when it shows up
  // across several of our own files (one passing mention is a citation; five
  // subdomains across repos is infrastructure).
  const OWN_SOURCE_THRESHOLD = 3;   // cited in several of our files
  const OWN_SUBDOMAIN_THRESHOLD = 2; // we run more than one host under it
  const byDomain = Object.create(null);
  for (const origin of Object.keys(urls)) {
    const d = registrable(urls[origin].host);
    if (!byDomain[d]) byDomain[d] = { sources: new Set(), hosts: new Set() };
    byDomain[d].hosts.add(urls[origin].host);
    for (const src of urls[origin].sources) byDomain[d].sources.add(src);
  }
  const ownDomains = new Set();
  for (const hint of [].concat(flags.domain || [])) if (typeof hint === 'string') ownDomains.add(registrable(hint));
  for (const r of (orgRepos || [])) {
    if (!r.homepageUrl) continue;
    try { ownDomains.add(registrable(new URL(r.homepageUrl).host)); } catch (e) { /* ignore */ }
  }
  // An org called "The-Betting-Insider" owning "thebettinginsider.com" is not a
  // coincidence; compare the org name with the domain label, ignoring separators.
  const orgKey = org ? String(org).toLowerCase().replace(/[^a-z0-9]/g, '') : null;
  for (const d of Object.keys(byDomain)) {
    const info = byDomain[d];
    const label = d.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (orgKey && label && (label === orgKey || label.indexOf(orgKey) !== -1 || orgKey.indexOf(label) !== -1)) ownDomains.add(d);
    // Several distinct subdomains under one domain means we run it, not cite it.
    else if (info.hosts.size >= OWN_SUBDOMAIN_THRESHOLD) ownDomains.add(d);
    else if (info.sources.size >= OWN_SOURCE_THRESHOLD) ownDomains.add(d);
  }

  const origins = Object.keys(urls).sort();
  const ours = origins.filter((o) => ownDomains.has(registrable(urls[o].host)));
  const external = origins.filter((o) => !ownDomains.has(registrable(urls[o].host)));

  // --- liveness ------------------------------------------------------------
  if (ours.length) console.log('  probing ' + ours.length + ' own host(s); ignoring ' + external.length + ' external reference(s)...');
  const live = [];
  for (const origin of ours) {
    const entry = urls[origin];
    const code = probe(origin);
    entry.code = code;
    if (!code) continue;
    live.push(entry);
    const r = entry.repo;
    const days = r ? Math.round((Date.now() - new Date(r.pushedAt).getTime()) / 86400000) : null;
    const forgotten = days !== null && days > STALE_DAYS;
    drafted.push({
      id: slug('live-host-' + entry.host),
      claim: entry.host + ' is serving (HTTP ' + code + ' observed ' + today() + ')' +
        (forgotten ? ', although ' + r.name + ' has not been pushed to for ' + days + ' days — live infrastructure that looks abandoned in git.' : '.'),
      scope: r ? [r.name] : scanned.slice(),
      evidence: entry.sources.length ? entry.sources.slice(0, 4) : ['HTTP probe ' + origin],
      check: 'unresolved ' + shq('Hosting availability is a runtime observation; the offline verifier cannot repeat it. Run the documented recheck.') + '\n',
      status: 'verified-runtime',
      verified_at: today(),
      recheck: "curl --silent --show-error --output /dev/null --write-out '%{http_code}\\n' --max-time 25 " + origin,
      note: forgotten
        ? 'LIVE BUT FORGOTTEN: reachable today, but the repo looks dormant in git. Do not delete or decommission without checking dependents.'
        : 'HTTP reachability only; not proof of API parity, traffic, or consumer usage.',
    });
  }

  // --- emit ----------------------------------------------------------------
  const outPath = path.resolve(repos.expand(flags.out ||
    path.join(repos.GOTCHA_HOME, 'drafts', today() + '-' + (org ? slug(org) : slug(scanned.join('-'))) + '.facts.yaml')));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const seen = Object.create(null);
  const unique = drafted.filter((f) => (seen[f.id] ? false : (seen[f.id] = true)));

  const header = [
    'schema_version: 1',
    '# Drafted by `gotcha audit` on ' + today() + '. NOT verified truth yet: review every',
    '# claim, then move the ones you trust into the repo\'s repo-truth/facts.yaml.',
    '# Scanned: ' + scanned.join(', ') + (org ? ' (org ' + org + ')' : ''),
    'facts:',
  ].join('\n');
  const body = unique.map((f) => facts.render(f).join('\n')).join('\n');
  writeFileAtomic(outPath, header + '\n' + body + '\n');

  const runnable = unique.filter((f) => !/^unresolved /.test(f.check)).length;
  console.log('');
  console.log('  drafted ' + unique.length + ' facts -> ' + outPath);
  console.log('  ' + runnable + '/' + unique.length + ' have runnable checks (' +
    Math.round((runnable / Math.max(1, unique.length)) * 100) + '%)');
  if (live.length) {
    console.log('');
    console.log('  LIVE HOSTS FOUND:');
    for (const e of live) {
      const r = e.repo;
      const days = r ? Math.round((Date.now() - new Date(r.pushedAt).getTime()) / 86400000) : null;
      console.log('    ' + e.host + '  HTTP ' + e.code +
        (days !== null && days > STALE_DAYS ? '   <- LIVE BUT FORGOTTEN (' + r.name + ' idle ' + days + 'd)' : ''));
    }
  }
  if (external.length) {
    console.log('');
    console.log('  Ignored as external references (not drafted as facts):');
    console.log('    ' + external.map((o) => urls[o].host).join(', '));
    console.log('    Add one with --domain <host> if it is actually yours.');
  }
  console.log('');
  console.log('  Review, then copy approved facts into repo-truth/facts.yaml. Nothing was committed.');
  return 0;
}

module.exports = { run };
