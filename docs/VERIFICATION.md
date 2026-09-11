# Release verification — 2026-09-11

## Current repair verification

- Web: 93 tests pass across 14 files; TypeScript and the production Vite build
  pass after the notebook/page menus, raster image persistence, ordered page
  flow, and iPad pointer buffering changes.
- Cloudflare Worker: 11 tests and TypeScript checks pass. Kotlin server and
  shared model checks pass.
- Browser smoke passes in Chromium at 1180 × 820 and WebKit at 820 × 1180,
  using the isolated local Vite/Worker/D1 services and disposable accounts.
  Both runs cover page flow, buffered preview pen input, raster upload and
  paste, CRUD/trash restore, reload, two-context sync and conflict recovery;
  neither run reported a page error. No production deployment is claimed here.

The remaining sections preserve the original release record for context and
are historical unless explicitly marked above.

## Historical initial investigation

The user's follow-up reproduced an undersized writing area, unstable pinch
anchoring, missing notebook rename controls and unavailable cross-device sync.
The original public tunnel returned HTTP 530 and the local API was stopped.
The existing server database was backed up privately before restarting the API
for local testing. No user database or note export is included in this repository.

The repair adds writing-first drawers, visible rename actions, width-fit paper,
bounded pinch/pan gestures, automatic sync coordination and explicit local
workspace recovery exports. See [repair plan](REPAIR_PLAN.md) and
[device regression checks](TESTING.md). Hosting availability remains separate
from client behavior: a static Pages deployment cannot supply the sync API.

The results below include historical checks from the original delivery;
repair-specific behavior is documented separately. Local Worker/D1 checks do
not imply that a production backend is continuously available.

### Historical repair checks performed

- Web: 38 passing tests across seven files; TypeScript and production Vite
  build pass. The unchanged server test suite and install distribution pass.
- Production builds served on two different browser origins use separate local
  SQLite stores and the same real local Ktor API/account. Notebook rename,
  page rename and Thai text from A appeared on B through automatic periodic
  sync, without pressing the sync button.
- Closing the text drawer immediately after changing a title/text and reloading
  preserved the new values. Notebook rename also survived reload.
- Stopping the API produced a visible network error while preserving edits.
  Restarting it triggered an automatic retry and uploaded the queued edit.
- The queued edit from B subsequently appeared on A automatically. A drawn
  stroke from A also appeared on B through periodic sync.
- Archiving a notebook made its nondeleted child page visible in Trash.
  Restoring the notebook and returning from Trash preserved text and ink.
- Writing-first layouts were inspected at 430 × 932, 834 × 1194 and
  1194 × 834. Mobile paper uses a 16-pixel gutter and begins at the top;
  notebook and text drawers begin closed.
- Automated gesture tests cover stable multi-move pinch anchors, cancellation
  and one-finger handoff, resize preservation, pan limits, active input guards
  and bounded history for large pages. Physical multi-touch/pen behavior still
  needs confirmation on the user's Safari/Chrome devices.

## Historical automated checks

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

## Historical browser and API checks

- Thai text and drawing strokes survive local database close/reopen/reload.
- Edits made immediately before switching pages stay on the correct page.
- Pointer drawing, undo and redo operate on the canvas.
- Two different browser origins, with separate local SQLite stores, log into
  the same account and exchange a note through the real HTTPS backend.
- Concurrent edits of one page preserve the server text on the original page
  and the other text on a visible conflict copy.
- The deployed GitHub Pages app loads its worker/WASM, logs into the configured
  backend, pulls the same note and signs out. Reload returns to the login gate.
- Responsive layouts were inspected at 430 × 932 and 834 × 1194. Tablet
  portrait uses a menu drawer and larger writing area.
- HTTP smoke checks verify retry deduplication, stale-write conflicts,
  cross-account isolation, logout rejection and allowed-origin preflight.

## Historical offline verification limit

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

The local Worker/D1 backend is for isolated verification and is not a guarantee
of an ongoing hosted service. See [testing instructions](TESTING.md).
