# Stable web input for the maintained Hub upgrade

The current repository is the maintained backend source, confirmed by the user
on2026-10-15. Its uncommitted auth/UI changes are outside this upgrade. To retain
the already deployed visual/auth-refresh behavior, the release builder overlays
these exact public embedded assets onto a clean Git export before compilation.
The backend is not recovered from the old executable. This snapshot contains
only static source served by that executable, no configuration, tokens, keys,
sessions or device data. Existing project notices still apply.

`manifest.json` pins every file and the archive. The corresponding Ray adapter
continues to append its reviewed UI modules. Normal `go build` without this
release input uses the ordinary web source; it is not claimed to produce the
same maintained-upgrade UI. Retire the snapshot only after the normal web owner
changes receive their own review and actual visual/auth acceptance.
