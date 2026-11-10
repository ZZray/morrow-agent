# Artifact review paths

Author Ray Zhang

## Scope

Base commit `99dc217463abe2b06b6fce73c25bffed9c1a573b` in
`E:\repos\morrow-agent`. This increment covers artifact publication in ordinary,
closed-budget, closed-length, feedback-continuation and resumed-Run reviews.

Harness stores callback evidence before validating returned references. It
rechecks Journal records, source proofs, events and cancellation before publishing
the applicable review index and accepted artifact manifest. Outcome references
are assigned last. A newly admitted Run clears the previous Run's references
from its outcome, while historical manifests remain on disk.

## Defect found by the review matrix

The first source-tampering test replaced `correct` with `corrupt` in a Journal
segment without changing its byte length. Review still published references.
`Journal.proof` could obtain both endpoints from the committed head without
reading record bytes. The existing head check only checked segment byte counts.

`Journal.verify_range` now reuses the streaming record visitor to validate hashes,
chain links and segment boundaries. Harness invokes it when checking review
basis. The same mutation test now stops at reconciliation, keeps callback
evidence and publishes no accepted manifest or outcome references.

## Execution evidence

| Command | Result |
| --- | --- |
| `cargo test -p morrow-agent-core --locked --offline --lib session_journal::tests` | 9 passed. Includes the new same-length corruption regression and existing segmented-history coverage. |
| `cargo test -p morrow-agent-harness --locked --offline` | All suites passed except the builtin exec timeout marker assertion in `unknown_effects_examples`. The full command exited 1. |
| Artifact review suite within that run | 9 tests passed, covering 42 path combinations. |
| Resume suite within that run | 7 tests passed. |
| `cargo test -p morrow-agent-harness --locked --offline --test unknown_effects_examples builtin_exec_timeout_is_unknown_through_structured_status_only -- --exact` | Unchanged focused rerun passed, 1 test. |
| `cargo test -p morrow-agent-harness --locked --offline --doc` | Passed with 0 examples. Run separately because the earlier suite failure stopped Cargo before doc tests. |
| `cargo fmt --all -- --check` | Passed. |
| `cargo clippy -p morrow-agent-core -p morrow-agent-harness --locked --offline --all-targets -- -D warnings` | Passed. |

The exec failure occurred after its unknown-effect and artifact assertions had
passed. Its marker-file line count was zero instead of one. The unchanged test
uses a one-second shell timeout. A concurrent build was running, but startup
latency has not been measured, so the cause remains unconfirmed. The focused
rerun does not erase the full-suite failure or establish that the test is stable.

Tool outputs are retained in Codex thread
`01a1c2fe-4a00-7763-88e0-05d6c43139d0`. The full Harness test session was
`84511`, and the focused exec rerun returned exit code 0 in chunk `6b1ba0`.

## Independent review

`/root/morrow_post_diff_review` reviewed the final production and test diff and
found no blocking issue in this stage's scope. It independently ran the new
same-length corruption test successfully. Its first short-name `--exact` filter
matched zero tests and was replaced by the full test name.

The main agent reread the publication path and the test assertions. Resume tests
check new-Run references, unchanged old evidence, retained cumulative budget and
no replay of the interrupted operation. Callback tests cover invalid records,
unknown and uncommitted receipts, cancellation, source changes and real filesystem
collisions at the index/manifest paths.

## Open acceptance

- A crashed original Run's Host-reconciled ToolResult remains in Journal and
  resume evidence. Automatic original-Run artifact backfill and restart-safe
  persistence are tracked in the recovery work.
- Cancellation tokens are tested directly. A separate deadline-expiry case has
  not been executed.
- Tests use controlled providers and local files. Real model tasks, business
  Hosts and cross-process artifact recovery remain outside this result.
- The intermittent exec marker failure remains an observed test limitation.

## Subsequent verification

The recovery implementation in `3b9b8ef` added restart-safe original-Run artifact
backfill. Its [verification record](resume-artifacts-20261111.md) retains the
older admission and missing-Session coverage boundaries.

The final delivery added a real Task deadline test across ordinary, budget and
length artifact callbacks. The Host waits for the original deadline's
cancellation token and returns Verified references after joining. The test
checks retained callback evidence and fence, an empty outcome artifact list,
and absence of accepted manifest/index publication. The complete artifact
review target passed 10/10 in 10.18 seconds. Its source SHA-256 is
`b2df1e9566be984ee45f49443ecc7968ba8dcdf1a9191606890030024f9b646f`.

The [system verification](system-verification-20261111.md) records the later
workspace and client regressions. Real-model business acceptance and actual
S3 read-timeout recovery are covered by the
[business Host record](business-hosts-20261111.md). Earlier failures above
remain part of the verification history.
