# Vendored terminal renderer

Fetched from the official npm registry on 2026-10-16. Exact upstream distribution
bytes are bundled into Ray; no CDN/runtime dependency or npm install is required.
Source maps are not shipped. Keep both MIT license notices with these files.

| Package | Version | Tarball | npm SHA512 integrity |
|---|---|---|---|
| `@xterm/xterm` | `6.0.0` | `https://registry.npmjs.org/@xterm/xterm/-/xterm-6.0.0.tgz` | `sha512-TQwDdQGtwwDt+2cgKDLn0IRaSxYu1tSUjgKarSDkUM0ZNiSRXFpjxEsvc/Zgc5kq5omJ+V0a8/kIM2WD3sMOYg==` |
| `@xterm/addon-fit` | `0.11.0` | `https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-0.11.0.tgz` | `sha512-jYcgT6xtVYhnhgxh3QgYDnnNMYTcf8ElbxxFzX0IZo+vabQqSPAjC3c1wJrKB5E19VwQei89QCiZZP86DCPF7g==` |

Only the renderer and fit addon are enabled. No link, clipboard, file-transfer,
remote-attach, or WebGL addon is installed. Historical output is observation-only.
Explicit attachment requires the initial output snapshot to finish parsing. Node's
persistent headless VT responder owns protocol replies even while the UI is absent;
the browser never forwards parser-generated reports. Upstream project:
https://github.com/xtermjs/xterm.js

## Fixed-version private input-origin adapter

`handwave_console.js` reads `terminal._core.coreService.onUserInput`. This is a
deliberate, narrow coupling to the pinned distribution; it does not patch xterm.
`src/common/services/CoreService.ts` lines 61-81 in the 6.0.0 npm source defines:

```ts
triggerDataEvent(data: string, wasUserInput: boolean = false) {
  if (this._optionsService.rawOptions.disableStdin) return;
  // ... scroll handling ...
  if (wasUserInput) this._onUserInput.fire();
  // ... logging only ...
  this._onData.fire(data);
}
```

Keyboard: `src/browser/CoreBrowserTerminal.ts` lines 1090-1092, 1173-1175,
1206 pass `true`. Clipboard: `src/browser/Clipboard.ts:54` passes `true`.
IME: `src/browser/input/CompositionHelper.ts:136,173,198-202` passes `true`.
Protocol replies in `src/common/InputHandler.ts` and color/window/focus reports
in `src/browser/CoreBrowserTerminal.ts` leave the flag `false`.

The adapter's single-use synchronous ticket is consumed before any ownership or
attachment checks, so a rejected user event cannot authorize a later automatic
response. No `onBinary` channel is connected. An absent internal event fails closed
to read-only display with a visible update message. Do not silently change vendor
versions: rerun the actual vendored-parser tests for attached/historical query
suppression, Unicode input, paste semantics, source-ticket consumption, scope
switches, and missing-adapter failure; also perform browser keyboard/IME/paste
acceptance because a parser-only test does not exercise OS input events.

Vendored SHA256:

```
14903579ff54664cd72f8e8699e6961a6272c21863ec1c3b118cdc8af5d4a972  xterm-6.0.0.js
854a7c0fb70e8b1a083c16797ab827299fb18744f5ad34f227b48337e33293c6  xterm-6.0.0.css
ba3ea256ce0620a0992a197d6c9baea64823fc93d8da07a9e366ca9943c18527  addon-fit-0.11.0.js
```
