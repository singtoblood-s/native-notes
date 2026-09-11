# Release verification — 2026-09-11

## Automated

- Web: 17 passing tests covering auth identity/logout/endpoint handling,
  drawing taps/cancellation/palm input, account namespaces, UUIDs, immutable
  retry batches, nullable server responses, cursor reset, conflict reports
  and service-worker cache/fallback/API-exclusion behavior.
- Server: 5 passing tests covering session persistence/revocation, account
  isolation, idempotency/body mismatch, stale revisions, page tombstones and
  restore, deleted parents, HTTP errors, CORS and the request size limit.
- TypeScript and Vite production build pass, including the SQLite worker and
  emitted WASM asset.
- GitHub Actions web deployment and backend build/test both passed for the
  initial release commit `a80ce13`.

## Browser and API checks actually performed

- Thai text and drawing strokes survive local database close/reopen/reload.
- Edits made immediately before switching pages stay on the correct page.
- Pointer drawing, undo and redo operate on the canvas.
- Two different browser origins, with separate local SQLite stores, log into
  the same account and exchange a note through the real HTTPS backend.
- Concurrent edits of one page preserve the server text on the original page
  and the other text on a visible conflict copy.
- The deployed GitHub Pages app loads its worker/WASM, logs into the real
  backend, pulls the same note and signs out. Reload remains in guest mode.
- Responsive layouts were inspected at 430 × 932 and 834 × 1194. Tablet
  portrait uses a menu drawer and larger writing area.
- HTTP smoke checks verify retry deduplication, stale-write conflicts,
  cross-account isolation, logout rejection and allowed-origin preflight.

## Offline verification limit

The production service worker reports **Offline cache ready** with an active
controller. However, opening or reloading the app in the test in-app browser
after stopping the local static server produced a blank page. A cold offline
launch is therefore **not confirmed** in that environment. Test it in Safari
and Chrome on the physical devices; the Settings status also exposes cache
installation failures. Local SQLite persistence and editing while the page
remains open have been verified separately.

## Hardware checks still needed

Use both physical devices to check pressure, palm rejection, writing latency,
rotation, virtual-keyboard behavior and suspend/resume. The browser's pen API
has different capabilities from PencilKit and Samsung's native note editor.

The temporary backend is hosted on the development PC. Its availability is
not a guarantee of an ongoing hosted service. See [testing instructions](TESTING.md).
