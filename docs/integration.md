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

## JSONL host

Python and Node hosts can launch `morrow-agent-jsonl` as a sidecar. The model
credential is passed through `MORROW_AGENT_MODEL_TOKEN`. The sidecar does not
create a new Session or replay an operation after a disconnect. The host reads
the original outcome, journal, fence, and business receipt before deciding how
to recover.

The JSONL protocol is documented in
[`crates/morrow-agent-jsonl/docs/protocol-v1.md`](../crates/morrow-agent-jsonl/docs/protocol-v1.md).

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
