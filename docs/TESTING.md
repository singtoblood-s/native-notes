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

1. Create an account using Account. Use the same account on both devices.
2. Write on device A and wait for the sync status to confirm a successful
   server exchange. Device B pulls when brought to the foreground and checks
   periodically while visible. The status button can request an immediate sync.
3. Edit the same page offline on both devices, then sync each. Check that
   both versions remain recoverable as conflict copies.
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
- Pinch around a word with two fingers, move both fingers, then release one
  and continue panning. The paper should keep its anchor without jumping.
- Try a third finger, palm contact during pen input, lifting the pen outside
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
