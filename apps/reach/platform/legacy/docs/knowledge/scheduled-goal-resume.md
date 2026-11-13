# One-time paused-Goal appointments

2026-10-16. The calendar is a Hub responsibility; native Goal execution, root
budgets, Jobs and acceptance remain Rust Node responsibilities. The initial
calendar operation resumes one existing paused Goal at one UTC instant. It does
not create a future prompt, repeat daily, extend a lease, pair a device, or
silently repair an owner after transport reconnection.

Admission captures the authenticated controller, device, native Session, Goal,
revision, writer epoch, original Node connection and time. Due time must precede
both the original Goal lease and device approval expiry. Triggering rechecks all
of these plus paused status and remaining root budget. Calendar cancellation
affects only not-yet-dispatched appointments, not an already running Goal.

The Hub durably writes dispatch intent before reserving the stable command ID
in the existing Goal command book and sending `resume`. A native command
receipt confirms resume, never overall task completion. Dispatch timeout and
restart retain unknown effects without replay. Past due appointments on Hub
startup are missed, not caught up. Writer replacement or revoked authority
fails visibly. Manual Goal command retries retain their previous semantics.

The bounded store retains 64 records, including terminal evidence, with a
128 KiB limit. History is not silently discarded; reaching capacity rejects a
new appointment. Persistent archival/deletion, recurrent tasks and trusted
future-start admission are outside this slice. The UI exposes explicit refresh
for authoritative status and scopes displayed items to the selected Session
and device. `schedule-resume-v1` gates use against older Hubs.

Sources: `schedule_book.go`, `long_tasks.go`, `connect_approved.go`; executable
evidence belongs in the [delivery record](https://gitee.com/rzjw/llm-im/blob/0b9cb7c3eabf1e4d82bfc1d6147786c2d883721c/docs/evidence/handwave-ui-goals-20261016.md).
