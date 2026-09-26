# Attribution

## code-recall (MIT)

Upstream: https://github.com/erikhuang76821/code-recall — © 2026 Code Recall authors,
MIT licensed. Evaluated at v2.15.0; see `DECISION.md` for why we adopted its
conventions instead of forking it.

Gotcha Collector is **not** a fork. It borrows two things as code, each marked in a
header comment at its use site:

| Ours | Borrowed from code-recall | Change |
|---|---|---|
| `lib/redact.js` | `SECRET_PATTERNS` and the line-dropping `sanitize()` strategy, including stateful PEM-block handling | Renamed to `scrub()`; added connection-string / Supabase / Stripe patterns and a `looksSecret()` egress assertion |
| `lib/util.js` | `writeFileAtomic()`, `sha12()` | Unchanged in substance |
| `lib/markers.js` | The checksummed marker-block upsert convention (`created`/`appended`/`rewritten`) | Reimplemented with our own marker strings; added an `unchanged` result so `install` is provably idempotent |

Conventions adopted without copying code: in-repo plain files, zero runtime
dependencies, idempotent multi-tool instruction stubs, `doctor`-style linting, and
treating stored/transcript content as untrusted data rather than instructions.

## repo-truth (the owner's own work)

`lib/verify-preamble.sh` is lifted **verbatim** from `repo-truth/verify.sh` in the
`user-dashboard` repository (merged in PR #314). It is reused rather than
reimplemented so that a check evaluated by `gotcha` and the same check evaluated by
`verify.sh` cannot diverge. `facts.yaml` remains that repo's file and its source of
truth; gotcha reads and writes it but never relocates or commits it.
