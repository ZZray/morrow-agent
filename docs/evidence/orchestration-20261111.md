# Persistent orchestration evidence, 2026-11-11

Author Ray Zhang

## Delivered source under review

The local Host queue persists Trigger, Mandate, Assignment, Task and Session
identities, dispatch attempts, native Run admissions and managed Job references.
It dispatches through the existing Harness `start_with_options`,
`resume_checked` and `continue_reviewed` entry points. The Host reconstructs
RunRequest and supplies credentials and callback implementations in memory.

The implementation adds `src/orchestration.rs`, its integration tests and one
`pub mod orchestration` declaration in the Harness.

Validation used base commit `547f2e4974c874ded464d7608573f89e2752be82` plus
the files frozen for independent review in this table.

| File | SHA256 |
| --- | --- |
| `crates/morrow-agent-harness/src/orchestration.rs` | `695B80C05057348CCD5695FE8825F79357CD0F4DEC22471765681C67DFAFD13B` |
| `crates/morrow-agent-harness/tests/orchestration.rs` | `6929580B8E464A541ACBD8BA74BEB83007C70E04B387D9719ACDCC771D0A948C` |

The final delivery commit and broader workspace regression are recorded by
the coordinating reviewer after this file is written.

## Checks and retained artifacts

The frozen source passed these Cargo checks.

```powershell
cargo test -p morrow-agent-harness --locked --offline --test orchestration --no-run
cargo clippy -p morrow-agent-harness --locked --offline --lib --test orchestration -- -D warnings
```

Both commands passed on the frozen source. The executable was copied to C:
and run serially with TEMP, TMP and fixture evidence on C:. The native Job
case used an existing compatible `business_host.exe` that implements
`managed_jobs::worker_entry_from_args`.

```powershell
$env:MORROW_ORCHESTRATION_EVIDENCE = '<retained evidence directory>'
$env:MORROW_ORCHESTRATION_JOB_WORKER = '<compatible business_host executable>'
orchestration.exe --include-ignored --test-threads=1 --nocapture
```

The final run reported **14 passed, 0 failed, 0 ignored**. One counted test is the
child-process entry fixture. The native Job test is ignored in an ordinary
test invocation because it requires an explicitly configured compatible
worker. It was explicitly enabled and passed here.

The local evidence is retained under
`C:\Users\loveu\AppData\Local\Temp\morrow-orchestration-20261111-a`.

| Artifact | Location or SHA256 |
| --- | --- |
| Final test output | `final-review-tests.log` |
| Retained final fixtures | `final-review-evidence/`, with each fixture path printed in the log |
| Executed test binary | `orchestration.exe` |
| Executed binary SHA256 | `E2CB54A503D5757624535E48063EF122C6517A3D876BE20A41525B0FCFA2DADD` |

## Exercised behavior

| Boundary | Executable observation |
| --- | --- |
| Idempotent enqueue | Identical IDs/content return the original assignment, including after its deadline. Changed content and a new expired assignment fail. |
| Store restart | Reopen preserves committed identities and event cursors. A child process leaves an unpublished staged file. The committed snapshot remains readable and the staged evidence remains present. |
| Competing ownership | A child owns the assignment OS lock. Lease expiry records cancellation/recovery. Another process cannot claim recovery until the owner exits. |
| Native Harness dispatch | A real registered file tool writes `answer.txt`. The joined Harness outcome and native Run admission references are persisted. Dropping the observer leaves supervision active. |
| Lock contention | A real store lock is held across cancellation polls and a heartbeat interval. Typed `StoreBusy` leaves the native operation running. A subsequent explicit cancellation joins the original callback. |
| Intent published before admission | A child exits after publishing dispatch intent and before polling Harness setup. A committed Host NeverAdmitted receipt permits retry of the same attempt/Run/evidence. |
| Released result before queue settlement | A child runs Harness to release and exits before queue settlement. Recovery harvests original released bytes without model/tool dispatch. |
| Interrupted external effect | A real tool fsyncs one external file and exits its process. Checked resume reconciles the original open call, preserves the file and does not replay the tool. |
| Repeated resume admission failures | Two deliberately failed Host reconciliation callbacks retain the original fence source. A third checked resume succeeds, with four queue attempts and only two actual model requests overall. |
| Cancellation before resume admission | A cancellation arriving after the new intent but before supervisor setup leaves the original unknown effects in recovery-required, with the original fence unchanged. |
| Repeated continuation admission failures | Two bad released-result hashes consume no model calls. Recovery harvests the actual earlier release and a subsequent reviewed continuation keeps the original Task/Session and cumulative budgets. |
| Prepared continuation before fence publication | A child publishes the exact Continue intent and exits. A controlled fixture reconstructs the native prepared claim/files at the pre-fence boundary. Harvest refuses to skip this claim. A competing new Continue is rejected before appending an attempt. A reopened Store retries the same original intent through native claim equality checks, adds no replacement attempt, and reaches cumulative 2 Runs/4 calls. |
| Watchdog cancellation | A real delayed callback observes cancellation. A competitor cannot acquire worker ownership until callback settlement and TaskHandle join complete. |
| Native managed Job | A genuine Goal lease exposes native `job_start`. A separate worker writes `job-effect.txt`. Queue observation verifies Session owner/nonce, original Run admission and the matching job_start/result events. A wrong Run or device is rejected. The Job reference survives Store reopen. |

The native Job reaches `succeeded` with `effects_unknown=false`. Its Harness
Task remains `GoalWaiting` with a present fence and queue recovery-required.
Observing a successful Job does not settle or accept the Task.

## Review corrections and original failures

Independent reviewer `/root/morrow_post_diff_review` found that a Job
reference originally trusted the supplied Run ID without proving that Run's
invocation. The implementation now checks the actual admission and scoped
tool events. Native Job requests and Manager status bind the worker nonce;
the model-visible tool output intentionally omits that nonce.

Independent reviewer `/root/morrow_diff_review` found deadline validation
before idempotent enqueue lookup, and the missing exact retry for a prepared
Continue intent. Both were corrected and exercised in the final run. The
reviewer's follow-up found that a new Continue could obscure an older prepared
intent before native claim rejection. Dispatch now checks for pending claims
before appending a new Continue. The regression checks that the original
intent remains available for exact retry. The reviewer recalculated the final
source/test hashes and directly checked the 14/14 log plus prepared-claim,
failed-resume, failed-continuation and native-Job records. The final independent
review reported no remaining source blocker. The coordinator performs the
delivery review and broader workspace regression.

Earlier unsuccessful runs remain under the same local evidence root:

- `native-job.log`: the first test tried to register the reserved native tool
  name as a custom tool. Core rejected it before any Job dispatch. The test
  now uses an actual Goal lease and native tool registration.
- `native-job-b.log`: receipt decoding incorrectly required worker_nonce in
  model-visible output. Source inspection confirmed its deliberate removal;
  nonce verification now uses the native request and Manager status.
- `review-tests.log`: 12 passed and 2 failed. The prepared-state fixture
  attempted Windows sync_all through a read-only handle. It now opens the
  file for writing. The deliberate reconciliation failure assertion also
  exposed lost error context. DispatchReport now preserves the error chain.

The production budgets were not enlarged, and failed records were retained.

## Operating limits and remaining acceptance

The store supports at most **1024 assignments**, **32768 events** and **32 MiB**
of serialized state. Capacity errors are observable
as `assignment capacity reached`, `orchestration event capacity reached` or
`orchestration snapshot exceeds bound`. No archive or cleanup API is supplied.
At capacity, publication fails and the prior committed snapshot remains the
recovery source. A Harness result can already exist independently of a failed
queue settlement publication.

Store operations use nonblocking file locks. A Host can distinguish
`StoreBusy` from I/O or corruption errors, wait for contention to clear and
inspect current state before retrying an operation. Supervisor polling and
heartbeats skip normal contention while retaining worker ownership. Other
persistence errors request cancellation and still join admitted execution.
Heartbeats update the snapshot without appending events. Snapshot rewrite
cost grows with retained history.

The Host must keep its Tokio runtime alive while supervisors settle. The
store assumes stable Host-owned paths and local advisory-lock semantics.
Shared network filesystem behavior, multi-machine coordination, power-loss
durability and long-running capacity/performance have not been accepted.
Windows parent-directory synchronization follows the existing Harness
storage contract.

Job Run identity means the Run that invoked job_start and obtained its Job
receipt. Native op_id retries can return an existing Job. The native protocol
does not prove its first creating Run. Observation requires usable original
admission and tool-event evidence. It fails explicitly if that evidence is
missing, malformed, oversized or the tool arguments were truncated in the
bounded event stream. Credential values and command bodies are not copied
into queue state. The Host owns the contents of supplied identity/reference
strings and evidence files.

The suite uses a controlled HTTP provider with the actual Rust Agent loop,
Harness callbacks, files, processes and native Job worker. The pre-fence
prepared-claim boundary is a reconstructed persistent-state fixture.
Real-model business Host trials have their own
[verification record](business-hosts-20261111.md). Product UI integration and
remote production object stores are outside this suite's coverage.
