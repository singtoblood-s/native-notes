# Testing on your iPad and Samsung

Open the deployed web app in Safari on iPad or Chrome on Samsung. Add it to
the home screen if useful, load it online once, and check Settings for
**Offline cache ready** before relying on offline editing. Login is required;
there is no guest workspace.

## Try sync

For local browser QA, run the Vite app at `http://localhost:4173/native-notes/`
and the isolated Cloudflare Worker/D1 backend at `http://localhost:8789`.
Use sample credentials and a disposable local D1 database. If the backend is
unavailable, local editing and backup export still work, but cross-device sync
cannot be verified.

The repeatable editor smoke test is in `webApp/scripts/smoke-editor.mjs`:

```powershell
cd webApp
node scripts/smoke-editor.mjs --browser chromium
```

The script loads Playwright from `PLAYWRIGHT_MODULE` when set. Set
`SMOKE_EXECUTABLE_PATH` when the installed browser executable differs from the
bundled Playwright revision; `SMOKE_WIDTH` and `SMOKE_HEIGHT` override the
viewport. The default artifacts directory is `webApp/test-results`.

1. Use Create account on the sign-in screen. Sign in with that account on the second device.
2. Write on device A and wait for the sync status to confirm a successful
   server exchange. Device B pulls when brought to the foreground and checks
   periodically while visible. The status button can request an immediate sync.
3. Edit the same page offline on both devices, then sync each. Check that
   both devices show the first synced edit. On the device with the alternate
   edit, open Settings → Saved versions and restore it as a copy.
4. Export a backup before clearing browser data or changing servers. Keep
   separate test accounts when checking account isolation.

Sync is automatic after durable edits, sign-in, reconnect and returning to
the app, with periodic checks while visible. A local save is not a confirmation that
the other device already has the note. This is a browser editor; testing on
the actual devices is still needed for pen pressure, palm rejection, latency,
orientation changes, the on-screen keyboard and iPad suspension/resume.

## Editor regression checks

- The ⋯ menus beside notebook/page names expose Rename, Duplicate, and
  Trash/Restore. Verify each action after closing and reopening.
- Open Text and page details, insert a raster image from a file, paste another
  image from the clipboard, drag/resize/remove it in Hand mode, and verify the
  image after reload and sync.
- Select Continuous, Book scroll, and Page turn. Continuous keeps ordered page
  slots with ink previews and shows the add-page control at the end; the mode
  preference persists per account/device.
- The editor opens with both drawers closed. Check phone and tablet portrait
  and landscape, including opening the keyboard and returning to handwriting.
- With a writing tool selected, drag one finger on the paper to pan, then pinch around a word with two fingers. Release one finger. Check the handoff for jumps and start a new one-finger drag after lifting. In Select, a one-finger drag selects or moves ink.
- Enable **Settings → Writing → Require two fingers to scroll while writing**, save and reload. A single finger leaves the page fixed with the pen selected. Hand still pans the paper with one finger. Uncheck the setting to restore one-finger writing navigation.
- Rest a palm before, during and after a pen stroke. Check for unintended panning, page selection, image movement or Paste menus. Hold one finger in Hand to open Paste. Try a broad contact and pen hover over an adjacent preview while holding. Preserve mouse right-click and keyboard paste.
- A third finger pauses scrolling and zoom until exactly two remain. Check lifting the pen outside
  the page, undo/redo, rotation, and repeated zoom at the page edges.
- Test a server outage, expired login, switching accounts, and changes made
  while a sync is in flight. Local data must remain accessible and failures
  must not be shown as a successful server sync.
- Search for a page in another notebook and restore a deleted page whose
  notebook is not currently selected.

The old quick-tunnel instructions are intentionally removed. A tunnel tied to
the development PC is not a cross-device service. For deployment, configure a
stable HTTPS Worker/backend URL and set the web build's `VITE_API_URL`; an
explicit Settings override takes priority. Publish the frontend and backend
together when the page image format changes.

## Verification boundaries

CI runs the web tests/build and server tests. Local browser checks exercise
the editor and API, but they do not replace physical Apple Pencil/S Pen
testing. Accounts have no email recovery in v1, and note contents are not
end-to-end encrypted. Use non-sensitive sample notes while evaluating a
configured test service.

## NotePad review on 19 November 2026

The sync benchmark used headless Chromium, SQLite WASM and IndexedDB on
Windows. The local test database held 40 pages and occupied 17.29 MiB.

| Seven syncs with no changed records | Before | After |
| --- | ---: | ---: |
| Median time per sync | 212.1 ms | 1.7 ms |
| Full database writes | 14 | 0 |
| Total snapshot data written | 242.05 MiB | 0 MiB |

All five saves with changed content still wrote a snapshot. A separate check
forced an IndexedDB write to fail with later work queued. Reopening recovered
the previous text and sync cursor. Both new values survived reopening after a retry.

In a 1024 × 900 Chromium viewport at device pixel ratio 1, the 95th percentile
frame interval while drawing four strokes was 16.7 ms in a four-page notebook
and 16.8 ms in a 16-page notebook containing 96,000 ink points. Both notebooks
retained all four new strokes after reopening. Physical stylus latency remains
untested.

From `webApp`, run `npm test` for the automated regressions and
`node scripts/ui-smoke.mjs` for the six screen widths from 320 to 1440 px.
The UI checks cover creating a first notebook, navigating empty favorites,
clearing a search, keyboard focus on entering the editor and visible sync
errors. Chromium and WebKit also passed the local account, two-client sync,
conflict recovery, offline reload and media workflows.

## Media and page-navigation regression (2026-09-11)

Run `npm run test:browser` from `webApp` after `npx playwright install chromium`.
The new `scripts/editor-smoke.mjs` starts its own Vite server at port 4177 and
uses an isolated browser context with no real sync account. It tests PDF/image
import, handwriting, native file selection, clipboard, cancelled/successful
long press, stable page geometry, all view modes, exports, persistence, tablet
menus, and a corrupt file. Set `QA_BROWSER_CHANNEL=msedge` to use installed Edge.
Set `QA_URL` to a local production preview and `QA_OFFLINE=1` to repeat the same
checks after service-worker installation with networking disabled.
See [the checklist](EDITOR_POLISH_CHECKLIST.md) for exact PowerShell commands,
limits, results and outstanding physical-device checks.
