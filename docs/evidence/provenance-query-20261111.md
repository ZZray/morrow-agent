# Cross-Task provenance queries

Author Ray Zhang

## Scope

Base commit `70f5b8fa40b9be5c1003cbbbab9c33c81575cd4d` in
`E:\repos\morrow-agent`.

The public `query_provenance` API receives explicit Host-authorized
Task/Session/evidence scopes and a typed filter. It reads the two fixed
provenance ledgers under each directory's shared lock, checks identity and
legal transitions, validates every Skill source binding, and reports matching
records with the actual ledger-byte SHA-256 values.

Filters cover Task, Session, Run, artifact, Skill, bundle hash, receipt, kind,
status and half-open time ranges. Time parsing reuses Core's existing chrono
dependency for RFC3339 and accepts native Unix-millisecond strings. Opaque
historical timestamps remain readable without a time filter.

## Verification

| Check | Result |
| --- | --- |
| `cargo test -p morrow-agent-harness --test provenance_query --locked --offline -- --nocapture` | 10 passed in the parent's final run. |
| `cargo fmt --all -- --check` | Passed. |
| `cargo clippy -p morrow-agent-harness --all-targets --locked --offline -- -D warnings` | Passed. |

Tests use explicit fixture ledgers and cover cross-Task filtering, each query
dimension, actual file hashes, legal revocation, candidate and unknown records,
missing or inconsistent sources, independent scope errors, duplicate paths,
Windows junction aliases, wrong identities, time formats and eight concurrent
readers. A held writer produces a Busy scope result while another scope
continues.

The restart test launches a fresh test process. The child rereads the original
ledgers, checks their actual hashes and writes its report. The parent requires
successful exit, the child marker and exact report equality. The final retained
fixture is
`D:/WorkSpace/tmp/morrow-provenance-query-final-20261111/query-restart-UwtZ1T`.
It contains executable identity, request, result, original ledgers and child
stdout/stderr. The full command output is
`D:/WorkSpace/tmp/morrow-provenance-query-final-20261111.txt`.

## Review corrections

Independent Codex reviewer `/root/core_scope_review` identified three issues
during source review. The implementation and regression cases now cover each.

- Repeated or aliased scopes are deduplicated by canonical directory after a
  successful read. Conflicting identities produce an explicit error.
- Skill source validation runs before record and time filtering, so filters
  cannot hide a missing or inconsistent source.
- A failed scope cannot reserve a deduplication entry and suppress a later
  valid scope for the same directory.

The reviewer subsequently read the fresh-process test and lock-error
classification and reported no remaining blocking defect. The parent separately
read the parser, shared-lock integration and fresh-process assertions and ran
the final checks above.

## Acceptance boundary

Results describe historical records and their receipt bindings. Ledger hashes
describe the observed bytes. Actual business content and current Skill library
availability have separate Host checks. Business Task acceptance remains with
the Host. This increment uses fixture records and real filesystem/process
operations; production Host and real-model acceptance remain later goal work.
