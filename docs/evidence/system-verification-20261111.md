# Morrow system verification, 2026-11-11

Author Ray Zhang

## Delivery scope

The implementation continues the original `a7c20cbb11d4073070b8d9dac4f310858d09da2e`
baseline. The latest committed base during these checks was
`547f2e4974c874ded464d7608573f89e2752be82`. The remaining delivery changes add
durable orchestration, its public export, the artifact-callback deadline
regression and the associated integration and evidence documents.

| Source | SHA-256 of tested working-file bytes |
| --- | --- |
| Harness `src/lib.rs` | `0554c25b4f54c5d63cbf1666defcef85a29edec8c197cec82e84d08626a3fd07` |
| Harness `src/orchestration.rs` | `695b80c05057348ccd5695fe8825f79357cd0f4dec22471765681c67dfafd13b` |
| Harness `tests/orchestration.rs` | `6929580b8e464a541acbd8ba74beb83007c70e04b387d9719acdcc771d0a948c` |
| Harness `tests/artifact_review.rs` | `b2df1e9566be984ee45f49443ecc7968ba8dcdf1a9191606890030024f9b646f` |

The final JSONL executable has SHA-256
`2305d82dcfa7397a9470a055e74f0bd6d6ba297b00448bbdfcfce29130926bb8`.
Its source includes the frozen orchestration implementation. Host example
production hashes match the [Host verification record](business-hosts-20261111.md).

## Final checks

Evidence is retained under
`C:/Users/loveu/AppData/Local/Temp/morrow-system-final-20261111`.

| Check | Result | Evidence |
| --- | --- | --- |
| Workspace rustfmt | Passed | `final-fmt.txt` |
| Workspace all-target clippy, locked/offline, `-j 2`, `-D warnings` | Passed, 55.61 s | `clippy.txt` |
| Workspace tests, compiled once and run serially from C | 51 programs, 507 passed, 0 failed, 4 ignored, 427.23 s | `build.jsonl`, `binaries.json`, `results.json`, `test-summary.json` and per-program logs |
| Added artifact deadline regression with complete affected target | 10 passed, 0 failed, 10.18 s | `artifact-deadline-tests.txt` |
| Added test target clippy | Passed | `artifact-deadline-clippy.txt` |
| Workspace doctests | Passed, 0 doctests in each of four packages | `doc-tests.txt` |
| Python original golden and artifact SDK tests | 22 passed, 25.647 s | `python-tests.txt` |
| Node artifact, client, resume and budget-reference tests | 40 passed, 0 skipped, 17.657 s | `node-tests.txt` |
| Original baseline Python SDK against final sidecar | 2 passed, 2.030 s | `legacy-python-tests.txt` |
| Original baseline Node SDK against final sidecar | 3 passed, 0 skipped, 2.415 s | `legacy-node-tests.txt` |
| Business Host tests against final sidecar and real local S3 | 8 passed, 0 skipped, 4.499 s | `host-controlled-tests.txt` |

The workspace run preceded the test-only deadline addition. The entire affected
artifact-review target and its clippy check were rerun after that addition.
Production source remained frozen. The counts above describe separate runs
and include overlapping regression cases.

Workspace tests used `cargo test --workspace --locked --offline -j 2 --no-run
--message-format=json`. Each emitted test program was copied to C and executed
with `--nocapture --test-threads=1`. TEMP, TMP and retained recovery fixtures
were on C. `binaries.json` records each executed file's SHA-256. A preliminary
build made before the last independent-review correction remains in the
`pre-review-build` files and was followed by a fresh final build.

The four default ignored cases are the native Job integration, one-time event
sample capture, public-network web tool acceptance and real vision-model
acceptance. The native Job case was separately enabled in the final
14/14 [orchestration run](orchestration-20261111.md). The other three remain
outside this goal's validation coverage.

## Real-model checks on the final executable

All three Hosts used the authorized CAS endpoint and `deepseek-v4.1-flash`, with
900-second Task deadlines and unchanged 60-second per-Run caps. The required
content was `Morrow business integration verified`, 36 UTF-8 bytes with SHA-256
`3d68a83fa34825a277833cccef818d36853d68803eff946bb5b9ae2354772dbe`.

| Host | Evidence directory | Elapsed | Host acceptance |
| --- | --- | --- | --- |
| Local file | `live-local` | 3.478 s | `accepted: true` |
| Model output | `live-model` | 2.238 s | `accepted: true` |
| S3-compatible object | `live-object` | 4.000 s | `accepted: true` |

The coordinator checked the outcome, review and business-proof hashes in each
acceptance receipt. The final S3 object used the authorized `host-final` prefix
in the isolated SeaweedFS test bucket. `live-host-results.json` and the three
Task roots retain the actual outputs and evidence. Credentials remained in
the process environment and private local files.

After all storage trials, the coordinator verified the test server's absolute
executable path and exact creation time, stopped its process and confirmed zero
remaining listeners. `storage-service-stop.json` retains that receipt. Test
data and evidence remain on disk.

Real-model recovery was additionally exercised with a durable file write
followed by Unknown settlement, and a real S3 PUT followed by an actual SDK
read timeout. Each continued the original Task from a fresh Host process after
explicit settlement, with one external write and cumulative Runs/calls of
1/3 to 2/4. The coordinator independently compared source receipts, Task
terms, resume budgets, external-write records, proxy requests and acceptance
hashes in `independent-recovery-audit.json` under the earlier Host evidence
root. The temporary recovery Host supplied settled-effect feedback. Historical
unknown artifact records remain available. Full mechanics and limits are in
the [Host recovery record](business-hosts-20261111.md).

## Goal coverage and remaining requirement

| Original stage | Evidence |
| --- | --- |
| Automatic ToolArtifact | [Journal artifacts](journal-artifacts-20261110.md) and [recovery](resume-artifacts-20261111.md) |
| Review paths and publication ordering | [Review artifacts](review-artifacts-20261111.md), the deadline test above and [reviewed continuation](reviewed-continuation-20261111.md) |
| JSONL, Python, Node and old clients | [Compatibility](jsonl-legacy-review-20261111.md) and final client runs above |
| Skill provenance | [Skill verification](skill-provenance-20261111.md) |
| Cross-Task provenance queries | [Scoped query verification](provenance-query-20261111.md) |
| Persistent orchestration | [Fourteen-case verification and limits](orchestration-20261111.md) |
| Business Hosts | [Examples and real results](business-hosts-20261111.md) |
| Real acceptance and publication | Final checks above, with actual power-loss acceptance pending |

Independent Codex reviewer `/root/morrow_diff_review` inspected the original
goal coverage, the frozen orchestration implementation, original logs and
selected stored outcomes. Its concrete implementation findings were fixed
and their regressions passed. The coordinator reviewed the Host implementation,
new deadline regression, integration instructions and final artifacts.

Actual power-loss recovery remains unverified. The user has been asked to
provide an isolated machine or VM that may be interrupted. Process exits,
service restarts, controlled persistent-state reconstruction and actual socket
timeout recovery have their own recorded coverage. The overall goal remains
open until the outstanding power-loss requirement is resolved.
