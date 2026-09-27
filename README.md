# Gotcha Collector

**Verified memory for AI coding agents.**

Memory tools for coding agents store what an agent once *believed*. None of them
check whether it is still true. Gotcha Collector stores facts that carry **evidence**
and a **runnable check**, re-runs those checks on a schedule, and demotes any claim
whose check fails to `failed` — so the next agent is warned off it instead of
confidently repeating it.

Memory with receipts.

```
  claim ──▶ evidence ──▶ check ──▶ verify ──┬─ passes ─▶ verified
                                            └─ fails  ─▶ failed  (DISPROVEN)
```

---

## Install

Zero dependencies, Node ≥ 14, macOS/Linux. Nothing runs in the background until
you ask for it.

```sh
npm install -g gotcha-collector
```

Or without npm:

```sh
curl -fsSL https://raw.githubusercontent.com/RyanSavoia/gotcha-collector/main/install.sh | sh
```

Or from source:

```sh
git clone https://github.com/RyanSavoia/gotcha-collector.git ~/gotcha-collector
cd ~/gotcha-collector && ./bin/gotcha --help
ln -s ~/gotcha-collector/bin/gotcha /usr/local/bin/gotcha   # optional
```

Then point it at your repos:

```sh
gotcha init --repo ~/your-repo          # records config, scaffolds repo-truth/
gotcha install ~/your-repo              # pointer files so agents find the table
gotcha doctor                           # confirm everything is wired
```

`gotcha init` writes `<repo>/repo-truth/verify.sh` and a seeded
`facts.yaml` if the repo has none, and records which repos the verifier is
written against. It never overwrites an existing table or verifier.

Facts live **in the repos they describe**, at `<repo>/repo-truth/facts.yaml`, and
gotcha reads and writes that file in place — it never relocates it. If you already
have a fact table wired to CI, keep it where it is and point `--facts-repo` at it.

---

## The fact schema

Unchanged from `repo-truth/facts.yaml`; gotcha matches it byte-for-byte (re-rendering
all 85 existing facts reproduces the file exactly).

```yaml
  - id: build-skips-type-errors
    claim: "Next.js configuration sets ignoreBuildErrors to true, so a passing build does not establish type correctness."
    scope: ["user-dashboard"]
    evidence: ["user-dashboard/next.config.mjs:12"]
    check: |
      has 'user-dashboard/next.config.mjs' 'ignoreBuildErrors: true'
    status: verified
    verified_at: "2026-09-25"
```

| status | meaning | agents should |
|---|---|---|
| `verified` | a check re-ran and passed | trust it |
| `verified-runtime` | a dated external observation (hosting, traffic) the offline verifier cannot repeat | trust the date, re-observe before acting |
| `human-asserted` | probable, no offline proof | confirm before relying on it |
| `failed` | **disproven** — tested and contradicted | never rely on it |

Checks are bash, evaluated with the helpers `has`, `code`, `file`, `missing`,
`absent`, `default_branch`, `groups`, `orphans`, `unresolved`. Paths are relative to
a directory holding the repo clones, so they begin with the repo name.

---

## The six commands

### `gotcha verify [repo-path]`

Re-runs every fact's check and reports what is still true.

```sh
gotcha verify ~/user-dashboard                 # report only
gotcha verify ~/user-dashboard --write         # record status changes
gotcha verify ~/user-dashboard --touch --write # also refresh verified_at on passes
gotcha verify --github-action                  # print a drop-in weekly workflow
```

- `--write` demotes a `verified` claim whose check now fails to `failed`, recording
  the failing output in the fact's `note`. Without it, nothing is written.
- `--touch` additionally refreshes `verified_at` on facts that still pass. Off by
  default: it rewrites ~75 lines per run and buries the one change worth reviewing.
- `--facts PATH` verifies an alternate table (mirrors `verify.sh`'s `REPO_TRUTH_FACTS`).
- `--baseline PATH` compares against the previous run and fails only on new regressions
  (see below).
- `--root DIR` sets the directory containing the clones (default: the repo's parent).
- Exit status is non-zero when a verified claim regressed.

> **Run `--write` against clean default-branch clones.** Checks are evaluated against
> whatever trees are under `--root`. Your local clones sit on feature branches with
> uncommitted work, so a check can fail for reasons that have nothing to do with the
> claim being false — on this machine `owner-house-board-key` fails against the local
> `client-platform` checkout but passes on `origin/master`. Demoting on that basis
> records a falsehood. Report freely against local trees; `--write` only against fresh
> clones of the default branches, which is what the CI workflow does.

### Baselines: make a regression loud exactly once

`verify.sh` treats `failed` as an *already-recorded* disproven claim that does not fail
the build — so recording a regression simultaneously silences it, and nobody is told on
the day it happened.

`--baseline <path>` fixes that by making the exit status a **diff** rather than an
absolute state. The file stores the previous run's outcome per fact; the run fails when
an outcome got worse than last time:

| transition | result |
|---|---|
| check was passing, now fails | **exit 1** — loud |
| `verified` → `failed` (regression recorded) | **exit 1** — loud |
| already failing, still failing | exit 0 — the acknowledged state |
| failing → passing | exit 0, reported as `IMPROVED` |
| first run, no baseline file | exit 0, `BASELINE seeded` |

```sh
gotcha verify ~/user-dashboard --baseline .gotcha-baseline.json
```

The baseline is rewritten every run, so a regression is loud on the run it appears and
quiet thereafter. **That acknowledgement is implicit** — nobody has to confirm it. If
you would rather a regression stay red until it is actually fixed, keep the baseline
read-only between runs (restore it from a pinned artifact rather than the rolling
cache) and the same fact will fail every time.

Without `--baseline`, verify behaves exactly as `verify.sh` does, byte for byte — the
baseline lines are not even emitted. `verify --github-action` wires the baseline
through an `actions/cache` rolling key and uploads it as an artifact.

> **Note on `--write` and CI.** The existing `verify.sh` treats `failed` as a
> *recorded* disproven claim that does **not** fail the build. So demoting a
> regression turns a red weekly run green. That is the correct end state — the table
> now says the claim is false — but review the demotion before committing it, or a
> real regression can be silently normalized. `gotcha verify` always exits non-zero
> and prints `DISPROVEN NOW` for anything it demotes in that run.

### `gotcha audit [repo-path...] [--org NAME]`

Onboarding for an ecosystem with no fact table yet. Reads git metadata, manifests,
CI workflows and deploy configs, probes the hosts it finds, and drafts a `facts.yaml`
where most facts already carry runnable checks.

```sh
gotcha audit ~/web ~/api ~/mobile \
  --org your-github-org --out /tmp/draft.yaml
```

Hosts are classified before probing: a domain counts as *yours* when the org
publishes it as a repo homepage, when you pass `--domain`, when several distinct
subdomains appear under it, or when it is cited across several of your own files.
Everything else is reported as an external reference and never drafted as a fact —
`nextjs.org` being reachable is not a fact about your infrastructure.

Its best trick is the contradiction it draws between git and reality:

```
  LIVE HOSTS FOUND:
    api-routes-two-chi.vercel.app  HTTP 200   <- LIVE BUT FORGOTTEN (api-routes idle 145d)
    data.thebettinginsider.com     HTTP 200
```

Drafts go to `~/gotcha-collector/drafts/` — never straight into a real table.

### `gotcha harvest`

Mines agent session transcripts for gotchas — an agent assuming something wrong and a
human correcting it — and drafts them as candidates.

```sh
gotcha harvest                      # incremental
gotcha harvest --dry-run            # prefilter only, no LLM, no offsets consumed
gotcha harvest --limit 40 --model haiku
gotcha harvest --save-prompts /tmp/prompts   # dump exactly what would be sent
```

Scans Cursor (`~/.cursor/projects/*/agent-transcripts/**/*.jsonl`), Claude Code
(`~/.claude/projects/**/*.jsonl`) and Codex (`~/.codex/sessions/**/*.jsonl`); a tool
whose directory is absent is skipped with a note. Progress is tracked per file and
byte offset in `state.json`, so a second run does no work.

It mines **two** signals, not one:

- a human contradicting the agent — *"no, that's wrong, api-routes is live"*
- the agent conceding it was wrong — *"you're right, I incorrectly assumed..."*

The second matters more than it looks. The agent's concession usually states the
corrected truth explicitly, where the human's reply is often just "no". Harness-
generated user turns (context summaries, task notifications) are excluded, since they
are not a human correcting anything.

Only whole lines are consumed, so a session still being written is resumed correctly
rather than half-read. A ~300MB transcript corpus is reduced by cue-matching to a few
hundred correction-shaped exchanges before any model sees it.

**Secrets.** Every chunk is scrubbed *before* it reaches the model, the file, or the
console — GitHub PATs, `sk-`/`sk-ant-` keys, `Bearer` headers, JWTs, AWS keys, and
connection strings with inline credentials. Matching lines are dropped whole, not
masked. A final gate re-checks each candidate and drops anything still secret-shaped.
`--save-prompts` exists so you can grep what was actually sent.

The tradeoff is deliberate: dropping is done at **line** granularity, so if a secret
shares a line with a real correction, that correction is lost too. Recall is the thing
we give up; a leaked credential is not.

**Proposed checks are proved before they are written.** See Limits — most are wrong,
and an unproven check is worse than none because it looks verifiable.

**Dated measurements are rejected.** A model mining transcripts happily produces
"approximately 107 admin systems exist, built in the last month" or "126 previously
unreachable filters were added". Those are readings, not truths — correct the day they
are written and wrong a week later, and a fact table that accumulates them decays into
exactly the misinformation this tool exists to prevent. Harvest drops a claim that
looks like a measurement *and* has no runnable check. A number a check can re-prove
(an enum list, a declared cron count) stays, because the verifier will catch it the
moment it stops being true.

Candidates land in `~/gotcha-collector/candidates/<date>.yaml` with a `source` field.
They are **never** written into a real fact table. Rejected ones are moved to
`<date>.rejected.yaml` rather than deleted — if one is genuinely durable, give it a
check and move it back.

### `gotcha promote` — the three-level gauntlet

With no id, `promote` runs every eligible candidate through a gauntlet and promotes
what survives, **with no human approval**. The design exploits an asymmetry: writing a
claim from a noisy transcript is error-prone, but auditing an already-written claim
against real code is reliable.

| level | asks | fails how |
|---|---|---|
| **1 — mechanical** | does the check pass? | no → not promoted. No check at all → human-asserted track, no model call |
| **2 — adversarial audit** | can a fresh examiner *disprove* it? | `DISPROVEN` → `disputed/`. `CANNOT-VERIFY` → stays a candidate |
| **3 — coherence** | does it contradict an existing fact? | yes → **both** quarantined to `disputed/` |

Survivors land as `verified` with a provenance field:

```yaml
    provenance: "auto-gauntlet (L2: sonnet, 2026-09-26)"
```

The weekly verifier is the standing fourth level: a fact that stops being true gets
demoted later regardless of how it entered.

**Level 2 is the load-bearing one, and its value is entirely in its independence.**
The examiner receives *only* the claim, its scope, and its check — never the
transcript, the harvester's reasoning, the wrong assumption that produced the claim,
or sibling candidates. If it inherited any of that it would inherit the misreading
too, and would be auditing the harvester rather than the world. It runs on a
**different model** than extraction (config `models.examiner`) so the two do not share
blind spots, and it is told to disprove rather than confirm — "partial truth is
DISPROVEN".

It gets read access to the repo checkouts and **read-only** Postgres through
`scripts/db-readonly.sh`, which screens for write keywords, runs inside a
`BEGIN READ ONLY` transaction (Postgres rejects a write even if the screen is
bypassed), and logs every statement into the dispute record. The examiner never sees
the connection string.

```sh
gotcha promote                     # run the gauntlet (the normal path)
gotcha promote --max 5             # cap this batch
gotcha promote <id> --force        # deliberate manual override
gotcha audit-claim <id>            # level 2 alone, for inspection
```

**Atomicity.** The gauntlet never hand-writes `facts.yaml`. It renders through the
same schema path manual promotion uses, re-parses strictly, then runs `verify.sh` over
the whole file. If anything fails, the **entire batch** is rolled back to the
pre-batch bytes and quarantined. Killing a run mid-batch leaves the file untouched,
because nothing is written until every candidate has been judged.

### `gotcha hooks install`

Wires the pre-action hook into Claude Code (`~/.claude/settings.json`, `PreToolUse`)
and Cursor (`~/.cursor/hooks.json`, or `--project <path>` for project-level). One
script speaks both protocols, keyed off the payload shape:

| editor | event | reply shape |
|---|---|---|
| Claude Code | `PreToolUse` | `hookSpecificOutput.additionalContext` |
| Cursor | `beforeShellExecution` | `{ permission, agent_message, user_message }` |
| Cursor | `sessionStart` | `{ env, additional_context }` |

~80ms, no model call, a prebuilt index rather than a YAML parse. Warn-only:
enforcement is per-fact, owner-set via `enforce: "true"`, shell commands only, and
nothing ships enforcing. Disproven facts rank first — "we tested this and it is
false" is the most useful thing to tell an agent about to act on it.

No Cursor `matcher` is written: matchers are JavaScript regex, and one that silently
fails to match yields a hook that looks installed and never fires. `failClosed` is
left off — a memory tool must never block work by crashing.

> **`sessionStart` does not currently reach the agent on Cursor.** As of 2026-09-26
> Cursor drops `additional_context` from `sessionStart` (timing bug, confirmed by
> Cursor staff); `env` from the same hook still works. The hook is installed with the
> correct field for when the fix ships, and fails open until then. **So the
> `CLAUDE.md` / `AGENTS.md` / `.cursor/rules` pointer is still load-bearing on
> Cursor** — the hook is a complement, not a replacement. Tracked as fact
> `cursor-sessionstart-context-dropped`. `beforeShellExecution` is unaffected and
> works today.

### `gotcha digest`

The one screen a human reads. Writes `DIGEST.md`: disputes awaiting arbitration
(usually none), facts auto-promoted this week, the human-asserted queue, and verifier
health. Wired into the weekly cron.

### `disputed/`

One YAML per dispute, holding the claim, the harvester's evidence, the examiner's
verdict and evidence, the exact DB queries it ran, and — for a contradiction — the
existing fact it collides with. Each says what has to be decided. **These are the only
things that still need you.**

### `gotcha install [repo-path]`

Writes one pointer block into `CLAUDE.md`, `AGENTS.md` and
`.cursor/rules/repo-truth.mdc`, so Claude Code, Codex and Cursor all discover the
table. The block is wrapped in a checksummed marker
(`<!-- gotcha-collector v1 ... -->`), so surrounding content is never touched and a
second run reports `unchanged`. Files are left modified for your review, not committed.

### `gotcha preflight [repo-path]`

Session-start reality check: under a second, under 2KB, no LLM. Prints the current
branch and ahead/behind, the untracked-file count split into source-looking vs
scratch (underscore-prefixed files under `scripts/` are diagnostic scratch in this
ecosystem), the five most relevant facts, and **every** `failed` fact.

The five are picked one-per-family, so five slots aren't spent on five nearly
identical Vercel cron facts.

```
PREFLIGHT user-dashboard
  branch factory/workflow-tools vs origin/main (+0/-48)
  untracked 418: 111 source-looking, 307 scratch/diagnostic
  facts 85 total, 56 in scope (from origin/main; not in this working tree)

  DISPROVEN — do not rely on these:
   x failed-no-league-id: The checked-in Drizzle schema declares no league_id column.
```

If `repo-truth/` exists on the default branch but not in your current working tree,
preflight reads it from `origin/main` rather than checking anything out — that is
exactly when an agent most needs the warnings. Read-only commands only.

### `gotcha status`

One screen: facts by status per tracked repo, candidates awaiting review, last
harvest/verify times, and which repos have pointer blocks installed.

---

## Review → promote workflow

Nothing reaches a fact table without a human in the loop.

```
  harvest ─▶ candidates/<date>.yaml ─▶ you read it ─▶ gotcha promote <id>
                                                          │
                                                   check runs here
                                                          ▼
                                            verified  or  human-asserted
                                                          │
                                                   git diff / commit  (you)
```

1. `gotcha harvest` — drafts candidates, commits nothing.
2. Read `~/gotcha-collector/candidates/<date>.yaml`. Each candidate records the wrong
   assumption, the correction, its source transcript, and whether it may refine an
   existing fact (`refines:`).
3. `gotcha promote <id> --repo ~/user-dashboard` — runs the check, inserts the fact.
4. `git -C ~/user-dashboard diff -- repo-truth/facts.yaml`, then commit yourself.

The same rule holds everywhere: `verify --write`, `install`, and `promote` all leave
changes in the working tree. **Gotcha never commits, never pushes, never opens a PR.**

---

## Schedule

| what | when | cost when idle |
|---|---|---|
| `harvest --incremental` | **every 5 minutes** (launchd) | ~100ms, no model call |
| gauntlet (`promote`) | nightly 02:30, **or early at 15 queued candidates** | — |
| `verify --baseline` + `map verify` + `digest` | weekly, Mon 03:15 | — |

Harvest is a frequent tick rather than a nightly sweep, so a correction becomes a
candidate within minutes of the session that produced it. Four properties make a
5-minute cadence affordable:

**Grace window.** A transcript is only read once it has been *quiet* for 2 minutes
(`harvest.graceMs`). A file still being appended to is skipped whole and its
watermark does not move — so nothing is skipped, only postponed. Reading a partial
tail and advancing past it would lose whatever lands next.

**Cheap empty ticks.** The common case is nothing to do. The tick stats the
transcript tree, compares sizes against the watermark, and exits — **~100ms, no file
opened, no model call, no output**. Pass `--debug` if you want it to say so.

**One tick at a time.** A `mkdir`-based lock; a second tick exits immediately. A lock
whose holder PID is dead is broken and reclaimed.

**A shared daily budget.** `budget.dailyUsd` (default $5) covers the ticks *and* the
gauntlet's examiner runs. Over the cap a tick **defers**: it holds the watermark so
the content is mined after the daily reset rather than silently consumed. Cost is
charged from the CLI's reported `total_cost_usd`, not estimated.

The gauntlet stays batched because its examiner costs ~$0.07 per candidate — the tick
only *collects*. It fires nightly, or early once the queue reaches 15 adjudicable
candidates, both drawing on the same budget.

```sh
launchctl list | grep gotcha          # is the tick loaded?
gotcha status                         # schedule + today's spend
gotcha harvest --incremental --debug  # run one tick verbosely
tail -f ~/gotcha-collector/harvest.log
```

## Installing the schedule

```sh
launchctl load ~/Library/LaunchAgents/com.gotcha.harvest-tick.plist   # 5-min tick
crontab -l                                                            # nightly + weekly
```

`gotcha status` shows the schedule and today's spend. Nothing is lost by ignoring it
for a week: harvest is incremental and the gauntlet is idempotent.

For scheduled *verification*, `gotcha verify --github-action` prints a workflow you
can drop into any repo. This ecosystem already has one (`.github/workflows/repo-truth.yml`).

---

## Fork or fresh? (the short version)

We evaluated [`code-recall`](https://github.com/erikhuang76821/code-recall) (MIT) and
chose to **write fresh while adopting its conventions**, borrowing its secret-redaction
patterns, atomic write and marker-block idiom with attribution.

Its unit of memory is a prose decision narrative under a token budget; ours is a
verifiable claim whose exact bytes must stay runnable. Its README names drift
detection as explicitly out of scope — which is precisely our product. And our
verifier already exists and is wired to CI, so the job was to generalize that, not to
replace it.

Full reasoning in [`DECISION.md`](DECISION.md); borrowed code is listed in
[`ATTRIBUTION.md`](ATTRIBUTION.md).

---

## Layout

```
bin/gotcha              CLI entry point
scripts/review-summary.js  generates REVIEW.md from live state
lib/facts.js            the restricted facts.yaml grammar (line-preserving writes)
lib/checks.js           runs a check with verify.sh's exact semantics
lib/verify-preamble.sh  check helpers, lifted verbatim from repo-truth/verify.sh
lib/baseline.js         per-fact outcome diff, so a regression is loud once
lib/redact.js           secret scrubbing (adapted from code-recall, MIT)
lib/markers.js          idempotent marker blocks
lib/transcripts.js      Cursor / Claude Code / Codex readers, incremental
lib/table.js            locating the table that governs a repo
lib/commands/           verify, audit, harvest, promote, install, preflight, status
state.json              transcript offsets + last-run times
candidates/             harvest output, awaiting review
drafts/                 audit output, awaiting review
```

## Review queue

`node scripts/review-summary.js` writes **`REVIEW.md`**: what is waiting, which
candidates have a check that passes *right now* (those promote straight to
`verified`), and the exact promote command for your current checkout. It reads live
state rather than being hand-maintained, so it cannot drift from the files. Re-run it
after any harvest.

Alongside `candidates/<date>.yaml` you may see two sidecars, both kept for review
rather than deleted:

| file | holds |
|---|---|
| `<date>.rejected.yaml` | dated measurements with no runnable check |
| `<date>.duplicates.yaml` | near-duplicates, collapsed in favour of a stronger copy |

## Environment overrides

| variable | effect |
|---|---|
| `GOTCHA_HOME` | relocate `state.json`, `candidates/`, `drafts/` (used by the test suite so a test run cannot clobber a real harvest's state) |
| `GOTCHA_TRANSCRIPT_ROOTS` | override scan locations as `tool=/path:tool=/path`, so redaction can be tested against a scratch corpus instead of your real Cursor/Codex data |

`bash test/run.sh` runs the offline suite — no LLM, no network.

## Limits

- Checks are **source and configuration** assertions. They do not prove production
  traffic, deployed binaries, database state, or payload compatibility.
- `verified-runtime` facts are dated observations; an offline green run does not
  re-confirm that a host is still serving.
- `harvest` extraction quality depends on the model; candidates are drafts, and the
  review step is load-bearing, not a formality. **Measured on this machine, only about
  1 in 7 model-proposed checks actually passes** — the rest name a plausible but wrong
  path. Harvest therefore *runs every proposed check before writing it* and downgrades
  the failures to `unresolved`, so a review file never carries a check that cannot
  succeed. A claim that survives with a check is one the verifier really can re-prove.
  `promote` re-runs it anyway, so even a check that rots between draft and promotion
  enters as `human-asserted` with the failure recorded, never as a false `verified`.
- `orphans()` carries a hardcoded expectation of 43 candidate files, inherited from
  `verify.sh`. It is part of that check's contract; re-generate the sidecar list if
  the set changes.
