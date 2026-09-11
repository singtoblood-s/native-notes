# Testing on your iPad and Samsung

Open https://singtoblood-s.github.io/native-notes/ in Safari on iPad or Chrome
on Samsung. You can add it to the home screen. Load it online once and check
Settings for **Offline cache ready** before using it offline. Guest notebooks
are stored only in that browser. Test opening it in airplane mode on each
device before relying on it away from a connection.

## Try sync

The delivery includes a temporary API connected to the development PC through
a Cloudflare quick tunnel. This is a test service: the PC, server process and
tunnel must remain running. It is not permanent hosting. If the endpoint is
unavailable, local editing and backup export still work.

1. Create an account using Account. Use the same account on both devices.
2. If you wrote in guest mode, choose whether to copy those notes into the
   account workspace. Signing in alone does not upload guest data.
3. Write on device A and wait for the sync status to confirm a successful
   server exchange. Device B pulls when brought to the foreground and checks
   periodically while visible. The status button can request an immediate sync.
4. Edit the same page offline on both devices, then sync each. Check that
   both versions remain recoverable as conflict copies.
5. Export a backup before clearing browser data or changing servers. An
   account workspace and a guest workspace are separate, including offline.

Sync is automatic after durable edits, sign-in, reconnect and returning to
the app, with periodic checks while visible. A local save is not a confirmation that
the other device already has the note. This is a browser editor; testing on
the actual devices is still needed for pen pressure, palm rejection, latency,
orientation changes, the on-screen keyboard and iPad suspension/resume.

## Editor regression checks

- The notebook title at the top opens Rename notebook. Tap the page title to
  edit its name in Text and page details; verify both after closing and reopening.
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

The originally delivered quick-tunnel endpoint was found unavailable during
the repair investigation. Client fixes do not provide permanent hosting:
login and cross-device sync require a running backend on the same URL.

## Restart a temporary test backend

Use JDK 21 and run from the repository root. PowerShell example:

```powershell
.\gradlew.bat :server:installDist
$env:PORT = "8787"
$env:NOTES_DB_PATH = "$PWD/.local/notes.db"
$env:ALLOWED_ORIGINS = "https://singtoblood-s.github.io"
.\server\build\install\server\bin\server.bat
```

In a second terminal, with the official `cloudflared` CLI installed:

```sh
cloudflared tunnel --url http://127.0.0.1:8787
```

Set the resulting HTTPS URL in the app's Settings on both devices. A quick
tunnel URL changes on restart; server URLs define separate local workspaces.
Export local-only changes before switching endpoints. Keep the SQLite file
and its directory: deleting them deletes server accounts and synced notes.

To change the default server for future visits, set the repository Actions
variable `VITE_API_URL` and rerun **NotePad web** in GitHub Actions. An explicit
Settings override takes priority over that build default. For an ongoing
service, use a stable HTTPS domain and a host with persistent disk; see the
server README.

## Verification boundaries

CI runs the web tests/build and server tests. Local browser checks exercise
the editor and API, but they do not replace physical Apple Pencil/S Pen
testing. Accounts have no email recovery in v1, and note contents are not
end-to-end encrypted. Use non-sensitive sample notes while evaluating the
temporary service.
