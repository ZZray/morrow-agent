# JSONL ordinary review compatibility

Author Ray Zhang

## Requirements

- R1. A version 1 start without artifact review retains the ordinary candidate
  and continuation wire shape covered by the existing start golden fixtures.
- R2. Harness evidence retains the Session identity used for ToolArtifact
  provenance. Artifact review opt-in carries that identity to the Host.
- R3. A large ordinary candidate uses the same wire projection as an inline
  candidate. Both its source and the referenced projection are checked across
  the callback. Source changes cause an explicit failure.
- R4. Legacy review replies preserve all original correlation fields. Budget
  and length snapshot callbacks retain their complete, file-backed basis.

## Design

ExternalHost clears `session_id` on the ordinary wire Candidate clone when
`artifact_review` is false. The field's existing skip-empty serialization
preserves the old format. A large candidate is saved to
`jsonl-candidate-N.json`, with a reference to those actual bytes. The original
`run-N-candidate.json` remains the Harness review source and is checked before
and after the callback.

The ordinary continuation projects both its previous candidate and receipt
basis. The Bridge persists the raw Host reply. Harness uses its existing
legacy receipt comparison, which accepts omission of Session identity while
requiring equality of every other basis field. A supplied wrong Session
identity is still rejected. No receipt is rewritten to assert a Host checked
fields absent from its request.

Artifact opt-in, budget snapshots and length snapshots use the complete
ReviewBasis and their existing reference files. Those opt-in protocols require
the Host to copy the received basis, including additional fields.

## Tasks

- [x] 1. Implement ordinary inline/reference/continuation projection. Requirements R1–R4.
- [x] 2. Run the original start golden cases with unchanged fixtures. Requirement R1.
- [x] 3. Exercise legacy inline, large reference, NeedsChanges and tampering through
  real sidecar processes and the Python/Node clients. Requirements R2–R4.
- [ ] 4. Run focused Rust/client checks and independent diff review, then commit
  and push with verification evidence. Requirements R1–R4.

The final source-archive checks and retained failures are recorded in
[the compatibility evidence](../evidence/jsonl-legacy-review-20261111.md).
