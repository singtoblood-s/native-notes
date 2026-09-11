# Writing and sync repair plan

User-reported problems: the page is too small for handwriting, pinch gestures
move it away, notebook rename is undiscoverable, and notes do not reach other
devices even when signed into the same username.

## Confirmed causes

- The original layout permanently reserves space for notebook navigation and
  a text inspector, then fits the entire tall page into the remaining area.
- Pinch updates combine the initial gesture anchor with an already changed
  transform; the remaining finger also keeps a stale pan origin.
- Notebook creation has no discoverable rename action.
- The previous temporary backend is down: localhost refuses connections and
  the public tunnel returns HTTP 530. Sign-in alone cannot move notes between
  devices while that backend is unavailable.
- Sync is manual and its completed status is indistinguishable from a local
  save. A new account workspace also creates starter content before pulling
  existing server content.

## Changes and acceptance checks

| Area | Intended behavior | Regression check |
| --- | --- | --- |
| Workspace | Full-height handwriting surface; navigation and text are optional drawers | Phone, tablet portrait/landscape, desktop and virtual-keyboard layout |
| Gestures | Width-fit by default; stable finger anchor, bounded pan | Repeated pinch moves, 1→2→1 fingers, cancellation, pen/palm, resize |
| Names | Visible notebook/page rename actions | Thai names, whitespace, length limit, saved name after reload/sync |
| Sync | Automatic send/pull with honest local/pending/remote/error states | Two isolated clients, startup pull, edits during requests, retry, offline/online, account switch |
| Recovery | Preserve unsent notes across account or endpoint changes | Explicit copy/export of previous workspace; original database retained |
| Existing data | Reuse existing SQLite data and outbox | No database reset or destructive migration; private server backup first |

The backend hosting decision is separate from client correctness. A service
that only runs on a PC cannot sync when that PC or its server process is off.
Do not report persistent cross-device availability until a reachable backend
is configured and verified.

Physical S Pen/Apple Pencil validation remains necessary. Automated pointer
tests check gesture calculations and state transitions, not hardware latency.

Interaction references: [Goodnotes zoom and scrolling](https://support.goodnotes.com/hc/en-us/articles/6554036735631-How-to-zoom-and-scroll-through-pages)
and [MDN Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events).
