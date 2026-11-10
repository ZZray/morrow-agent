# Skill library provenance

Author Ray Zhang

## Scope

Base commit `18eafe996505410612ffcc2dccca7bbaf0fc468a` in
`E:\repos\morrow-agent`.

Core exposes an owned Skill verification snapshot using the existing bundle
scanner, metadata format and library lock. It preserves the stored verification
hash when the current content has changed. Successful native execution remains
the meaning of `skill_verify` metadata.

Harness joins that snapshot to the actual successful `skill_verify` call and
its prior native execution receipts in the ReviewBasis Journal range. It
checks Host-confirmed source ToolArtifacts and every SkillValidationReceipt
before persisting the Skill provenance. The optional library binding stores
scope, installation identity, verification call ID and the native evidence
digest. Existing records without a library binding remain readable through the
historical APIs.

Historical queries return the latest valid state, including revocations.
Current-availability queries also validate bundle bytes, installation identity,
native evidence and current source artifacts. Task and Session are required
filters, with optional Skill, hash, Run, source artifact, scope and bundle ID.

## Verification

| Check | Result |
| --- | --- |
| Core `skill_library` unit tests | 16 passed after the shared-read lock change. |
| Core `artifact_provenance` unit tests | 3 passed, run by the parent. |
| Harness `skill_provenance` integration tests | 6 passed in the author's final targeted run. |
| Harness provenance unit tests | 3 passed. |
| Parent's full Harness test command | 104 tests passed across 17 reported suites, including the zero-test doc suite. The final test-only retention change is included. |
| Core library Clippy | Passed without warnings. |
| Harness all-target Clippy with `-D warnings` | Passed. |
| Final workspace formatting and Harness all-target Clippy | Passed after the evidence retention change. |

The integration fixture uses normal `start` and `execute` entry points with
local tools enabled. A controlled provider asks for `skill_create`, a real OS
`exec` that reads the created resource, and `skill_verify`. The Host inspects
the actual file, verifies the source artifact and registers the Skill.
Another case groups exec and verification in one assistant message.

The restart check launches a fresh copy of the test executable, resolves the
library from disk and checks the persisted provenance. The concurrency case
starts eight readers, each making twenty historical and current-availability
queries. Lock tests separately prove that readers exclude mutation and that a
writer excludes readers.

Negative cases cover a changed bundle, replacement installation ID, changed
native output hash or tool name, foreign Task/Session/Run filters, invalid
verification call ID, source revocation, duplicate/reversed Skill transitions,
and an invalid binding in the second validation receipt. Scope filtering is
tested with an explicitly constructed global record. Actual tool execution in
this increment uses the project library.

## Failures and corrections

The first Harness integration execution passed four tests and failed the
concurrent-reader case. A focused run exposed Windows lock error 33. The new
Core snapshot had reused the existing exclusive library lock. It now acquires
a shared lock, while mutation retains the exclusive lock. The original
concurrency assertions then passed. Failure outputs are retained in this chat
as chunks `525ce6` and `5cd0c4`; the author's passing targeted run is `492f3a`.

Source review also found that a verification call may share an assistant
message with an earlier completed exec. Registration now validates native
receipt evidence against the Journal prefix before the verification result.
The grouped-tools integration test exercises that path.

The production metadata receipt contains five fields. The public snapshot
uses that existing shape, including the text-output digest. Registration
separately checks the typed ToolResult digest through the Journal-derived
artifact.

## Review and evidence

Independent Codex reviewer `/root/core_scope_review` reviewed the final Core and
Harness diffs, tests, source-state handling and lock order. It reported no
remaining blocking defect after the shared-read change. The parent separately
read the registration, query and persistence paths and ran the Core provenance
tests and full Harness regression. It also checked the retained ordinary
fixture's actual resource, metadata verification hash, installation identity,
Run identity and manifest source IDs against the persisted Skill record.

`D:/WorkSpace/tmp/morrow-skill-core-provenance-20261111.txt` records the parent's
Core check. The final Harness run uses `MORROW_SKILL_EVIDENCE` to retain each
fixture under `D:/WorkSpace/tmp/morrow-skill-provenance-20261111`, including
Journal, operation receipts, Skill metadata and provenance files. Its output
is `D:/WorkSpace/tmp/morrow-skill-harness-final-20261111.txt`.

The controlled provider supplies deterministic model responses. A real model,
production Host, global Skill installation and business Task acceptance remain
outside this increment's runtime evidence.
