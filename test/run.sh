#!/usr/bin/env bash
# Offline self-tests. No LLM, no network. Usage: bash test/run.sh
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()   { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL %s\n' "$1"; fail=$((fail+1)); }
check() { if [[ $1 == 0 ]]; then ok "$2"; else bad "$2"; fi; }

echo "gotcha self-test"

# --- facts.yaml grammar round-trip ----------------------------------------
cat > "$TMP/facts.yaml" <<'YAML'
schema_version: 1
facts:
  - id: sample-fact
    claim: "A sample claim with an en–dash."
    scope: ["repo-a"]
    evidence: ["repo-a/file.ts:1"]
    check: |
      file 'repo-a/file.ts'
    status: verified
    verified_at: "2026-09-25"
    note: "A note."
YAML
node -e '
const f=require(process.argv[1]+"/lib/facts.js"), fs=require("fs");
const src=fs.readFileSync(process.argv[2],"utf8");
const doc=f.parse(src);
if(doc.facts.length!==1) process.exit(1);
const all={}; doc.facts.forEach(x=>all[x.id]={});
process.exit(f.applyUpdates(src,all)===src?0:1);
' "$ROOT" "$TMP/facts.yaml"
check $? "facts.yaml re-render is byte-identical"

node -e '
const f=require(process.argv[1]+"/lib/facts.js"), fs=require("fs");
const src=fs.readFileSync(process.argv[2],"utf8");
const out=f.applyUpdates(src,{"sample-fact":{status:"failed",note:"broke"}});
process.exit(/status: failed/.test(out) && /note: "broke"/.test(out) && /claim: "A sample/.test(out) ? 0 : 1);
' "$ROOT" "$TMP/facts.yaml"
check $? "status/note update rewrites only the targeted fields"

# --- redaction --------------------------------------------------------------
node -e '
const r=require(process.argv[1]+"/lib/redact.js");
const secrets=[
  // Built by concatenation on purpose: a literal here would trip every secret
  // scanner that ever reads this repo, including GitHub push protection, and a
  // test fixture is not worth a false alarm in someone else'"'"'s pipeline.
  "github" + "_pat_" + "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789",
  "sk" + "-ant-api03-" + "AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
  "postgres://u:pw@host:5432/db",
  "AKIA" + "IOSFODNN7EXAMPLE",
];
for (const s of secrets) {
  const out = r.scrub("prefix line\n" + s + "\nsuffix line").text;
  if (out.indexOf(s) !== -1) { console.error("leaked: " + s); process.exit(1); }
  if (r.looksSecret(out)) { console.error("gate still flags: " + s); process.exit(1); }
}
process.exit(0);
' "$ROOT"
check $? "redaction drops every secret shape and passes the egress gate"

# --- gauntlet: routing that must not depend on an LLM ----------------------
mkdir -p "$TMP/gt/repo"
printf 'export const Y = 2\n' > "$TMP/gt/repo/thing.ts"
node "$ROOT/test/gauntlet-routing.js" -- "$TMP/gt"
check $? "no-check and failing-check candidates never reach the examiner"

node -e '
const g = require(process.argv[1] + "/lib/gauntlet.js");
const fs = require("fs");
const p = g.quarantine({
  kind: "contradicts-existing-fact",
  decide: "decide which is wrong",
  fact: { id: "t-disp", claim: "new claim", scope: ["repo"], evidence: ["e"], check: "has a b" },
  model: "stub", verdict: "CONFIRMED", evidence: "examiner evidence",
  queries: ["2026-01-01 RUN select 1"],
  conflictsWith: [{ id: "old-fact", claim: "old claim", status: "verified" }],
});
const t = fs.readFileSync(p, "utf8");
// A dispute must carry BOTH sides plus the queries, or a human cannot arbitrate it.
const needed = ["candidate_id", "examiner_evidence", "examiner_db_queries", "conflicts_with", "old-fact", "decide"];
for (const k of needed) if (!t.includes(k)) { console.error("dispute record missing " + k); process.exit(1); }
fs.unlinkSync(p);
process.exit(0);
' "$ROOT"
check $? "a dispute record carries both sides, the queries, and what to decide"

"$ROOT/scripts/db-readonly.sh" "delete from games" >/dev/null 2>&1
[[ $? == 3 ]]; check $? "the examiner DB tool refuses a write statement"

# --- baseline diff: a regression is loud once, then quiet -------------------
mkdir -p "$TMP/bl/demo/repo-truth" "$TMP/bl/myrepo"
printf 'export const X = 1\n' > "$TMP/bl/myrepo/live.ts"
cat > "$TMP/bl/demo/repo-truth/facts.yaml" <<'YAML'
schema_version: 1
facts:
  - id: demo-file-present
    claim: "myrepo declares live.ts, which the demo fact watches."
    scope: ["myrepo"]
    evidence: ["myrepo/live.ts:1"]
    check: |
      has 'myrepo/live.ts' 'export const X'
    status: verified
    verified_at: "2026-09-26"
YAML
BL="$TMP/bl/base.json"
V() { "$ROOT/bin/gotcha" verify "$TMP/bl/demo" --root "$TMP/bl" --baseline "$BL" --quiet --report "$1"; }

V "$TMP/bl/r1.txt"; rc1=$?
[[ $rc1 == 0 ]] && grep -q '^BASELINE seeded' "$TMP/bl/r1.txt"
check $? "baseline seeds on first run and exits 0"

rm "$TMP/bl/myrepo/live.ts"              # break the fact
V "$TMP/bl/r2.txt"; rc2=$?
[[ $rc2 != 0 ]]; check $? "a new regression exits non-zero (got $rc2)"
grep -q '^REGRESSION demo-file-present: PASS (exit 0) -> FAIL (exit 1)' "$TMP/bl/r2.txt"
check $? "regression message names the fact and the transition"

V "$TMP/bl/r3.txt"; rc3=$?
[[ $rc3 == 0 ]]; check $? "the same failure stays quiet on the next run (got $rc3)"
grep -q 'regressions_since_baseline=0' "$TMP/bl/r3.txt"
check $? "unchanged failure reports zero regressions since baseline"

printf 'export const X = 1\n' > "$TMP/bl/myrepo/live.ts"   # fix it
V "$TMP/bl/r4.txt"; rc4=$?
[[ $rc4 == 0 ]] && grep -q '^IMPROVED demo-file-present' "$TMP/bl/r4.txt"
check $? "a recovery is reported and exits 0"

# verified -> failed (someone records the regression) must be loud exactly once
sed -i '' 's/^    status: verified$/    status: failed/' "$TMP/bl/demo/repo-truth/facts.yaml"
V "$TMP/bl/r5.txt"; rc5=$?
[[ $rc5 != 0 ]]; check $? "verified -> failed is loud once (got $rc5)"
V "$TMP/bl/r6.txt"; rc6=$?
[[ $rc6 == 0 ]]; check $? "verified -> failed is quiet on the following run (got $rc6)"

# plain mode (no --baseline) must be unaffected
"$ROOT/bin/gotcha" verify "$TMP/bl/demo" --root "$TMP/bl" --quiet --report "$TMP/bl/r7.txt" >/dev/null 2>&1
grep -q '^BASELINE' "$TMP/bl/r7.txt" && bad "plain mode leaked baseline output" || ok "plain mode emits no baseline lines"

# --- tick: lock, grace window, budget deferral ------------------------------
# Isolate FIRST. These touch state.json and the lock; without this they write the
# real ones, and the budget test silently overwrote today's actual spend.
export GOTCHA_HOME="$TMP/home"
mkdir -p "$GOTCHA_HOME"
node -e '
const path = require("path");
const ROOT = process.argv[1];
const lock = require(ROOT + "/lib/lock.js");
const a = lock.acquire();
if (!a.ok) { console.error("first acquire failed"); process.exit(1); }
const b = lock.acquire();
if (b.ok) { console.error("second tick acquired the lock too"); process.exit(1); }
a.release();
const c = lock.acquire();
if (!c.ok) { console.error("lock not released"); process.exit(1); }
c.release();
process.exit(0);
' "$ROOT"
check $? "only one tick holds the lock, and release frees it"

node -e '
const fs = require("fs"), path = require("path");
const ROOT = process.argv[1];
const lock = require(ROOT + "/lib/lock.js");
fs.mkdirSync(lock.LOCK_DIR, { recursive: true });
fs.writeFileSync(path.join(lock.LOCK_DIR, "pid"), "999999");
const r = lock.acquire();
if (!r.ok) { console.error("a dead holder still blocked the tick"); process.exit(1); }
r.release();
process.exit(0);
' "$ROOT"
check $? "a lock whose holder is dead is broken and reclaimed"

node -e '
const ROOT = process.argv[1];
const budget = require(ROOT + "/lib/budget.js");
const state = require(ROOT + "/lib/state.js");
state.write({ version: 1, transcripts: {}, budget: { date: budget.todayKey(), spentUsd: 4.5, calls: 3 } });
if (budget.remaining(5) > 0.51) { console.error("remaining wrong"); process.exit(1); }
budget.charge(0.6, 1);
if (budget.remaining(5) !== 0) { console.error("cap not enforced: " + budget.remaining(5)); process.exit(1); }
// a charge must survive another component writing its own slice of the state
state.patch({ lastHarvest: "2026-01-01T00:00:00Z" });
if (budget.read(state.read()).spentUsd < 5) { console.error("patch clobbered the budget"); process.exit(1); }
process.exit(0);
' "$ROOT"
check $? "budget caps spend, and a charge survives another component writing state"

# --- transient-measurement filter -------------------------------------------
node -e '
const h = require(process.argv[1] + "/lib/commands/harvest.js");
// Dated readings with no runnable check must not enter the fact table: they are
// true the day they are written and wrong a week later.
const drop = [
  "Approximately 107 admin systems exist, built in the last month",
  "Unshadowing feature added 126 previously unreachable filters",
  "NFL prop coverage in 2023-2025 is near-complete: 1.4% games lack QB lines",
  "The NFL anytime TD market contains 321 systems",
];
const keep = [
  "MLB team bet_type values are moneyline, total, run_line (NOT spread)",
  "HelloView does not import Mixpanel",
  "Prop system field IDs are stored with nfl_prop_ prefix",
];
for (const c of drop) if (!h.transientLooking(c)) { console.error("missed: " + c); process.exit(1); }
for (const c of keep) if (h.transientLooking(c))  { console.error("false positive: " + c); process.exit(1); }
process.exit(0);
' "$ROOT"
check $? "dated measurements are flagged, durable claims are not"

# --- marker idempotency -----------------------------------------------------
mkdir -p "$TMP/repo" && (cd "$TMP/repo" && git init --quiet)
printf '# Existing\n\nuser content\n' > "$TMP/repo/CLAUDE.md"
"$ROOT/bin/gotcha" install "$TMP/repo" >/dev/null 2>&1
a=$(cat "$TMP/repo/CLAUDE.md" "$TMP/repo/AGENTS.md" "$TMP/repo/.cursor/rules/repo-truth.mdc" 2>/dev/null | shasum | cut -d' ' -f1)
"$ROOT/bin/gotcha" install "$TMP/repo" >/dev/null 2>&1
b=$(cat "$TMP/repo/CLAUDE.md" "$TMP/repo/AGENTS.md" "$TMP/repo/.cursor/rules/repo-truth.mdc" 2>/dev/null | shasum | cut -d' ' -f1)
[[ $a == "$b" ]]; check $? "install is idempotent across runs"
grep -q 'user content' "$TMP/repo/CLAUDE.md"; check $? "install preserves surrounding content"
for f in CLAUDE.md AGENTS.md .cursor/rules/repo-truth.mdc; do
  grep -q 'gotcha-collector v1' "$TMP/repo/$f" || bad "pointer missing in $f"
done
ok "pointer present in all three convention files"

# --- preflight budget -------------------------------------------------------
start=$(date +%s%N 2>/dev/null || date +%s000000000)
"$ROOT/bin/gotcha" preflight "$TMP/repo" > "$TMP/pf.txt" 2>&1
end=$(date +%s%N 2>/dev/null || date +%s000000000)
ms=$(( (end - start) / 1000000 ))
bytes=$(wc -c < "$TMP/pf.txt" | tr -d ' ')
[[ $ms -lt 1000 ]]; check $? "preflight runs in under 1s (${ms}ms)"
[[ $bytes -lt 2048 ]]; check $? "preflight output under 2KB (${bytes} bytes)"

# --- dry-run harvest must not consume offsets ------------------------------
mkdir -p "$TMP/tx"
{
  printf '%s\n' '{"role":"assistant","message":{"content":[{"type":"text","text":"api-routes is dead, so I will ignore it."}]}}'
  printf '%s\n' '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>no, that is wrong, api-routes is actually live</user_query>"}]}}'
  printf '%s\n' '{"role":"assistant","message":{"content":[{"type":"text","text":"Understood, api-routes is deployed and serving."}]}}'
} > "$TMP/tx/s.jsonl"
# GOTCHA_HOME already exported above; state stays isolated for the whole suite.
before=$(node -e 'console.log(JSON.stringify(require(process.argv[1]+"/lib/state.js").read().transcripts||{}))' "$ROOT")
GOTCHA_TRANSCRIPT_ROOTS="cursor=$TMP/tx" "$ROOT/bin/gotcha" harvest --dry-run >/dev/null 2>&1
after=$(node -e 'console.log(JSON.stringify(require(process.argv[1]+"/lib/state.js").read().transcripts||{}))' "$ROOT")
[[ $before == "$after" ]]; check $? "dry-run harvest does not advance transcript offsets"

# --- harvest is incremental -------------------------------------------------
# Uses a transcript with NO correction cues, so no window is built and no model is
# ever invoked -- this suite stays fully offline while still proving incrementality.
mkdir -p "$TMP/tx2"
printf '%s\n' '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>please add a column to the report</user_query>"}]}}' > "$TMP/tx2/s.jsonl"
out1=$(GOTCHA_TRANSCRIPT_ROOTS="cursor=$TMP/tx2" "$ROOT/bin/gotcha" harvest 2>&1)
out2=$(GOTCHA_TRANSCRIPT_ROOTS="cursor=$TMP/tx2" "$ROOT/bin/gotcha" harvest 2>&1)
grep -qv '0KB new content' <<<"$out1"; check $? "first harvest run reads new content"
grep -q '0KB new content' <<<"$out2"; check $? "second harvest run finds zero new content"

# --- unknown tool directories are skipped, not fatal ------------------------
out3=$(GOTCHA_TRANSCRIPT_ROOTS="codex=$TMP/does-not-exist" "$ROOT/bin/gotcha" harvest 2>&1)
grep -q 'no codex transcripts' <<<"$out3"; check $? "a missing tool directory is skipped with a note"

# --- a scaffolded repo must verify clean from the very first run ------------
# A clean-account run reached a PROMOTE verdict and then rolled the whole batch
# back: the only verify.sh in existence was the author's, hardcoding
# `for repo in user-dashboard client-platform ios-app`. And the first empty table
# tripped "SCHEMA-ERROR header: zero facts", because verify.sh requires a fact.
mkdir -p "$TMP/scaffold/newrepo"
( cd "$TMP/scaffold/newrepo" && git init -q && git -c user.email=a@b.c -c user.name=T commit -q --allow-empty -m seed ) >/dev/null 2>&1
node -e '
  require(process.argv[1] + "/lib/scaffold.js").ensure(process.argv[2], ["newrepo"]);
' "$ROOT" "$TMP/scaffold/newrepo"
( cd "$TMP/scaffold/newrepo" && git add -A && git -c user.email=a@b.c -c user.name=T commit -q -m scaffold ) >/dev/null 2>&1
scaf=$(bash "$TMP/scaffold/newrepo/repo-truth/verify.sh" "$TMP/scaffold" 2>&1 | tail -1)
[[ $scaf == "SUMMARY facts=1 verified_regressions=0" ]]; check $? "a freshly scaffolded repo-truth/ verifies clean"

# The template must stay behaviourally identical to the verifier actually in use,
# or installs quietly diverge from the repo they were modelled on.
if [[ -f "$HOME/user-dashboard-main/repo-truth/verify.sh" ]]; then
  diff <(sed 's/\$GOTCHA_ORPHAN_REPO/user-dashboard/g; s/for repo in \$GOTCHA_REPOS; do/for repo in user-dashboard client-platform ios-app; do/; s|/directory/containing/the/clones|/directory/containing/the/three/clones|' "$ROOT/lib/templates/verify.sh" \
    | grep -v 'GOTCHA_REPOS=\|GOTCHA_ORPHAN_REPO=\|^# --- which clones\|^# Written by\|^# others under ROOT\|^# is the ONLY repo\|^# The repo the .orphans') \
    "$HOME/user-dashboard-main/repo-truth/verify.sh" >/dev/null 2>&1
  check $? "the scaffold template matches the verifier in use"
else
  echo "  SKIP template drift check (no reference verifier)"
fi

# --- every CLI flag must be declared value-taking or boolean ----------------
# A flag missing from VALUE_FLAGS parses as `true` and its value is dropped.
# Shipped three times, most memorably as `gh repo list true`.
node "$ROOT/test/flag-audit.js" --check >/dev/null 2>&1
check $? "every flag read in lib/ is declared in VALUE_FLAGS or BOOLEAN_FLAGS"

# --- gotcha's own test debris must never become a fact ----------------------
# "Queued test candidate number 3 with a runnable check" passed a mechanical
# check, an independent sonnet examiner that CONFIRMED it, and the coherence
# scan, and was written into facts.yaml. Every level asks "is this claim true?",
# and a fixture's claim usually is -- so Level 0 asks a different question.
mkdir -p "$TMP/synroot/somerepo"
: > "$TMP/synroot/somerepo/present.txt"
syn=$(node -e '
  const g = require(process.argv[1] + "/lib/gauntlet.js");
  const fact = {
    id: "queued-candidate-7",
    claim: "Queued test candidate number 7 with a runnable check.",
    scope: ["somerepo"], evidence: ["somerepo/present.txt"],
    check: "file 'somerepo/present.txt'\n",
    status: "human-asserted", verified_at: "2026-09-26", source: "test fixture",
  };
  const r = g.runLevels(fact, { root: process.argv[2], here: process.argv[2], existing: [], cfg: {}, opts: {} });
  console.log([r.outcome, r.level, r.synthetic ? "synthetic" : "-", (r.reasons || []).length].join("|"));
' "$ROOT" "$TMP/synroot")
[[ $syn == "disputed|0|synthetic|3" ]]; check $? "a synthetic candidate is quarantined at level 0, never promoted"

# It must stop BEFORE the examiner: adjudicating fixtures costs real money.
[[ $syn != *"promote"* ]]; check $? "a synthetic candidate never reaches promotion"

# And the deliberate opt-in must still work, or legitimate test flows break.
synok=$(node -e '
  const s = require(process.argv[1] + "/lib/synthetic.js");
  const base = { id: "queued-candidate-7", claim: "Queued test candidate number 7.", evidence: [] };
  const blocked = s.detect(base).synthetic;
  const allowed = s.detect(Object.assign({}, base, { synthetic_ok: "true" })).synthetic;
  console.log(blocked + "|" + allowed);
' "$ROOT")
[[ $synok == "true|false" ]]; check $? "synthetic_ok: \"true\" lets a deliberate fixture through"

# The guard is worthless if it flags real facts. Every fact in the live table
# must pass clean.
if [[ -f "$HOME/user-dashboard-main/repo-truth/facts.yaml" ]]; then
  fp=$(node -e '
    const s = require(process.argv[1] + "/lib/synthetic.js");
    const facts = require(process.argv[1] + "/lib/facts.js");
    const doc = facts.parse(require("fs").readFileSync(process.argv[2], "utf8"), { strict: false });
    console.log(doc.facts.filter((f) => s.detect(f).synthetic).length);
  ' "$ROOT" "$HOME/user-dashboard-main/repo-truth/facts.yaml")
  [[ $fp == 0 ]]; check $? "the synthetic guard flags no real fact in the live table"
else
  echo "  SKIP synthetic false-positive sweep (no live fact table)"
fi

# --- every line of a multi-line check must gate the result ------------------
# `eval "$body"` returns only the LAST line's status. Without `set -e` a five-line
# check was a one-line check with four comments: earlier assertions printed their
# failure and were discarded. Found by mutating the exact line a check existed to
# catch and watching the fact still pass.
# Check paths are repo-prefixed, as every real check is.
mkdir -p "$TMP/checkroot/somerepo"
: > "$TMP/checkroot/somerepo/present.txt"
runbody() {
  node -e 'console.log(require(process.argv[1] + "/lib/checks.js").runCheck(process.argv[3], { root: process.argv[2], here: process.argv[2] }).rc)' \
    "$ROOT" "$TMP/checkroot" "$1"
}
multi=$(runbody "missing 'somerepo/gone.txt'
file 'somerepo/present.txt'
")
[[ $multi == 0 ]]; check $? "a multi-line check passes when every line passes"
multi2=$(runbody "file 'somerepo/nothere.txt'
file 'somerepo/present.txt'
")
[[ $multi2 != 0 ]]; check $? "a FAILING first line fails the whole check, not just the last line"

# --- extraction failure must HOLD watermarks --------------------------------
# The bug this guards: launchd runs with a bare PATH, so `claude` was unfindable and
# every chunk died with ENOENT. The harvester counted each failure as "0 candidates",
# advanced the watermarks, and looked healthy. Fifteen ticks consumed real transcript
# content and extracted nothing from it.
mkdir -p "$TMP/tx-infra"
{
  printf '%s\n' '{"role":"assistant","message":{"content":[{"type":"text","text":"api-routes is dead, so I will ignore it."}]}}'
  printf '%s\n' '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>no, that is wrong, api-routes is actually live</user_query>"}]}}'
  printf '%s\n' '{"role":"assistant","message":{"content":[{"type":"text","text":"Understood, api-routes is deployed and serving."}]}}'
} > "$TMP/tx-infra/s.jsonl"
# Zero the isolated budget first: a run that defers on budget never reaches the
# extractor, so it would pass this test without exercising anything.
node -e 'require(process.argv[1]+"/lib/state.js").patch({budget:{}})' "$ROOT"
wm_before=$(node -e 'console.log(JSON.stringify(require(process.argv[1]+"/lib/state.js").read().transcripts||{}))' "$ROOT")
infra_out=$(GOTCHA_EXTRACTOR_BIN=/nonexistent/claude \
  GOTCHA_TRANSCRIPT_ROOTS="cursor=$TMP/tx-infra" "$ROOT/bin/gotcha" harvest 2>&1)
wm_after=$(node -e 'console.log(JSON.stringify(require(process.argv[1]+"/lib/state.js").read().transcripts||{}))' "$ROOT")
[[ $wm_before == "$wm_after" ]]; check $? "a failed extractor does NOT advance transcript watermarks"
grep -q 'EXTRACTION FAILED' <<<"$infra_out"; check $? "a failed extractor logs loudly"
grep -q 'watermarks NOT advanced' <<<"$infra_out"; check $? "a failed extractor says the watermarks were held"

# --- the extractor binary is resolved, never inherited from PATH ------------
# `which claude` succeeds in the owner's shell and fails under launchd, so the
# resolver must find it by absolute path, not by PATH lookup.
resolved=$(node -e 'console.log(require(process.argv[1]+"/lib/extractor.js").discover() || "")' "$ROOT")
[[ -n $resolved && -x $resolved ]]; check $? "the extractor binary resolves to an absolute executable path"

# --- a barren tick run is reported as unhealthy, not quiet ------------------
health=$(GOTCHA_EXTRACTOR_BIN=/nonexistent/claude \
  GOTCHA_TRANSCRIPT_ROOTS="cursor=$TMP/tx-infra" "$ROOT/bin/gotcha" status 2>&1)
grep -q 'ATTENTION' <<<"$health"; check $? "status flags ticks that find lessons but extract none"

# --- discovery mining must not blow up the prefilter ------------------------
# Discoveries were added because the day's two best lessons were findings, not
# corrections. But discovery language is common, and every extra window is a chunk
# someone pays for, so the agreed ceiling is roughly double.
node "$ROOT/test/cue-growth.js" --check >/dev/null 2>&1
check $? "discovery cues keep prefilter growth under the agreed ceiling"

# --- an unknown transcript tool name is an error, not silence ---------------
# `claude=` instead of `claude-code=` read every file, normalized zero turns, and
# reported "0 correction-shaped exchange(s)" as if the transcripts held no lessons.
unknown=$(GOTCHA_TRANSCRIPT_ROOTS="claude=$TMP/tx-infra" "$ROOT/bin/gotcha" harvest 2>&1)
grep -q 'unknown tool' <<<"$unknown"; check $? "an unknown transcript tool name fails loudly"

# --- matcher regression: a real session must not be buried in facts ---------
# The matcher's failure mode is invisible per-call -- every fact it surfaced was
# genuinely anchored to a touched file. It only shows up over a whole session, so
# the guard is a replay of one: test/fixtures/tracked-picks-session.json.
if [[ -f "$HOME/.local/share/gotcha/hook-index.json" || -n ${GOTCHA_HOOK_INDEX:-} ]]; then
  node "$ROOT/test/replay.js" --check >/dev/null 2>&1
  check $? "session replay: no fact repeats, generic anchors stay quiet"
else
  echo "  SKIP session replay (no hook index built)"
fi

# --- once-per-session dedupe -------------------------------------------------
dedupe=$(GOTCHA_SEEN_DIR="$TMP/seen" node -e '
  const seen = require(process.argv[1] + "/lib/seen.js");
  const h = [{ f: { id: "a", status: "verified" } }];
  const first  = seen.filter("sess-1", h).length;
  const second = seen.filter("sess-1", h).length;
  const changed = seen.filter("sess-1", [{ f: { id: "a", status: "failed" } }]).length;
  const again   = seen.filter("sess-1", [{ f: { id: "a", status: "failed" } }]).length;
  const other   = seen.filter("sess-2", h).length;
  console.log([first, second, changed, again, other].join(","));
' "$ROOT")
[[ $dedupe == "1,0,1,0,1" ]]; check $? "a fact fires once per session, re-fires once on status change"

echo ""
echo "  $pass passed, $fail failed"
[[ $fail == 0 ]]
