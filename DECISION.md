# Fork code-recall, or write fresh?

**Decision: (b) write fresh, adopt code-recall's conventions, borrow two of its
algorithms verbatim with attribution.**

Evaluated `erikhuang76821/code-recall` @ v2.15.0 (MIT, cloned to
`~/gotcha-collector-eval/code-recall`): 4,769 lines in a single zero-dependency
`coderecall.js`, `engines.node >=10.12`, requires only `fs/path/os/crypto/child_process`.
It is genuinely good code — careful comments, fail-loud parsing, atomic writes, an
ownership-token lock, and hard-won bug history in `CHANGELOG.md`.

## Why not fork

1. **The data models do not meet.** code-recall's unit of memory is a *decision
   narrative* — prose ADRs and lessons in markdown ledgers (`.ai/memory/DECISIONS.md`,
   `LESSONS.md`, `TASK.md`), parsed line-wise and governed by *token budgets*
   (`LEDGER_TOKEN_BUDGET = 1000`), with `consolidate` compacting prose as files grow.
   Our unit is a *verifiable claim*: `id / claim / scope / evidence / check / status /
   verified_at`, where `check` is executable bash. Grafting a `check:` field onto a
   prose ledger means either fighting their markdown parser or replacing their core —
   and their compaction machinery, which summarizes prose to save tokens, is actively
   wrong for a field whose exact bytes must stay runnable.

2. **Our verifier already exists and is wired to CI.** `repo-truth/verify.sh` is the
   contract: a deliberately restricted YAML layout, Bash 3.2+, no YAML dependency, and
   a weekly GitHub Actions workflow (PR #314) that clones all three repos read-only.
   Forking code-recall would create a second source of truth competing with a green,
   already-merged pipeline. The right move is to *generalize the verifier we have*.

3. **We would inherit a large unrelated surface.** MCP server, session hooks,
   PreCompact snapshots, `consolidate`, `graduate`, `score`, skills, a Windows
   installer, two 40KB READMEs. None of it serves "memory with receipts," and all of
   it would be ours to maintain and to keep in sync with upstream.

4. **The gap is their stated non-goal, not a missing feature.** Their README is
   explicit (lines 128, 426): detecting that *code has drifted from a note* "needs
   semantic understanding (LLM/vectors), which is out of the zero-dep scope." They
   mitigate with *detection-by-proxy* — staleness flags, `doctor` lint, fail-loud
   parsing. We close it by *execution*: a claim carries a runnable check, and a check
   that fails demotes the claim to `failed`. That is an architectural difference in
   the lifecycle of a memory, not a module we could bolt on.

## What we adopt (conventions)

- In-repo plain files, no database, no daemon, zero runtime dependencies.
- Checksummed marker-wrapped instruction blocks, so an installer is idempotent and
  never disturbs surrounding user content (`<!-- gotcha-collector v1 ... checksum:… -->`).
- Idempotent multi-tool stub installation (`CLAUDE.md` / `AGENTS.md` / Cursor rules).
- A `doctor`-style lint posture: warn loudly about a malformed or stale fact table
  rather than failing silently.
- Treating transcript/ledger content as **untrusted data, never instructions**, and
  fencing it explicitly when it reaches a model.

## What we borrow as code (MIT, attributed in ATTRIBUTION.md)

- `SECRET_PATTERNS` + the line-dropping `sanitize()` strategy, including stateful PEM
  block handling — directly relevant to `harvest`, and better than anything we would
  have written from scratch on the first pass.
- `sha12()` + `writeFileAtomic()` + the marker upsert shape (`created` / `appended` /
  `rewritten`).

Both files carry an MIT attribution header. `LICENSE` here is MIT; `ATTRIBUTION.md`
records upstream copyright.

## Consequence for `gotcha verify`

To reproduce `verify.sh` outcome-for-outcome (acceptance test 1) we do **not**
reimplement its helpers in JavaScript — `code()` skipping comment lines, `has()`
substring matching, `orphans()`'s literal-path screen all carry subtle semantics whose
reimplementation would drift. Instead `gotcha` ships the same helper preamble and
evaluates each `check` in bash with `ROOT` and `HERE` bound, exactly as `verify.sh`
does. Node owns parsing, status transitions and reporting — the things bash cannot do;
bash keeps owning check execution — the thing it already does correctly.
