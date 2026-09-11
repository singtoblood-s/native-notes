# Apple Pencil: next stroke missing after lifting the pen

Investigated 2026-09-11. Status: evidence-backed browser workaround added;
physical-device cause and effectiveness remain unverified. Nothing deployed.

## Report and strongest hypothesis

The user writes ink directly on the canvas, for example `ฉันชื่อพรรษกร`.
On iPad Safari and Chrome, lifting the Pencil and immediately writing the next
character can produce no visible stroke at all. The stroke does not appear and
then disappear. The user reports current software/hardware, but an exact OS
build and Pencil model have not been supplied.

The leading hypothesis is native Scribble/gesture recognition swallowing a
rapid re-contact before the page receives `pointerdown`. This is a hypothesis,
not a device trace or a confirmed current WebKit defect. It is more consistent
with the clarified symptom than an old saved page replacing visible ink.

## Evidence, with dates and limits

1. [WebKit bug 217430: Missing PointerEvents with Scribble enable](https://bugs.webkit.org/show_bug.cgi?id=217430)
   was reported in October 2020 with fewer Pencil `pointerdown` events than
   expected. Disabling Scribble removed the symptom in that report. WebKit marked
   it fixed in February 2022. This proves a historical failure mechanism, not
   that the same defect remains open on the user's current OS.
2. [Mike Pukish's minimal reproduction, October 2020](https://mikepk.com/2020/10/iOS-safari-scribble-bug/)
   describes rapid second taps being ignored. The author found that Pointer Event
   cancellation and `user-select:none` did not help, while a `touchmove` listener
   calling `preventDefault()` did. Turning off Scribble also helped. This is a
   first-hand experiment on an older OS, not a guarantee for current iPadOS.
3. [First-hand developer discussion, April 2026](https://www.reddit.com/r/flutterhelp/comments/1sevz68/flutter_web_ipad_safari_apple_pencil_rapid_stylus/)
   describes the same rapid lift/re-contact symptom, including cases with neither
   `pointerdown` nor `touchstart`. Participants reported success after disabling
   Scribble. These are independent user reports, not an Apple-confirmed diagnosis
   or a published fix for a specific current OS build.
4. [Apple's UIScribbleInteraction documentation](https://developer.apple.com/documentation/uikit/uiscribbleinteraction)
   says nearby text views can take over Pencil events from drawing views.
   [Its delegate API](https://developer.apple.com/documentation/uikit/uiscribbleinteractiondelegate/scribbleinteraction(_:shouldbeginat:))
   can suppress Scribble at a location in a native UIKit app. That native API
   cannot simply be called from this application's browser JavaScript. No supported
   per-canvas JavaScript Scribble opt-out was found in the sources reviewed.
5. [Apple's Thai iPad guide](https://support.apple.com/th-th/guide/ipad/ipad355ab2a7/ipados)
   documents the Apple Pencil settings toggle for Scribble (เขียนข้อความ).
   Turning it off disables handwriting-to-text; drawing ink remains a separate use.
6. [MDN: addEventListener](https://developer.mozilla.org/en-US/docs/Web/API/EventTarget/addEventListener)
   documents that `preventDefault()` has no effect from a passive listener.

## Findings in this repository

- `webApp/src/canvas.ts` starts strokes in `handlePointerDown`. Without a down,
  subsequent moves cannot produce a new stroke in the current implementation.
- Existing repairs cover missing `pointerup`, reused pointer IDs, lost capture,
  cancellation, empty coalesced-event lists, and hover after a missing up. These
  operate on contacts that have already reached the application. They cannot
  recover a complete stroke whose contact events never reached JavaScript.
- The active canvas already uses `touch-action:none`, non-passive Pointer Event
  handlers, and `preventDefault()`. CSS already suppresses selection and callouts.
  There was no native `touchmove` cancellation listener on the canvas.
- `handleCanvasChange` updates the page's strokes before scheduling the save.
  Saves check edit generations; remote refresh also checks active input and dirty
  state. No additional persistence defect was demonstrated by this investigation.
- Neighbouring page previews use a separate activation/forwarding path and native
  finger scrolling. Test these separately from writing on the active page.

## Small mitigation implemented

`PaperCanvas` now installs a non-passive `touchmove` listener on its active canvas
and cancels the event when cancelable. `destroy()` removes the listener. Ink,
pressure, pan, and pinch still use the existing Pointer Event pipeline; native
Touch Events do not generate additional strokes. No global scroll cancellation,
new event-source multiplexing, hover-to-ink inference, or dependency was added.

This follows the historical workaround. It does not disable Scribble, prove the
root cause, or promise recovery when iPadOS sends no usable event. The listener
is deliberately not attached to inactive previews because their finger scrolling
is native. A preview-specific fix would require its own reproduced failure.

Validation: `npm test -- --reporter=dot` passed all 100 tests in 14 files.
The added regression checks native-event cancellation, continued one-finger flow
navigation, no duplicate ink, outside scrolling, and listener removal. Existing
pinch and rapid-contact tests also pass. `npm run build` passed TypeScript,
production bundling, and service-worker generation. Synthetic tests cannot
exercise iPadOS Scribble's native gesture recognizer.

## Decisive device check — before more speculative patches

Use the currently deployed app first, so no code update is needed for this check.

1. Use a blank active page in Page turn view. With Scribble enabled, write
   `ฉันชื่อพรรษกร` repeatedly at normal speed, and make 30 separate short strokes
   with rapid lifts. Note strokes that never appear. Repeat once with palm lifted.
2. Open **การตั้งค่า → Apple Pencil → เขียนข้อความ (Scribble)** and turn it off.
   Return to the same app and repeat at the same pace with the same pen and page.
3. Turn Scribble back on and repeat once more. A repeatable on/off/on change is
   much stronger evidence than a single successful sentence.
4. If disabling Scribble solves it, leave it disabled for reliable ink while
   testing whether the patched build also works with it enabled. Test Safari,
   Chrome, palm contact, and all three view modes; verify counts after reload.
5. If it does not solve it, obtain the exact iPad model, Pencil model, and iPadOS
   version/build. Record native `pointerdown/move/up/cancel`, `lostpointercapture`,
   and `touchstart/move/end/cancel`, including times, IDs, pressure/buttons, and
   targets, against the physical stroke count. Compare a minimal drawing surface
   with the app and compare a native Notes ink tool on the same device.

Interpretation of that trace:

| Observation | Next investigation |
| --- | --- |
| Neither contact-event stream contains the missed physical stroke | Native gesture/OS delivery; app cannot reconstruct absent samples |
| Touch contact exists but Pointer contact does not | Consider a narrowly scoped stylus Touch Events path with explicit deduplication |
| Pen moves indicate contact but down is absent | Evaluate contact recovery using the recorded pressure/buttons; never turn hover into ink |
| Down arrives, but no active stroke starts | Application pointer ownership, flow activation, or state gating |
| Ink is visible, then disappears or fails after reload | Rendering, page replacement, and persistence; a different symptom |

Do not treat a test that manually dispatches a missing down as proof that native
delivery is fixed. Do not clear notes/browser storage to troubleshoot this issue.
The patch is local and built, not published; the settings A/B check can be done now.
