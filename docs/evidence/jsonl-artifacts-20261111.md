# JSONL artifact review integration

Author Ray Zhang

## Scope

Base commit `664000c4992cc8bd78d0453fa8c16a506e975b0e` in
`E:\repos\morrow-agent`. This increment adds opt-in artifact review to the Rust
JSONL sidecar and the Python and Node clients. `artifact_review` defaults to
false. The existing ReviewReceipt and terminal envelope remain in use.

Rust saves `jsonl-artifact-review-N.json`, emits its payload or a checked
reference, validates the correlated reply, and appends valid ToolArtifact
transitions. Both clients validate the original file before and after the Host
callback. They preserve operation receipts on cancellation or callback failure.
The artifact callback returns records through the existing 256 KiB frame bound.
Reference readers in both clients now allow up to 16 MiB.

## Delivered-image checks

The sidecar used in these checks is
`D:/workspace/env/cache/rust-target/debug/morrow-agent-jsonl.exe`.
Its SHA-256 is
`54d8660fb647fe34d40ce638f0cb90ce3820cfd2014aa91a367ac86087327c34`.
Providers are controlled loopback HTTP servers. Process checks execute the
actual Rust sidecar and write Host files and receipts.

| Check | Observed result |
| --- | --- |
| `cargo test -p morrow-agent-jsonl --lib --locked --offline` | 18 passed on the final Stage 3 Rust source. |
| `cargo fmt --all -- --check` | Passed. |
| `cargo clippy -p morrow-agent-jsonl --all-targets --locked --offline -- -D warnings` | Passed. |
| Python artifact review, length-stop review and client properties | 35 tests passed in the combined command. Its 19 budget tests failed setup because the caller omitted the required binary SHA environment variable. The command exited 1. |
| Python byte round-trip, protocol examples and resume callbacks | 11 passed. Includes Python and Node client processes. |
| Python budget snapshots with the required binary SHA configured | 19 passed in 97.536 seconds. |
| Node artifact review, client, resume and budget-reference suites | 39 passed, 0 skipped. Includes 10 actual-sidecar scenarios. |
| Python large `review_ref` process check | Passed with a 344245-byte original. The Host seeded 800 explicit fixture candidates, Rust derived one actual native candidate, and the Host published only that native artifact. |

Python process cases cover ordinary review, budget and length stops,
NeedsChanges with a second Run, old Hosts, cancellation, callback exceptions,
invalid references, cross-Run records, unsolicited callbacks and oversized
source references. Node covers the same main review paths plus malformed
requests and replies, source tampering, cancellation joining, frame bounds and
Session parent aliases.

## Failures retained

- Three start-frame golden cases differ from their old snapshots only by
  `candidate.basis.session_id`. `git log -S` and `git show a7c20cb` locate the
  addition in the baseline commit. The affected cases are `ok_text`,
  `ok_tool_then_text` and `tool_named_read`. The later ordinary-wire projection
  resolves the differences with the existing snapshots and equality assertions.
  Its implementation and final verification are recorded in
  [the compatibility increment](jsonl-legacy-review-20261111.md).
- The first large-reference test reached its final assertion and failed when
  comparing Windows extended and ordinary path strings. The assertion now
  uses `Path.samefile`; the subsequent execution passed. Both evidence
  directories were retained.
- A Node fixture reproduced a legitimate Session rejected through a Windows
  junction. The client now compares `fs.realpath` results and retains Windows
  extended-prefix normalization. Tests accept the original target and reject a
  different target. A subsequent ordinary sidecar check passed.
- The first combined Python regression command omitted
  `MORROW_JSONL_BUDGET_BINARY_SHA256`. All 19 budget tests stopped in setup.
  Their failures remain in the command log. The configured rerun is recorded
  separately.

## Evidence locations

- `D:/WorkSpace/tmp/morrow-artifact-python-20261111` contains the original
  Python process evidence, `compatibility.txt`, `rust-lib-final.txt`,
  `roundtrip-resume.txt`, `final-client-regression.txt` and
  `budget-regression-configured.txt`.
- `D:/WorkSpace/tmp/morrow-artifact-node-20261111` contains Node process
  identities, provider requests, Host receipts and Harness files.
  `D:/WorkSpace/tmp/morrow-artifact-node-final-20261111.txt` records the final
  39-test command.
- `D:/WorkSpace/tmp/morrow-artifact-ref-20261111` retains the initial large
  reference assertion failure and `large-review-ref-retest.txt`.
- `D:/WorkSpace/tmp/morrow-artifact-budget-20261111` contains the configured
  budget regression evidence.

## Review and remaining acceptance

Independent Codex reviewer `/root/morrow_diff_review` read the five Rust diffs
and the Bridge, transport, Harness publication and Core provenance paths. It
reported no blocking defect. `/root/core_scope_review` independently reviewed
the client diffs and identified the reference-size and Session-path differences
addressed in this increment. The final Python size-limit patch was authored by
that reviewer. The parent reviewed its bounded reads and boundary tests and
ran the affected artifact, budget, length-stop and client regression suites.
The Node junction patch and 16 MiB protocol description received a further
independent review from `/root/core_scope_review`, who also ran the alias test.

Golden compatibility is covered by the subsequent compatibility increment.
Actual business models, production Hosts, object storage and crashed
original-Run artifact recovery have separate goal-stage evidence.
