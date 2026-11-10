# JSONL default review compatibility

Author Ray Zhang

## Delivered source

The candidate source is `745811a9fa68937753bbdd788c0d735854941e7d` plus this
increment's JSONL runtime, Python/Node tests and documentation. A temporary
source archive contains those exact files and the committed dependencies.
It was built independently of the in-progress Harness recovery work.

The final sidecar SHA-256 is
`616676825287ca0e117e0a13a251e68f542e7903f82e6814b5458527d4a03494`.
The archive, overlay hashes, build output and binary are under
`D:/WorkSpace/tmp/morrow-jsonl-legacy-20261111`.

Ordinary review without artifact opt-in now projects the original v1 basis.
Harness keeps the full Session-bound source. Large legacy candidates use a
separate checked `jsonl-candidate-N.json`. Ordinary continuation projects both
bases consistently. The original Host receipt is retained. Artifact opt-in,
budget and length callbacks continue using their complete basis.

## Final checks

| Check | Result |
| --- | --- |
| Source archive `cargo fmt --all -- --check` | Passed |
| JSONL all-target clippy, locked/offline, `-D warnings` | Passed |
| JSONL library tests | 18 passed |
| Python `test_start_golden` and `test_artifact_review` | 22 tests passed in 25.372 s, including all 22 original golden cases |
| Node artifact, client, resume and budget-reference suites | 40 passed, no skips, in 13.382 s |
| Original Python client from `a7c20cb` | 2 real-sidecar cases passed in 1.990 s |
| Original Node client from `a7c20cb` | 3 real-sidecar cases passed in 2.385 s |

Final process evidence is under
`C:/Users/loveu/AppData/Local/Temp/morrow-jsonl-final-20261111`. Each artifact
process fixture records the executable hash, input, Host operations and Harness
files. Tests use a controlled HTTP provider and real Rust sidecar processes.
They exercise actual file writes, ordinary and opt-in review, NeedsChanges,
large references, source tampering, cancellation and error handling.

The original SDK sources were extracted directly from
`a7c20cbb11d4073070b8d9dac4f310858d09da2e`. Their source paths and hashes are
recorded in `legacy-sdk/identity.json` under the D-drive evidence directory.
Old-client trials cover omitted and false artifact settings, large candidate
references and feedback continuation. The existing golden files and their
equality assertions have no changes.

## Retained failures and corrections

- The initial unchanged golden run reproduced three additional-Session-field
  failures. The production boundary projection fixes that regression.
- The first new large-candidate fixture used plain text beyond Core's 128 KiB
  output cap, so it stayed below the wire limit after truncation. The corrected
  fixture uses escaped backslashes to cross the JSON frame limit within that
  text cap. A mistaken RPC filename glob was also corrected.
- The first tampering assertion expected a client exception. The actual API
  can deliver a valid `ReconciliationRequired` outcome. The test now requires
  that original failed outcome, retained fence and empty accepted artifacts.
- Initial D-drive runs retained deadline failures and a Node cancellation test
  timeout. The source-archive Python run had four failures in 291.054 s. A disk
  observation during that run showed a D-drive queue length of four and a
  C-drive queue length of zero. Final trials used the same binary, assertions
  and original 30-second Task deadlines, with C-drive evidence and sequential
  execution. The full final commands passed. The D-drive failures remain in
  `python-final.txt`, `node-final.txt` and `delivery-python.txt`.
- Reusing the shared Cargo target for the temporary source archive exposed a
  stale Harness export during a subsequent main-checkout build. That failure
  belongs to the parallel continuation record. The final JSONL binary above
  was copied and hashed before the main-checkout rebuild. Future archive builds
  use the separate local target to avoid that cache collision.

## Review and remaining acceptance

Independent Codex reviewer `/root/core_scope_review` read the implementation,
protocol, design and test changes and reported no blocking finding. It checked
source and projection verification, dual continuation projection and unchanged golden
assertions. The parent inspected the implementation and final process results.

These trials establish the recorded local transport and Host-file behavior.
Real business models, production Hosts, object storage and the final system
release remain later goal stages.
