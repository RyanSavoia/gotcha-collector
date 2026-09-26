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

echo ""
echo "  $pass passed, $fail failed"
[[ $fail == 0 ]]
