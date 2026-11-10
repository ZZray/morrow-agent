# Authorization snapshot

## Scope

The Harness already computes an authority declaration before it admits a Task. The declaration is hashed into the Session fence, which lets `resume` reject a changed model route, tool registry, path set or policy. The Host also needs a readable record of the admitted values.

Each admission now writes `authorization-snapshot.json` in its evidence directory. The file contains the Task and revision identifiers, a Host-readable authority projection, the projection digest, and the digest of the complete declaration used by the fence. Context record text is omitted. Lease payloads are represented by hashes. The model credential is represented by the existing token hash.

## Lifecycle

- `start` creates the snapshot before the Run starts.
- `resume` validates an existing snapshot when one is present. Its Task identifiers and complete-declaration digest must match the fence. Older fences without this file continue through the existing checks.
- A successful resume writes a new snapshot in the new evidence directory.

The resume snapshot is prepared before the new fence is taken over. A disk failure leaves the old fence in place, so the reconciliation callback remains tied to the original owner.

The snapshot is written with the existing create-new evidence writer. A write or validation failure leaves the fence in place and requires the existing reconciliation path.

## Acceptance

1. A valid snapshot round-trips through JSON and its digest matches the declaration bytes.
2. Editing the declaration without updating the digest is rejected.
3. A resumed Task refuses a present snapshot whose identity or digest does not match the fence.
4. Existing `TaskSpec` and `RunRequest` constructors remain source-compatible.
5. The Harness unit and integration tests pass on the delivered code.

This feature records admission provenance. Authority grants, tool sandboxing, external-effect settlement and business Task acceptance remain Host responsibilities.
