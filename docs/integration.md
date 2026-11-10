# Business integration

Morrow is consumed through a host boundary. The host creates the workspace and
state paths, checks authorization, supplies the model route and credentials,
registers business tools, and decides whether the resulting work is accepted.

## Rust host

Use `morrow-agent-core` for a single Run. Use `morrow-agent-harness` when the
host needs candidate review, feedback continuation, cumulative budgets, or
cross-process Session ownership.

```toml
[dependencies]
morrow-agent-core = { git = "https://github.com/ZZray/morrow-agent.git", rev = "PINNED_COMMIT" }
morrow-agent-harness = { git = "https://github.com/ZZray/morrow-agent.git", rev = "PINNED_COMMIT" }
```

Pin a commit in the consuming product and verify the package name, source, and
lockfile entry with `cargo metadata`.

### Skill verification

`core::skill_library::read_verification(&roots, scope, name)` returns the current
owned bundle hash and its saved native execution evidence. The existing
`skill_verify` tool records that execution association.

After checking the business result and confirming the source ToolArtifacts,
the Host can call `record_skill_verification` with the evidence directory,
ReviewBasis, library Roots, scope, Skill name, native `skill_verify` call ID and
its SkillValidationReceipts. Harness checks the actual Journal calls, results
and bundle before persisting the association. The library binding retains the
installation ID and native evidence digest.

`query_skill_provenance` filters historical records by Task, Session, Skill,
bundle hash, Run, source artifact and library identity. It includes legal
revocations. `verified_skill_provenance` also reads the current library bundle
and checks its source artifacts. A changed bundle, replacement installation,
changed native evidence or revoked source causes that availability check to fail.
Hosts continue to decide business Task acceptance.

## JSONL host

Python and Node hosts can launch `morrow-agent-jsonl` as a sidecar. The model
credential is passed through `MORROW_AGENT_MODEL_TOKEN`. The sidecar does not
create a new Session or replay an operation after a disconnect. The host reads
the original outcome, journal, fence, and business receipt before deciding how
to recover.

The JSONL protocol is documented in
[`crates/morrow-agent-jsonl/docs/protocol-v1.md`](../crates/morrow-agent-jsonl/docs/protocol-v1.md).

Set `artifact_review: true` in the start frame to review structured tool
artifacts. Python hosts implement `review_artifacts(review, cancelled)`. Node
hosts implement `reviewArtifacts(review, { signal, frame })`. The payload carries
the current review basis and its candidate ToolArtifact records. The callback
returns records with Host receipts after checking the actual business output.
Rust validates and persists those records. Accepted references are available in
the original outcome's `artifacts` array. Hosts that omit the option continue
using the existing review callbacks.

## MCP host

`morrow-agent-mcp` reads the Claude Code `.mcp.json` shape for stdio and
Streamable HTTP servers. The host decides which servers are allowed and which
tools can run in a Plan or Execute request. Unsupported transports and
extension requests return structured errors.

## Compatibility identifiers

The `.handwave/skills` path, `handwave-knowledge-v1`, and the fixed `rpi-ai` /
`rpi-agent` revision remain format or upstream identifiers. They are kept so
existing Session and knowledge data can be read. They do not make Morrow a
HandWave or ARA product.
