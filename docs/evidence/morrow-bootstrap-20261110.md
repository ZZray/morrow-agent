# Morrow bootstrap evidence

## Snapshot

- Repository: `E:\repos\morrow-agent`
- Branch: `main`
- Source: `ZZray/ara` Lite packages at `28ac6dc73eebe07ca3b403b2e6fa26c8985a30e`
- External Rust source: `rpi-ai` and `rpi-agent` at `8ec462672d90e62712d96074638efef89436cebe`

## Checks

| Command | Result |
| --- | --- |
| `cargo metadata --no-deps --format-version 1` | passed, four Morrow workspace members |
| `cargo fmt --all -- --check` | passed after formatting the renamed imports |
| `cargo check --workspace --locked` | passed |
| `cargo clippy --workspace --locked --offline --all-targets --no-deps -- -D warnings` | passed |
| `cargo test --workspace --locked --offline` | passed, 243 Core unit tests, Harness/JSONL/MCP tests and integration tests; original conditional tests remain ignored |
| old-name audit on source, tests, examples, and clients | no `ara-agent-lite`, `ara_agent_lite`, or `ARA_` matches |

The first offline check was blocked because `cc 1.11.1` was not cached. A
network-enabled locked check populated the local cache and passed. The final
workspace test then passed offline.

## Coverage boundary

This record covers the extracted Rust workspace and controlled integration
tests. It does not cover real model tasks, product Hosts, device operations,
JSONL Python/Node process acceptance, package publication, or dependency policy
acceptance. The historical evidence under each package's `docs/evidence`
directory retains the earlier ARA-era boundaries.
