# Persistent Host task orchestration

Author Ray Zhang

## Requirements

- R1. Persist Trigger, Mandate, Assignment, Task, Session, Run and Job identities
  so a Host can find the original work and receipts after process restart.
- R2. Queue authorized assignments, claim them in order, request cancellation,
  and continue reviewed Tasks within their original cumulative budgets.
- R3. Persist worker lease ownership and dispatch intent. A watchdog identifies
  expired ownership and routes the assignment through checked recovery.
- R4. Recover observable state and events across crashes. Resolve original
  tool and callback effects before authorizing any further execution.
- R5. Keep business identity, authorization, model credentials, storage location
  and acceptance under Host control. Reuse the existing Harness execution and
  Core managed Job contracts.

## Existing entry points

`task_set::TaskSet` starts an in-memory batch through `start_with_options`,
routes explicit guidance to the original steering buffer, and joins completed
Task handles. Its identities and message deduplication live for that batch.

Harness `resume_checked` acquires the Session lock and checks the original
fence, authority, consumption and Host settlement before continuing. The
reviewed-continuation implementation extends that lifecycle to released Tasks.
Core `managed_jobs` already owns native background Job execution and receipts.

## Identity and authorization

An assignment stores a stable ID, its source Trigger, the authorizing Mandate,
the original TaskSpec, Session identity and authorized execution configuration
digest. Trigger and Mandate records carry Host references and revisions.
Credentials and callback implementations are supplied by the running Host.

The same assignment ID and identical content return the original record.
Reusing an ID with changed content fails. Each dispatch attempt adds its own
Run ID, evidence directory and source attempt reference. A managed Job record
links the original Task/Run to the native Job ID and its existing receipt.
Business acceptance remains an explicit Host action.

## Persistence and execution

The initial local store uses the existing serde and fs2 dependencies. Each
mutation takes a store lock, loads the current revision, validates the requested
transition, writes a complete staged record and synchronizes it before atomic
publication. Committed transitions have monotonic event sequence numbers.
Readers can request events after a saved cursor. Recovery reads the committed
state, with unpublished staged writes retained as diagnostic evidence.

Assignments progress through queued, claimed, dispatching, running,
recovery-required and settled states. Cancellation is a separate durable
request while execution or settlement remains outstanding. Cancellation of a
queued assignment can settle immediately because no dispatch was admitted.

Claiming records a worker identity, generation token and lease deadline.
Heartbeat and worker updates must match the current token. The supervisor
holds assignment ownership until the Harness handle has joined. Dropping an
observer future leaves supervision and cancellation delivery available.

Before invoking Harness, persist dispatch intent with the exact Task, Session,
Run and evidence directory. The adapter reconstructs RunRequest from the
Host-authorized configuration and uses `start_with_options`, `resume_checked`
or `continue_reviewed` according to the recorded lifecycle. It saves the joined
outcome and evidence references before settling the queue record.

## Watchdog and recovery

An expired lease records recovery-required and a cancellation request. Recovery
must acquire worker ownership and the original Session ownership, then inspect
dispatch intent, fence, outcome, released result and native Job receipts.

- A live owner retains responsibility for joining its Run and callbacks.
- An admitted interrupted Run enters Harness settlement and checked resume.
- A released result is harvested from its original evidence.
- A released reviewed Task continues through its single-use successor claim.
- An ambiguous dispatch or unknown external result stays available for Host
  reconciliation, with original receipt locations in the status response.

Events report these decisions and their evidence references. Lease expiry is
an observation about ownership freshness. Host settlement determines the
known external effects available to recovery.

## Implementation tasks

- [x] 1. Implement the durable identity store, revision checks, idempotent enqueue
  and event cursor reads. Test reopen, conflicting IDs and interrupted writes.
  Requirements R1, R4, R5.
- [x] 2. Implement claim, heartbeat, cancellation and watchdog transitions.
  Test competing processes, stale tokens and expiry while a worker is alive.
  Requirements R2, R3, R4.
- [x] 3. Connect dispatch and join to real Harness entry points. Test a real
  business file tool, callback cancellation and observer detachment.
  Requirements R2, R3, R5.
- [x] 4. Complete reviewed continuation with persistent authority, cumulative
  consumption and single-successor claims. Test fresh-process continuation and
  continuation followed by crashed-process resume. Requirements R2, R4.
- [x] 5. Connect checked recovery and existing managed Job receipts. Test
  persisted queue intent before admission, tool effects before process exit,
  released Harness results before queue publication and prepared continuation
  claims before fencing. Preserve unknown effects for Host reconciliation.
  Requirements R1, R3, R4, R5.
- [x] 6. Run applicable regression tests and independent diff review, publish
  runnable Host examples and record exact commits and evidence. Requirements R1–R5.

## Capacity and recovery boundaries

The initial store accepts at most 1024 assignments, 32768 events and a 32 MiB
serialized snapshot. Capacity errors preserve the prior committed state.
Event trimming and assignment removal are currently unavailable. Store lock
contention is reported as `StoreBusy`; the supervisor keeps the live Harness
worker joined while brief contention clears.

Repeated admission failures retain the original fence and evidence chain.
An exact prepared continuation can retry its original durable intent after
the successor claim was written and before its Session fence was published.
The Host supplies a committed recovery receipt. Harvesting checks pending
successor claims before accepting an earlier released result.

## Current verification boundary

The frozen implementation passed all 14 orchestration tests, including the
separately enabled native Job worker case. The tests cover process ownership,
real file effects, continued Tasks, repeated failed admissions, contention and
event replay. The prepared-claim, pre-fence state is reconstructed in a controlled
fixture. A child-process exit separately covers persisted queue intent before
admission. The native Job completed
its file effect while its Task remained `GoalWaiting` with a fence and queue
recovery required. Job success retains that distinct Task state.

Final workspace regression and independent review passed on the frozen source.
The [system verification](../evidence/system-verification-20261111.md) records
the exact test programs, source hashes and remaining acceptance.
The [business Host verification](../evidence/business-hosts-20261111.md) records
real-model and local S3 trials. Physical power-loss recovery requires its own
test environment and remains unverified.
