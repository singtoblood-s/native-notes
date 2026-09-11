# Testing on your iPad and Samsung

Open https://singtoblood-s.github.io/native-notes/ in Safari on iPad or Chrome
on Samsung. You can add it to the home screen. Load it online once before
using it offline. Guest notebooks are stored only in that browser.

## Try sync

The delivery includes a temporary API connected to the development PC through
a Cloudflare quick tunnel. This is a test service: the PC, server process and
tunnel must remain running. It is not permanent hosting. If the endpoint is
unavailable, local editing and backup export still work.

1. Create an account using Account. Use the same account on both devices.
2. If you wrote in guest mode, choose whether to copy those notes into the
   account workspace. Signing in alone does not upload guest data.
3. Write on device A, wait for **Saved locally**, then press the status button
   to sync. On device B, press the status button to retrieve the changes.
4. Edit the same page offline on both devices, then sync each. Check that
   both versions remain recoverable as conflict copies.
5. Export a backup before clearing browser data or changing servers. An
   account workspace and a guest workspace are separate, including offline.

Sync is manual in this first version. A local save is not a confirmation that
the other device already has the note. This is a browser editor; testing on
the actual devices is still needed for pen pressure, palm rejection, latency,
orientation changes, the on-screen keyboard and iPad suspension/resume.

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
