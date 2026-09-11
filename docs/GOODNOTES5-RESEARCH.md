# GoodNotes 5 research and writing experience

Researched 11 September 2026. Target: the simple notebook workflow of
**GoodNotes 5**, rather than the current Goodnotes AI toolset.

## Sources and findings

- [GoodNotes 5 official guide](https://support.goodnotes.com/hc/en-us/articles/4599403401359-GoodNotes-5-Access-For-Legacy-Users-Only):
  separates document navigation from writing tools, exposes contextual color
  and width shortcuts, and distinguishes pressure-sensitive fountain ink from
  constant-width ball ink. Read-only navigation, page management, highlighter,
  shapes, lasso, PDF import, and zoom writing are part of the reference workflow.
- [GoodNotes 5 eraser behavior](https://support.goodnotes.com/hc/en-us/articles/360000629616-The-eraser-doesn-t-work-in-GoodNotes-5):
  the eraser targets handwriting/highlighting, not all kinds of page objects.
- [MDN: coalesced pointer samples](https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/getCoalescedEvents):
  merged input samples can be recovered for finer drawing detail where the
  browser supports the API. A fallback is required.
- [MDN: optimizing canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas):
  cache static drawing work and avoid repeating unnecessary rendering.

These are documentation findings, not a hands-on latency comparison against
GoodNotes 5 on an iPad. Current Goodnotes-only features were not treated as
evidence of what version 5 did.

## Design applied to NotePad

Visual direction: warm paper, a neutral desk, restrained ink-colored controls.
Content: notebook navigation above the tool row, the page as the primary
workspace, text and document operations in the existing drawer.
Interaction: immediate tool feedback; short drawer transitions; direct pan
and pinch with no decorative easing on the writing surface. Existing reduced
motion support remains active.

| Workflow | Implemented behavior |
| --- | --- |
| Choose writing instrument | Fountain/ball pen, translucent highlighter, whole-stroke eraser, and straight line |
| Change ink quickly | Four colors, three width presets, desktop precision slider; separate remembered width/color per tool |
| Resume writing | Tool choice and pen style survive reload; damaged optional settings fall back safely |
| Read and navigate | Hand mode pans with mouse/stylus; touch pan/pinch remains available; undo/redo cannot modify ink in hand mode |
| Move between pages | Previous/next buttons, position indicator and arrow keys |
| Continue notebook | Add page beside page navigation; inherit the current paper and dimensions |
| Reuse a page | Duplicate its handwriting, typed text and paper into a new page identity |
| Create notebook | Accessible in-app dialog replaces browser prompt; submit disabled while saving |
| Fit the view | Separate width and whole-page fit controls, mouse wheel pan, modifier-wheel zoom |
| Work on a narrow screen | Tool choices and contextual settings use separate rows; narrow settings can scroll horizontally |

Shortcuts: P pen, H highlighter, E eraser, L straight line, V read/pan;
left/right arrows change page. Existing save, undo and redo shortcuts remain.
Tool shortcuts are ignored while typing, while a dialog is open, or during
an active pointer gesture.

## Rendering and data integrity

Opaque live ink now paints newly received segments rather than the entire
growing stroke on every animation frame. Finishing a stroke appends that stroke
to the cached page instead of redrawing every old stroke. Coalesced samples
share one canvas bounds measurement per input event. Pressure and original
point coordinates remain in the archive.

Highlighter uses the existing ARGB alpha channel and a single continuous path,
avoiding darker overlapping segment joins. Lines use two endpoints. Ball ink
uses constant stored pressure. None requires an archive/backend schema change.
Undo, erase and background changes still rebuild the cached page. Highlighter
preview still redraws its active path; full-page history snapshots and saves
remain proportional to page size. This is not a claim of constant-time editing
for arbitrarily large notebooks.

The eraser now belongs to its initiating pointer. Palm events and unrelated
pointer releases cannot commit or cancel it. Cancellation restores the erased
ink. Tool changes cancel an unfinished gesture. Single-point taps have a radius
consistent with the stroke diameter.

Failed saves remain dirty after the debounce timer has fired. Navigation retries
the save and stays on the current page if it fails again. Remote refresh cannot
replace those unsaved edits, and idle sync status cannot label them saved.

## Remaining differences from GoodNotes 5

This implementation improves the daily writing workflow; it is **not full
GoodNotes 5 feature parity**. Missing capabilities include PDF import/annotation,
lasso selection and transforms, handwriting OCR/search, image placement,
positioned text boxes, folders, page thumbnail organization, geometric
shape recognition, and a separate zoom-writing window. Typed text currently
lives in the existing side panel. Hand mode protects canvas ink, not all document
operations. Undo history remains per open page and does not survive reload.

PDF/media need a compatible asset persistence, archive and sync design before
implementation. OCR needs an evaluated engine with Thai language support and
an explicit offline/privacy decision. Neither should be represented by a
decorative nonfunctional button.

## Verification

Run `npm test` and `npm run build` from `webApp`.

Automated checks cover pressure fallback, highlighter serialization and undo,
straight-line endpoints, ball pressure, read/pan mode, pointer ownership,
cancelled erasure, incremental rendering, the existing pan/pinch suite, notebook
creation, per-tool settings, duplicate/add page, and repeated failed-save
navigation. Existing auth/storage/sync/service-worker tests remain included.

Browser QA uses a separate `Writing tools QA` notebook on localhost and includes
desktop and 390px mobile layout. Physical Apple Pencil/S Pen latency and palm
rejection still need testing on the user's devices. Browser event tests cannot
certify that writing feels identical to native GoodNotes 5.

## Library-first UX follow-up

The entry flow now follows the reference library pattern: launch into Documents;
open an existing notebook by its cover, or choose New → Notebook → paper/name →
Create. Returning from the editor uses a dedicated Documents back button. Reload
always opens the library, even when an old page selection exists. An empty
workspace remains empty until the user creates or imports a notebook.

The library provides grid/list views, name/last-edited sorting, title/typed-text
search, favorites, settings/account access and trash recovery. Favorite markers
are device-local and scoped to the account; they do not sync. Cover colors are
stable generated decorations, not user-selected or editable cover pages.

The creation dialog offers interactive blank/ruled/grid previews. A newly
created notebook opens directly to its first page with the chosen paper.
Tests check the empty and stale-selection startup, explicit notebook opening,
search/favorites, the creation flow, and preventing a return to the library
when saving fails. Browser QA exercised the full creation flow and the 390px
library layout.
