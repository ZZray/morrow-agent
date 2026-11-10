# Source and migration record

This repository was created from the four Lite runtime packages in
`ZZray/ara`, using source commit `28ac6dc73eebe07ca3b403b2e6fa26c8985a30e` on
2026-11-10.

The extracted packages were renamed as follows.

| Previous package | Morrow package |
| --- | --- |
| `ara-agent-lite-core` | `morrow-agent-core` |
| `ara-agent-lite-harness` | `morrow-agent-harness` |
| `ara-agent-lite-jsonl` | `morrow-agent-jsonl` |
| `ara-agent-lite-mcp` | `morrow-agent-mcp` |

The MIT copyright headers and license attribution from the source package are
preserved. The `ARA contributors` line in `LICENSE` records that source
provenance and is not a claim that the new project has a separate copyright
history.

Rust imports, Python module names, JSONL binary names, and project environment
variables use the Morrow prefix. The source revision of `rpi-ai` and
`rpi-agent` remains fixed at `8ec462672d90e62712d96074638efef89436cebe`.

The old evidence files remain under the four package `docs/evidence` directories.
They were copied with their historical acceptance statements and machine paths.
Some package and path tokens were renamed during extraction, so a record can
contain mixed source-era and Morrow identifiers. They are provenance, not
current Morrow acceptance claims.

The old Full ARA/OMP crates, `tools/ara-lite`, product Hosts, and the Lite
evaluation gate were not copied into this first independent repository. They
remain in the source repository until a separate migration plan covers their
interfaces and evidence.
