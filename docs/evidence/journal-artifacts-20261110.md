# Journal artifact delivery

Author Ray Zhang

## Version and scope

The change is based on `a7c20cbb11d4073070b8d9dac4f310858d09da2e` in
`E:\repos\morrow-agent`, branch `main`. The commit containing this record
delivers automatic Harness artifacts and Host confirmation of those candidates.

Harness derives candidate or unknown ToolArtifact records from the joined Run's
Journal range before invoking Host review. Reading uses 16-message pages and
retains pending pairs across pages. Host confirmation appends a validated status
transition for the same artifact ID. Partial persistence keeps written evidence,
preserves structured unknown effects and retains the reconciliation fence.

## Executed checks

| Command | Observed result |
| --- | --- |
| `cargo test --workspace --locked --offline` | All executed suites and doc tests passed, including MCP interruption properties. Existing ignored tests remained ignored. |
| `cargo test -p morrow-agent-harness --locked --offline --lib --test tasks --test artifact_review` | Final added regressions passed, 26 unit tests, 15 Task tests and 2 artifact-review tests. |
| `cargo fmt --all -- --check` | Passed on the final Rust changes. |
| `cargo clippy -p morrow-agent-harness --locked --offline --all-targets -- -D warnings` | Passed on the final Rust changes. |
| `git diff --check` | Passed. Git reported its existing LF-to-CRLF checkout policy. |

The workspace run preceded the last test-only and documentation additions.
The focused command above exercised those final additions. Execution output
is retained in Codex thread `01a1c2fe-4a00-7763-88e0-05d6c43139d0`.
The workspace process was collected through session `76104`.

An initial targeted command incorrectly supplied multiple Cargo filters and
was rejected before test execution. A later test build caught a local variable
shadowing the `candidate()` fixture. The variable was renamed and the final
focused tests passed. Neither failed invocation is counted as a passing test.

## Review and observed paths

Independent Codex reviewer `/root/morrow_post_diff_review` found three initial
issues. Same-ID candidate confirmation was rejected, artifact persistence failure
skipped unknown-effect collection, and whole-Run reads imposed a new 64 MiB limit.
All three were corrected. The reviewer reread the changes, ran focused tests and
approved the final increment for a scoped commit.

Executed tests cover automatic candidate confirmation through Host review,
multiple calls, known tool errors, structured unknown effects, cancellation,
builtin exec timeout, cross-page pairing, actual two-Run feedback continuation,
partial append failure, rejected pending-call duplicates and tool-name mismatch.
The combined cancellation and filesystem-collision test checks final persisted
unknown effects, retained fence and a single tool execution.

## Remaining acceptance

This stage uses controlled providers and local temporary files. Real-model
acceptance, the full artifact review matrix for budget/length/resume, cross-process
artifact resume, Python/Node integration, Skill hash integration, cross-Task
queries, persistent orchestration and business Host examples remain open.
An entire Run larger than 64 MiB has not been executed.

Legacy unique-ID artifact files remain readable. Older Harness readers that
reject duplicate IDs require an upgrade to read appended status transitions.
The record and receipt checks do not establish integrity against an internally
consistent rewrite of every record. Host storage access control remains required.
