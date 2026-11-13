# Pinned public HandWave UI fixture

`handwave-app-7ae318fe.js` is the public, unauthenticated application JavaScript
served by the existing HandWave Hub, captured before the Ray context-card
adaptation on 2026-10-15. It is application source from this ARA project, not a
browser session export. No cookies, configuration, credentials, messages or
device state are included.

Exact byte SHA-256:
`7ae318fe13a6fd35cd652c3fed7ee51134ca7808d14aab8f1be0c18aa44a15b2`.
The local `.gitattributes` disables newline conversion for this exact fixture.

The Go asset-adapter test uses this file by default. The transport regression
extracts the actual original event and persistence functions from the same
fixture. This makes both tests independent of unrelated owner UI changes and
machine-local evidence directories. `RAY_DEPLOYED_APP_FIXTURE` may select another
copy, but its bytes must match this reviewed pin. Replacing the upstream version
requires reviewing the adapter and updating the pin deliberately.

This fixture is test-only. It is not embedded or served by the Ray executable.
