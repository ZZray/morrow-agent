# Morrow Agent

Morrow Agent is an embeddable Rust agent system for business hosts. It keeps the
agent loop, session journal, tool execution, recovery rules, and host review
interfaces in reusable packages.

The project is the independent continuation of the former Lite Core work. The
old ARA repository remains the source record. This repository has its own Cargo
workspace, package names, environment variables, and Git history.

## Packages

| Package | Purpose |
| --- | --- |
| `morrow-agent-core` | Agent loop, sessions, context, tools, budgets, cancellation, and recovery contracts |
| `morrow-agent-harness` | Host-reviewed tasks, feedback continuation, evidence, and task budgets |
| `morrow-agent-jsonl` | JSONL sidecar for Python, Node, and other process hosts |
| `morrow-agent-mcp` | MCP stdio and Streamable HTTP tool sources |

The host owns identity, authorization, model credentials, storage placement,
product state, scheduling, and business acceptance. A successful Run is a
candidate for review. It does not accept a business Task by itself.

## Start here

- [Core integration](crates/morrow-agent-core/README.md)
- [Harness integration](crates/morrow-agent-harness/README.md)
- [JSONL protocol](crates/morrow-agent-jsonl/docs/protocol-v1.md)
- [MCP integration](crates/morrow-agent-mcp/README.md)
- [Business integration guide](docs/integration.md)
- [Source and migration record](docs/migration/source.md)
- [Archived ARA-era evidence](docs/archive/ara-lite-evidence/README.md)

## Local checks

```powershell
cargo fmt --all -- --check
cargo test --workspace --locked --offline
```

The JSONL process tests and real-model checks need their own explicit binary,
evidence directory, and model environment. Their results are not implied by a
workspace test run.

## Design direction

Morrow keeps a stable execution boundary while the host supplies business
capabilities. Harness now derives journal-backed candidate tool artifacts from
the exact ToolCall/ToolResult range before Host review. The Host supplies
business receipts, Harness rechecks matching `tool-artifacts.jsonl` records, and
accepted references are written to `TaskOutcome.artifacts`. Immutable
authorization snapshots are also present.
Explicit Trigger/Task/Run identities, context retrieval across compaction, and
bounded watchdog recovery remain future work; each needs executable evidence
and host-level acceptance.

The design review used Hyra 2.0, DeepSeek's SuperAgent prototype, and the
`super-agent-study` notes as external references. They inform the direction but
are not copied implementations or acceptance evidence.
