import { InkStroke, PageBackground, StrokePoint, id } from "./models";
import { type InkRect, type InkSelection, offsetInkRect, selectInk } from "./ink-selection";
import { PaperTouchFallback } from "./paper-touch-fallback";

export type CanvasTool =
  | { kind: "pen" | "highlighter" | "line"; color: number; width: number; pressureSensitive?: boolean }
  | { kind: "eraser"; width: number }
  | { kind: "hand" }
  | { kind: "select" };

export type CanvasNavigationMode = "continuous" | "horizontal" | "paged";

interface ActiveStroke {
  pointerID: number;
  stroke: InkStroke;
  startedAt: number;
  rect: DOMRect;
  bounds: InkBounds | null;
}

interface InkBounds { left: number; top: number; right: number; bottom: number; padding: number; }

export interface CanvasPoint { x: number; y: number; }

interface SelectionDrag {
  pointerID: number;
  pointerType: string;
  kind: "box" | "move";
  rect: DOMRect;
  start: CanvasPoint;
  current: CanvasPoint;
}

/** An image positioned in page coordinates, rendered below ink. */
export interface CanvasImage {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasPreviewPage {
  width: number;
  height: number;
  background: PageBackground;
  strokes: readonly InkStroke[];
  images?: readonly CanvasImage[];
  text?: string;
}

interface TouchPointer extends CanvasPoint {}

interface SingleFingerPan {
  id: number;
  start: CanvasPoint;
  startedAt: number;
  active: boolean;
}

// Screen coordinates stay independent of zoom, page size and handedness.
const PALM_REST_MS = 350;
const PEN_TAKEOVER_MS = 300;
const AFTER_PEN_MS = 320;
function broadContact(event: PointerEvent): boolean {
  // Safari can report a whole finger pad as a roughly 40–55 CSS px contact.
  // Reserve geometry alone for a much larger patch or the long edge of a hand.
  const short = Math.min(event.width, event.height);
  const long = Math.max(event.width, event.height);
  return (short >= 48 && long >= 64) || (short >= 26 && long >= 80);
}

interface CachedImage {
  src: string;
  element: HTMLImageElement;
  ready: boolean;
  failed: boolean;
}

export interface PanBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Keep a small part of a zoomed page visible while it is being panned. */
export const PAN_MARGIN = 32;
export const MOBILE_FIT_GUTTER = 16;
export const MIN_CANVAS_SCALE = 0.25;
export const MAX_CANVAS_SCALE = 2.8;
export const FIT_MAX_SCALE = 1.4;
export const MAX_HISTORY_ENTRIES = 100;
export const MAX_HISTORY_POINTS = 200_000;

function viewportGutter(viewportWidth: number): number {
  return viewportWidth < 640 ? MOBILE_FIT_GUTTER : PAN_MARGIN;
}

function boundedInsideViewport(content: number, viewport: number, margin: number): number | { min: number; max: number } {
  const maxOffset = viewport - content - margin;
  return maxOffset < margin ? (viewport - content) / 2 : { min: margin, max: maxOffset };
}

export function getPanBounds(
  pageWidth: number,
  pageHeight: number,
  scale: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = PAN_MARGIN,
): PanBounds {
  const scaledWidth = Math.max(0, pageWidth) * Math.max(0, scale);
  const scaledHeight = Math.max(0, pageHeight) * Math.max(0, scale);
  const safeViewportWidth = Math.max(0, viewportWidth);
  const safeViewportHeight = Math.max(0, viewportHeight);
  const safeMargin = Math.max(0, margin);
  const x = scaledWidth <= safeViewportWidth
    ? boundedInsideViewport(scaledWidth, safeViewportWidth, safeMargin)
    : { min: safeViewportWidth - scaledWidth - safeMargin, max: safeMargin };
  const y = scaledHeight <= safeViewportHeight
    ? boundedInsideViewport(scaledHeight, safeViewportHeight, safeMargin)
    : { min: safeViewportHeight - scaledHeight - safeMargin, max: safeMargin };
  return {
    minX: typeof x === "number" ? x : x.min,
    maxX: typeof x === "number" ? x : x.max,
    minY: typeof y === "number" ? y : y.min,
    maxY: typeof y === "number" ? y : y.max,
  };
}

export function clampPan(
  offsetX: number,
  offsetY: number,
  pageWidth: number,
  pageHeight: number,
  scale: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = PAN_MARGIN,
): CanvasPoint {
  const bounds = getPanBounds(pageWidth, pageHeight, scale, viewportWidth, viewportHeight, margin);
  return {
    x: clamp(finite(offsetX) ? offsetX : 0, bounds.minX, bounds.maxX),
    y: clamp(finite(offsetY) ? offsetY : 0, bounds.minY, bounds.maxY),
  };
}

export function worldPointAt(screen: CanvasPoint, scale: number, offsetX: number, offsetY: number): CanvasPoint {
  const safeScale = finite(scale) && Math.abs(scale) > Number.EPSILON ? scale : 1;
  return { x: (screen.x - offsetX) / safeScale, y: (screen.y - offsetY) / safeScale };
}

export function offsetAtAnchor(world: CanvasPoint, scale: number, anchor: CanvasPoint): CanvasPoint {
  return { x: anchor.x - world.x * scale, y: anchor.y - world.y * scale };
}

export interface CanvasCallbacks {
  onChange: (strokes: InkStroke[]) => void;
  onSelectionChange?: (count: number) => void;
  onZoom: (scale: number) => void;
  onEraseComplete?: () => void;
  onPageTurn?: (direction: -1 | 1) => void;
  onLimit?: (message: string) => void;
}

const previewStates = new WeakMap<HTMLCanvasElement, PreviewState>();

interface PaperTextLayout {
  text: string;
  width: number;
  height: number;
  fontMetrics: string;
  lines: string[];
}

// One layout per raster. Photo decode and erasing repaint unchanged text.
const paperTextLayouts = new WeakMap<HTMLCanvasElement, PaperTextLayout>();

export function clearPagePreview(canvas: HTMLCanvasElement): void {
  previewStates.delete(canvas);
  paperTextLayouts.delete(canvas);
  canvas.width = canvas.height = 1;
  delete canvas.dataset.version;
}

interface PreviewState extends CanvasPreviewPage {
  images: CanvasImage[];
  maxWidth: number;
  imageCache: Map<string, CachedImage>;
}

/** Render a bounded, non-interactive page thumbnail for continuous/book views. */
export function renderPagePreview(canvas: HTMLCanvasElement, page: CanvasPreviewPage, maxWidth = 320): void {
  const width = finite(page.width) && page.width > 0 ? page.width : 1;
  const height = finite(page.height) && page.height > 0 ? page.height : 1;
  const state: PreviewState = {
    width,
    height,
    background: page.background,
    text: page.text,
    strokes: page.strokes,
    images: normalizeCanvasImages(page.images ?? []),
    maxWidth: finite(maxWidth) && maxWidth > 0 ? maxWidth : 320,
    imageCache: new Map(),
  };
  previewStates.set(canvas, state);
  drawPagePreview(canvas, state);
}

/** A page-coordinate Pencil/pen canvas with high-DPI rendering and touch pan. */
export class PaperCanvas {
  private readonly canvas: HTMLCanvasElement;
  private readonly paper: HTMLElement;
  private readonly viewport: HTMLElement;
  /** Shared gesture surface for the active sheet, adjacent previews and gutters. */
  private scrollViewport: HTMLElement;
  private touchFallback?: PaperTouchFallback;
  private readonly context: CanvasRenderingContext2D;
  private readonly staticCanvas: HTMLCanvasElement;
  private readonly staticContext: CanvasRenderingContext2D;
  private readonly callbacks: CanvasCallbacks;
  private strokes: InkStroke[] = [];
  private selection: InkSelection | null = null;
  private selectionDrag: SelectionDrag | null = null;
  private readonly selectionBox = document.createElement("div");
  private background: PageBackground = "blank";
  private text = "";
  private width = 1024;
  private height = 1366;
  private tool: CanvasTool = { kind: "pen", color: 0xff252429, width: 2.5 };
  private active: ActiveStroke | null = null;
  private activePointBudget = 0;
  private limitReported = false;
  private eraserBefore: InkStroke[] | null = null;
  private eraserPointerID: number | null = null;
  private renderedPointCount = 0;
  private visibleInkBounds: InkBounds | null = null;
  private touchPointers = new Map<number, TouchPointer>();
  private singlePan: SingleFingerPan | null = null;
  private touchOrigin: {
    at: number; x: number; y: number; scale: number;
    fit: "width" | "page" | "custom"; moved: boolean;
  } | null = null;
  private requireTwoWhileWriting = false;
  private readonly palmContacts = new Set<number>();
  private readonly draggedContacts = new Set<number>();
  private lastDragRelease: { id: number; x: number; y: number; at: number } | null = null;
  private lastPenAt = -Infinity;
  /** Some browsers can lose capture before dispatching the matching pointerup. */
  private lostCapturePointers = new Set<number>();
  /** Pen hover/contact takes priority over touch navigation on writing tools. */
  private penPointers = new Set<number>();
  private handDrag: { pointerID: number; last: CanvasPoint } | null = null;
  private scrollVelocity = 0;
  private scrollTime = 0;
  private momentumFrame: number | null = null;
  private pinchStart: {
    distance: number;
    scale: number;
    offsetX: number;
    offsetY: number;
    center: TouchPointer;
  } | null = null;
  private undoStack: InkStroke[][] = [];
  private redoStack: InkStroke[][] = [];
  private dpr = 1;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private pageKey = "";
  private fitMode: "width" | "page" | "custom" = "width";
  private lastViewportSize: { width: number; height: number } | null = null;
  private activeFrame: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizePending = false;
  private images: CanvasImage[] = [];
  private imageCache = new Map<string, CachedImage>();
  private navigationMode: CanvasNavigationMode = "paged";
  private needsFit = false;

  constructor(canvas: HTMLCanvasElement, paper: HTMLElement, viewport: HTMLElement, callbacks: CanvasCallbacks) {
    this.canvas = canvas;
    this.paper = paper;
    this.viewport = viewport;
    this.scrollViewport = viewport;
    this.callbacks = callbacks;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot create a 2D canvas.");
    this.context = context;
    this.staticCanvas = document.createElement("canvas");
    const staticContext = this.staticCanvas.getContext("2d", { alpha: false });
    if (!staticContext) throw new Error("This browser cannot create an off-screen canvas.");
    this.staticContext = staticContext;
    // Let the compositor retain the page image underneath live ink. Copying the
    // entire page into the input canvas on every highlight frame is costly on iPad.
    this.staticCanvas.className = "paper-background-canvas";
    this.staticCanvas.setAttribute("aria-hidden", "true");
    this.paper.insertBefore(this.staticCanvas, this.canvas);
    this.selectionBox.className = "ink-selection-box";
    this.selectionBox.setAttribute("aria-hidden", "true");
    this.selectionBox.hidden = true;
    this.paper.append(this.selectionBox);
    // The canvas owns all touch gestures. This also prevents browser navigation
    // and native page scrolling from stealing a pen/pinch sequence.
    this.updateTouchAction();
    this.canvas.addEventListener("pointerdown", this.handlePointerDown, { passive: false });
    this.canvas.addEventListener("pointermove", this.handlePointerMove, { passive: false });
    this.canvas.addEventListener("pointerup", this.handlePointerUp, { passive: false });
    this.canvas.addEventListener("pointercancel", this.handlePointerCancel, { passive: false });
    this.canvas.addEventListener("lostpointercapture", this.handleLostPointerCapture);
    document.addEventListener("pointerup", this.handleDocumentPointerUp, { passive: false });
    document.addEventListener("pointercancel", this.handleDocumentPointerCancel, { passive: false });
    this.bindScrollGestures(this.scrollViewport);
    document.addEventListener("contextmenu", this.handleContextMenu);
    document.addEventListener("selectstart", this.handleSelectStart);
    window.addEventListener("blur", this.handleWindowBlur);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener("resize", this.handleResize, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.handleResize);
      this.resizeObserver.observe(this.viewport);
    }
  }

  setPage(pageID: string, width: number, height: number, background: PageBackground, strokes: InkStroke[], images: readonly CanvasImage[] = [], text = ""): void {
    this.stopMomentum();
    // Navigating to another page intentionally abandons the old page's live
    // contact; normal interruptions preserve any sampled ink.
    this.cancelActiveInput(false, false);
    const dimensionsChanged = this.width !== width || this.height !== height;
    const newPage = pageID !== this.pageKey;
    const firstPage = !this.pageKey;
    this.pageKey = pageID;
    this.width = width;
    this.height = height;
    this.background = background;
    this.text = text;
    this.replaceImages(images);
    this.paper.style.width = `${width}px`;
    this.paper.style.height = `${height}px`;
    if (dimensionsChanged || this.dpr !== this.rasterScale() || this.canvas.width !== Math.round(width * this.dpr)) this.resizeCanvas();
    this.setStrokes(strokes, newPage, false);
    const resizedPagedSheet = dimensionsChanged && this.navigationMode === "paged";
    if (firstPage || this.needsFit || (resizedPagedSheet && this.fitMode === "width")) {
      this.needsFit = false;
      this.fitToWidth();
    } else if (resizedPagedSheet && this.fitMode === "page") {
      this.fitToPage();
    } else if (resizedPagedSheet) {
      this.applyPan();
    } else if (this.navigationMode !== "paged") {
      this.updateTransform();
      this.callbacks.onZoom(this.scale);
    }
    this.render();
  }

  /** Replace page images without changing the ink or page navigation state. */
  setImages(images: readonly CanvasImage[]): void {
    this.replaceImages(images);
    this.render();
  }

  setText(text: string): void { this.text = text; this.render(); }

  /** Share touch navigation across the sheets and gutters in scrolling views. */
  setNavigationMode(mode: CanvasNavigationMode, scrollViewport?: HTMLElement): void {
    if (this.navigationMode === mode && (!scrollViewport || this.scrollViewport === scrollViewport)) return;
    this.navigationMode = mode;
    this.needsFit = true;
    this.stopMomentum();
    if (scrollViewport && scrollViewport !== this.scrollViewport) {
      this.unbindScrollGestures(this.scrollViewport);
      this.scrollViewport = scrollViewport;
      this.bindScrollGestures(this.scrollViewport);
    }
    this.handDrag = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver?.observe(this.navigationMode === "paged" ? this.viewport : this.scrollViewport);
    this.clearTouchNavigation();
    this.updateTouchAction();
  }

  setStrokes(strokes: InkStroke[], resetHistory = false, render = true): void {
    this.cancelSelectionDrag();
    this.strokes = cloneStrokes(strokes);
    const ids = this.selection?.ids;
    if (ids) this.setSelection(resetHistory ? null : selectInk(this.strokes, this.width, this.height, id => ids.has(id)));
    if (resetHistory) {
      this.undoStack = [];
      this.redoStack = [];
    }
    if (render) this.render();
  }

  setBackground(background: PageBackground): void {
    this.background = background;
    this.render();
  }

  setTool(tool: CanvasTool): void {
    if (this.isInputActive || this.touchPointers.size > 0) this.cancelActiveInput(true, true);
    if (tool.kind !== "select") this.setSelection(null);
    this.tool = tool;
    this.canvas.style.cursor = tool.kind === "hand" ? "grab" : "crosshair";
  }

  setRequireTwoFingersWhileWriting(required: boolean): void {
    if (this.requireTwoWhileWriting === required) return;
    this.requireTwoWhileWriting = required;
    this.singlePan = null;
  }

  get currentScale(): number { return this.scale; }
  get isWriting(): boolean { return this.active !== null || this.eraserBefore !== null; }
  /** True while a stroke, erase gesture, or intentional touch navigation is active. */
  get isInputActive(): boolean {
    return this.isWriting || this.selectionDrag !== null || this.handDrag !== null || this.singlePan !== null || this.touchPointers.size >= 2;
  }
  get hasUndo(): boolean { return this.undoStack.length > 0; }
  get hasRedo(): boolean { return this.redoStack.length > 0; }
  get selectedStrokeCount(): number { return this.selection?.ids.size ?? 0; }

  clearInkSelection(): void {
    this.cancelSelectionDrag();
    this.setSelection(null);
  }

  deleteSelectedInk(): void {
    if (this.tool.kind !== "select" || this.isInputActive || !this.selection) return;
    const ids = this.selection.ids;
    this.pushUndo(this.strokes);
    this.redoStack = [];
    this.strokes = this.strokes.filter(stroke => !ids.has(stroke.id));
    this.setSelection(null);
    this.render();
    this.callbacks.onChange(cloneStrokes(this.strokes));
  }

  undo(): void {
    if (this.isInputActive || this.tool.kind === "hand") return;
    const previous = this.undoStack.pop();
    if (!previous) return;
    if (historyPointCount(this.strokes) <= MAX_HISTORY_POINTS) this.redoStack.push(this.strokes);
    this.trimHistory();
    this.strokes = previous;
    this.setSelection(null);
    this.render();
    this.callbacks.onChange(cloneStrokes(this.strokes));
  }

  redo(): void {
    if (this.isInputActive || this.tool.kind === "hand") return;
    const next = this.redoStack.pop();
    if (!next) return;
    if (historyPointCount(this.strokes) <= MAX_HISTORY_POINTS) this.undoStack.push(this.strokes);
    this.trimHistory();
    this.strokes = next;
    this.setSelection(null);
    this.render();
    this.callbacks.onChange(cloneStrokes(this.strokes));
  }

  clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  zoomBy(factor: number): void {
    const rect = this.viewport.getBoundingClientRect();
    const visible = this.navigationMode === "paged" ? rect : this.scrollViewport.getBoundingClientRect();
    this.zoomTo(this.scale * factor, { x: visible.left + visible.width / 2 - rect.left, y: visible.top + visible.height / 2 - rect.top });
  }

  /** Fit the page to the viewport width and leave vertical space pannable. */
  fitToWidth(): void {
    this.fitMode = "width";
    if (this.navigationMode !== "paged") {
      const rect = this.scrollViewport.getBoundingClientRect();
      const gutter = this.scrollViewport === this.viewport ? 0 : this.navigationMode === "horizontal" ? 60 : 40;
      const width = Math.min(rect.width - gutter, this.navigationMode === "horizontal" ? 900 : 1000);
      if (width > 0) {
        this.lastViewportSize = { width: rect.width, height: rect.height };
        this.applyTransform(width / this.width, { x: 0, y: 0 }, true);
      }
      return;
    }
    const rect = this.viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.lastViewportSize = { width: rect.width, height: rect.height };
    const gutter = viewportGutter(rect.width);
    const fit = (rect.width - gutter * 2) / this.width;
    const nextScale = clamp(fit, this.minimumScale, FIT_MAX_SCALE);
    this.scale = nextScale;
    const bounded = clampPan(
      (rect.width - this.width * this.scale) / 2,
      gutter,
      this.width,
      this.height,
      this.scale,
      rect.width,
      rect.height,
      gutter,
    );
    this.offsetX = bounded.x;
    this.offsetY = bounded.y;
    this.updateTransform();
    this.callbacks.onZoom(this.scale);
  }

  /** Fit the complete page inside the viewport. Useful as an explicit view command. */
  fitToPage(): void {
    this.fitMode = "page";
    const rect = (this.navigationMode === "paged" ? this.viewport : this.scrollViewport).getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.lastViewportSize = { width: rect.width, height: rect.height };
    const gutter = viewportGutter(rect.width);
    const availableWidth = Math.max(1, rect.width - gutter * 2);
    const availableHeight = Math.max(1, rect.height - gutter * 2);
    if (this.navigationMode !== "paged") {
      this.applyTransform(Math.min(availableWidth / this.width, availableHeight / this.height), { x: 0, y: 0 }, true);
      return;
    }
    this.scale = clamp(Math.min(availableWidth / this.width, availableHeight / this.height), this.minimumScale, FIT_MAX_SCALE);
    const bounded = clampPan(
      (rect.width - this.width * this.scale) / 2,
      (rect.height - this.height * this.scale) / 2,
      this.width,
      this.height,
      this.scale,
      rect.width,
      rect.height,
      gutter,
    );
    this.offsetX = bounded.x;
    this.offsetY = bounded.y;
    this.updateTransform();
    this.callbacks.onZoom(this.scale);
  }

  /** Kept for the existing toolbar; width fit is the useful writing default. */
  fitToViewport(): void { this.fitToWidth(); }

  destroy(): void {
    this.stopMomentum();
    this.cancelActiveInput(false, false);
    this.staticCanvas.remove();
    this.selectionBox.remove();
    this.staticCanvas.width = this.staticCanvas.height = 1;
    this.imageCache.clear();
    window.removeEventListener("resize", this.handleResize);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerCancel);
    this.canvas.removeEventListener("lostpointercapture", this.handleLostPointerCapture);
    document.removeEventListener("pointerup", this.handleDocumentPointerUp);
    document.removeEventListener("pointercancel", this.handleDocumentPointerCancel);
    this.unbindScrollGestures(this.scrollViewport);
    document.removeEventListener("contextmenu", this.handleContextMenu);
    document.removeEventListener("selectstart", this.handleSelectStart);
    window.removeEventListener("blur", this.handleWindowBlur);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
  }

  private readonly handleResize = (): void => {
    // The in-progress contact uses the paper geometry sampled at pen-down.
    // Resizing either backing layer or fitting the view mid-stroke moves ink.
    if (this.active || this.eraserBefore || this.selectionDrag) {
      this.resizePending = true;
      return;
    }
    this.resizePending = false;
    const currentRect = (this.navigationMode === "paged" ? this.viewport : this.scrollViewport).getBoundingClientRect();
    if (!currentRect.width || !currentRect.height) return;
    const previousSize = this.lastViewportSize ?? currentRect;
    const widthChanged = previousSize.width !== currentRect.width;
    const heightChanged = previousSize.height !== currentRect.height;
    const resolutionChanged = this.dpr !== this.rasterScale();
    if (!widthChanged && !heightChanged && !resolutionChanged) return;
    this.lastViewportSize = { width: currentRect.width, height: currentRect.height };
    if (resolutionChanged) this.resizeCanvas();
    if (this.pageKey && this.fitMode === "width" && widthChanged) {
      this.fitToWidth();
      this.rebaseTouchGesture();
    } else if (this.pageKey && this.fitMode === "page" && (widthChanged || heightChanged)) {
      this.fitToPage();
      this.rebaseTouchGesture();
    } else if (this.navigationMode === "paged" && this.pageKey && widthChanged) {
      // Moving browser chrome or the onscreen keyboard may change only the
      // available height. Keep the paper origin fixed in that case.
      const previousCenter = { x: previousSize.width / 2, y: previousSize.height / 2 };
      const previousWorld = worldPointAt(previousCenter, this.scale, this.offsetX, this.offsetY);
      const nextOffset = offsetAtAnchor(previousWorld, this.scale, { x: currentRect.width / 2, y: currentRect.height / 2 });
      this.offsetX = nextOffset.x;
      this.offsetY = nextOffset.y;
      this.applyPan();
      this.rebaseTouchGesture();
    }
    if (resolutionChanged) this.render();
  };

  private rasterScale(): number {
    // Bound both backing surfaces for large imported paper sizes on mobile GPUs.
    return Math.min(3, Math.max(1, window.devicePixelRatio || 1), Math.sqrt(8_000_000 / (this.width * this.height)), 8192 / this.width, 8192 / this.height);
  }

  private get minimumScale(): number {
    const rect = (this.navigationMode === "paged" ? this.viewport : this.scrollViewport).getBoundingClientRect();
    const gutter = viewportGutter(rect.width);
    return Math.max(.001, Math.min(MIN_CANVAS_SCALE, (rect.width - 2 * gutter) / this.width, (rect.height - 2 * gutter) / this.height));
  }

  private get maximumScale(): number {
    return Math.max(MAX_CANVAS_SCALE, (this.navigationMode === "paged" ? this.viewport : this.scrollViewport).getBoundingClientRect().width / this.width);
  }

  private resizeCanvas(): void {
    this.dpr = this.rasterScale();
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.staticCanvas.width = this.canvas.width;
    this.staticCanvas.height = this.canvas.height;
    this.staticCanvas.style.width = this.canvas.style.width;
    this.staticCanvas.style.height = this.canvas.style.height;
    this.staticContext.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // WebKit/Scribble can swallow rapid Pencil contacts before pointerdown.
  // A non-passive touchmove listener is a reported workaround even with
  // touch-action:none and pointer-event preventDefault already in place:
  // https://mikepk.com/2020/10/iOS-safari-scribble-bug/
  // Keep this on the active canvas: Pointer Events own its ink/pan/pinch,
  // while neighbouring page previews share the outer surface's pointer gestures.
  // This does not disable Scribble or recover events the OS never dispatches.
  private readonly handleNativeTouchMove = (event: TouchEvent): void => {
    if (event.cancelable && (event.target === this.canvas || this.touchPointers.size > 0)) event.preventDefault();
  };

  private bindScrollGestures(surface: HTMLElement): void {
    this.touchFallback = new PaperTouchFallback(surface);
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const) {
      surface.addEventListener(type, this.handleSurfaceTouch, { capture: true, passive: false });
    }
    surface.addEventListener("touchmove", this.handleNativeTouchMove, { passive: false });
    surface.addEventListener("wheel", this.handleWheel, { passive: false });
    surface.addEventListener("pointerover", this.handlePenPresence, true);
    surface.addEventListener("pointerenter", this.handlePenPresence, true);
    surface.addEventListener("pointerout", this.handlePointerOut, true);
    surface.addEventListener("pointerleave", this.handlePointerOut, true);
    surface.addEventListener("click", this.guardPaperClick, true);
  }

  private unbindScrollGestures(surface: HTMLElement): void {
    this.touchFallback?.destroy();
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const) {
      surface.removeEventListener(type, this.handleSurfaceTouch, true);
    }
    surface.removeEventListener("touchmove", this.handleNativeTouchMove);
    surface.removeEventListener("wheel", this.handleWheel);
    surface.removeEventListener("pointerover", this.handlePenPresence, true);
    surface.removeEventListener("pointerenter", this.handlePenPresence, true);
    surface.removeEventListener("pointerout", this.handlePointerOut, true);
    surface.removeEventListener("pointerleave", this.handlePointerOut, true);
    surface.removeEventListener("click", this.guardPaperClick, true);
  }

  /** Fingers can start on different sheets or in the gutter; they share one gesture. */
  private readonly handleSurfaceTouch = (event: PointerEvent): void => {
    if (event.pointerType === "pen") {
      // Preempt a resting hand before a neighbouring preview maps its first ink sample.
      if (event.type === "pointerdown" || event.type === "pointermove") this.markPenPointer(event);
      else this.endPenPresence(event);
      return;
    }
    if (event.pointerType !== "touch" || event.target === this.canvas) return;
    if (event.type === "pointerdown") {
      if (event.target instanceof Element && event.target.closest("button, input, select, textarea, a, .paper-image-object")) {
        // Retain click/drag on individual controls while counting every finger on the sheet.
        this.trackTouch(event);
        // Selecting/resizing an image replaces its DOM node. Keep tracking that contact on the stable canvas.
        if (this.touchPointers.has(event.pointerId) && event.target.closest(".paper-image-object") && !event.target.closest(".image-delete-button")) {
          this.capturePointer(event.pointerId);
        }
      } else this.handlePointerDown(event);
    } else if (this.touchPointers.has(event.pointerId) || this.palmContacts.has(event.pointerId)) {
      if (event.type === "pointermove") this.handlePointerMove(event);
      else if (event.type === "pointerup") this.handlePointerUp(event);
      else this.handlePointerCancel(event);
    }
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    this.stopMomentum();
    event.preventDefault();
    // A reused pointer ID is a fresh contact boundary even when Safari omitted
    // both pointerup and lostpointercapture for the previous contact. Commit
    // that partial stroke before accepting the new down. A different pen ID
    // cannot safely terminate the current contact, so leave it alone.
    const samePointerContact = this.active && event.pointerType !== "touch" && event.pointerId === this.active.pointerID;
    const previousCaptureLost = this.active && this.lostCapturePointers.has(this.active.pointerID);
    if (this.active && this.tool.kind !== "hand" && (samePointerContact || previousCaptureLost)) this.commitActiveStroke();
    if (event.pointerType === "touch") {
      this.trackTouch(event);
      if (this.tool.kind === "select" && event.target === this.canvas && this.touchPointers.size === 1 &&
          this.touchPointers.has(event.pointerId) && !this.isPalmTouch(event)) this.beginSelection(event);
      return;
    }
    if (event.pointerType !== "pen" && event.pointerType !== "mouse") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (this.active || this.eraserBefore || this.handDrag || this.selectionDrag) return;
    this.clearTouchNavigation();
    if (this.tool.kind === "hand") {
      this.handDrag = { pointerID: event.pointerId, last: this.touchPoint(event) };
      this.scrollTime = performance.now();
      this.scrollVelocity = 0;
      this.capturePointer(event.pointerId);
      return;
    }
    this.capturePointer(event.pointerId);
    if (this.tool.kind === "select") {
      this.beginSelection(event);
      return;
    }
    if (this.tool.kind === "eraser") {
      this.eraserBefore = this.strokes;
      this.eraserPointerID = event.pointerId;
      this.eraseAt(this.pagePoint(event));
      return;
    }
    this.activePointBudget = 200_000 - historyPointCount(this.strokes);
    this.limitReported = false;
    if (this.strokes.length >= 10_000 || this.activePointBudget <= 0) {
      this.callbacks.onLimit?.("This page reached its ink limit. Add a new page or erase some ink to continue.");
      this.penPointers.delete(event.pointerId);
      try { this.canvas.releasePointerCapture(event.pointerId); } catch { /* Capture may already be gone. */ }
      return;
    }
    const timestamp = finite(event.timeStamp) ? event.timeStamp : performance.now();
    this.renderedPointCount = 0;
    this.active = {
      pointerID: event.pointerId,
      startedAt: timestamp,
      rect: this.canvas.getBoundingClientRect(),
      bounds: null,
      stroke: { id: id(), color: this.tool.kind === "highlighter" ? ((this.tool.color & 0xffffff) | 0x50000000) >>> 0 : this.tool.color >>> 0, width: this.tool.width, points: [] },
    };
    this.addPoints(event);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    event.preventDefault();
    if (event.pointerType === "touch" && this.rejectTouchMove(event)) return;
    if (this.selectionDrag?.pointerID === event.pointerId) {
      if (event.pointerType === "touch") this.touchPointers.set(event.pointerId, this.touchPoint(event));
      if (event.pointerType === "pen" && event.pressure === 0 && event.buttons === 0) this.finishSelection(event);
      else this.moveSelection(event);
      return;
    }
    if (this.active?.pointerID === event.pointerId && isStalePointerEvent(event, this.active.startedAt)) return;
    if (this.active?.pointerID === event.pointerId) {
      // A hover move is the only post-contact signal available when WebKit
      // omits pointerup. Finish the sampled stroke without adding the pen's
      // off-page hover position to it; a later pointerdown can start cleanly.
      if (event.pointerType === "pen" && event.buttons === 0 && event.pressure === 0) {
        this.addPoints(event, false);
        this.commitActiveStroke();
        return;
      }
      this.addPoints(event);
      return;
    }
    if (this.handDrag?.pointerID === event.pointerId) {
      const point = this.touchPoint(event);
      const previous = this.handDrag.last;
      this.handDrag.last = point;
      if (this.navigationMode === "paged") {
        this.offsetX += point.x - previous.x;
        this.offsetY += point.y - previous.y;
        this.applyPan();
      } else this.scrollWithHand(point, previous);
      return;
    }
    if (this.touchPointers.has(event.pointerId)) {
      const previous = this.touchPointers.get(event.pointerId)!;
      const point = this.touchPoint(event);
      this.touchPointers.set(event.pointerId, point);
      if (this.isPalmTouch(event)) {
        // This fresh finger landed just after a pen lift. It can take over
        // after the guard interval without lifting or replaying hidden motion.
        if (this.singlePan) {
          this.singlePan.start = point;
          this.singlePan.startedAt = performance.now();
        }
        if (this.pinchStart) this.beginPinch();
        return;
      }
      if (this.pinchStart) this.updatePinch();
      else if (this.singlePan?.id === event.pointerId) this.moveSingleFinger(point, previous);
      return;
    }
    if (this.eraserPointerID === event.pointerId) this.eraseAt(this.pagePoint(event));
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    event.preventDefault();
    if (this.selectionDrag?.pointerID === event.pointerId) this.finishSelection(event);
    if (this.active?.pointerID === event.pointerId && isStalePointerEvent(event, this.active.startedAt)) return;
    if (this.active?.pointerID === event.pointerId) {
      // WebKit can report the off-surface hover position on Pencil lift.
      // Keep any coalesced in-contact samples from that event.
      this.addPoints(event, event.pointerType !== "pen" || event.pressure !== 0);
      this.commitActiveStroke();
      return;
    }
    const penPointer = event.pointerType === "pen" || this.penPointers.has(event.pointerId);
    if (penPointer) this.penPointers.delete(event.pointerId);
    this.lostCapturePointers.delete(event.pointerId);
    if (this.handDrag?.pointerID === event.pointerId) {
      this.handDrag = null;
      if (this.navigationMode !== "paged" && performance.now() - this.scrollTime < 100) this.startMomentum();
      return;
    }
    if (event.pointerType === "touch") {
      this.endTouchPointer(event);
      return;
    }
    if (this.tool.kind === "eraser") {
      if (this.eraserPointerID !== event.pointerId) return;
      this.eraseAt(this.pagePoint(event));
      const before = this.eraserBefore;
      this.eraserBefore = null;
      this.eraserPointerID = null;
      if (before && before !== this.strokes) {
        this.pushUndo(before);
        this.redoStack = [];
        this.callbacks.onChange(cloneStrokes(this.strokes));
        this.callbacks.onEraseComplete?.();
      }
      if (this.resizePending) this.handleResize();
      return;
    }
  };

  private readonly handlePointerCancel = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    if (this.selectionDrag?.pointerID === pointerEvent.pointerId) this.cancelSelectionDrag();
    if (this.active?.pointerID === pointerEvent.pointerId && isStalePointerEvent(pointerEvent, this.active.startedAt)) return;
    if (this.active?.pointerID === pointerEvent.pointerId) {
      this.cancelActiveInput(true, true);
      return;
    }
    const penPointer = pointerEvent.pointerType === "pen" || this.penPointers.has(pointerEvent.pointerId);
    if (penPointer) this.penPointers.delete(pointerEvent.pointerId);
    if (this.handDrag?.pointerID === pointerEvent.pointerId) this.handDrag = null;
    if (pointerEvent.pointerType === "touch" || this.touchPointers.has(pointerEvent.pointerId)) {
      this.endTouchPointer(pointerEvent);
      return;
    }
    if (this.eraserPointerID === pointerEvent.pointerId) this.cancelActiveInput();
  };

  /**
   * Losing capture is not itself a cancelled stylus stroke. A browser can
   * happen just before pointerup while the Pencil is still down; cancelling
   * here drops the whole character. A later pointerdown recovers a genuinely
   * orphaned stroke, while explicit page replacement and teardown still discard input.
   */
  private readonly handleLostPointerCapture = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    if (this.selectionDrag?.pointerID === pointerEvent.pointerId) this.cancelSelectionDrag();
    if (this.active?.pointerID === pointerEvent.pointerId && isStalePointerEvent(pointerEvent, this.active.startedAt)) return;
    if (this.active?.pointerID === pointerEvent.pointerId) {
      this.lostCapturePointers.add(pointerEvent.pointerId);
      return;
    }
    if (this.handDrag?.pointerID === pointerEvent.pointerId) this.handDrag = null;
    if (pointerEvent.pointerType === "touch" || this.touchPointers.has(pointerEvent.pointerId)) {
      // Implicit capture can change when an image node is replaced. A rejected
      // contact must stay rejected until the actual up/cancel, even off paper.
      if (!this.palmContacts.has(pointerEvent.pointerId)) this.endTouchPointer(pointerEvent);
      return;
    }
    if (this.eraserPointerID === pointerEvent.pointerId) this.cancelActiveInput();
  };

  private readonly handleDocumentPointerUp = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    if (event.target instanceof Node && this.canvas.contains(event.target)) return;
    if (!this.ownsPointer(pointerEvent.pointerId)) return;
    this.handlePointerUp(pointerEvent);
  };

  private readonly handleDocumentPointerCancel = (event: Event): void => {
    if (event.target instanceof Node && this.canvas.contains(event.target)) return;
    const pointerEvent = event as PointerEvent;
    if (!this.ownsPointer(pointerEvent.pointerId)) return;
    this.handlePointerCancel(event);
  };

  private ownsPointer(pointerID: number): boolean {
    return this.selectionDrag?.pointerID === pointerID || this.active?.pointerID === pointerID || this.eraserPointerID === pointerID || this.handDrag?.pointerID === pointerID || this.touchPointers.has(pointerID) || this.palmContacts.has(pointerID);
  }

  private readonly handlePointerOut = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    if (pointerEvent.pointerType !== "pen" || (pointerEvent.relatedTarget instanceof Node && this.scrollViewport.contains(pointerEvent.relatedTarget))) return;
    this.endPenPresence(pointerEvent);
  };

  private readonly handlePenPresence = (event: Event): void => { this.markPenPointer(event as PointerEvent); };

  private readonly handleWindowBlur = (): void => {
    this.stopMomentum();
    this.cancelActiveInput(true, true);
    this.palmContacts.clear();
    this.draggedContacts.clear();
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") this.handleWindowBlur();
  };

  private readonly handleContextMenu = (event: MouseEvent): void => {
    if (this.canvas.isConnected && isCanvasChromeTarget(event.target) && !isTextSelectionTarget(event.target)) event.preventDefault();
  };

  private readonly handleSelectStart = (event: Event): void => {
    if (this.canvas.isConnected && isCanvasChromeTarget(event.target) && !isTextSelectionTarget(event.target)) event.preventDefault();
  };

  private markPenPointer(event: PointerEvent): void {
    if (event.pointerType !== "pen") return;
    this.lastPenAt = performance.now();
    this.penPointers.add(event.pointerId);
    this.stopMomentum();
    if (this.touchOrigin) this.restoreRecentTouchView();
    if (this.touchPointers.size) this.rejectHeldTouches();
  }

  private endPenPresence(event: PointerEvent): void {
    this.lastPenAt = performance.now();
    this.penPointers.delete(event.pointerId);
  }

  /** Shared with paper controls, which can see the same event before the canvas. */
  isPalmTouch(event: PointerEvent): boolean {
    if (event.pointerType !== "touch") return false;
    const sincePen = performance.now() - this.lastPenAt;
    return this.palmContacts.size > 0 || this.isWriting || this.selectionDrag?.pointerType === "pen" ||
      this.handDrag !== null || sincePen < AFTER_PEN_MS ||
      (this.penPointers.size > 0 && sincePen < 900) || broadContact(event);
  }

  private restoreRecentTouchView(): void {
    const origin = this.touchOrigin;
    this.touchOrigin = null;
    if (origin?.moved && performance.now() - origin.at <= PEN_TAKEOVER_MS) {
      // Several fingertips can look like an ordinary pinch until the pen arrives.
      // Restore the view before either the canvas or a preview maps pen coordinates.
      const zoomChanged = this.scale !== origin.scale;
      this.scale = origin.scale;
      this.fitMode = origin.fit;
      if (this.navigationMode === "paged") {
        this.offsetX = origin.x;
        this.offsetY = origin.y;
        this.applyPan();
      } else if (zoomChanged) this.updateTransform();
      if (zoomChanged) this.callbacks.onZoom(this.scale);
      if (this.navigationMode !== "paged") {
        this.scrollViewport.scrollLeft = origin.x;
        this.scrollViewport.scrollTop = origin.y;
      }
    }
  }

  private rejectHeldTouches(): void {
    if (this.selectionDrag?.pointerType === "touch") this.cancelSelectionDrag();
    for (const id of this.touchPointers.keys()) this.palmContacts.add(id);
    // Freeze at the current pose. A pen arriving while this hand is still
    // resting can still reclaim its original pose within the takeover window.
    this.clearTouchNavigation(true);
  }

  private rejectTouchMove(event: PointerEvent): boolean {
    if (this.palmContacts.has(event.pointerId)) return true;
    if (this.touchPointers.has(event.pointerId) && (this.palmContacts.size || this.isWriting || broadContact(event))) {
      this.rejectHeldTouches();
      return true;
    }
    return false;
  }

  private readonly guardPaperClick = (event: MouseEvent): void => {
    const last = this.lastDragRelease;
    const pointer = event as PointerEvent;
    if (!last || !event.detail || (pointer.pointerType && pointer.pointerType !== "touch") ||
        performance.now() - last.at > 700) return;
    if ((pointer.pointerType === "touch" && last.id === pointer.pointerId) ||
        Math.hypot(event.clientX - last.x, event.clientY - last.y) < 12) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  private updateTouchAction(): void {
    // The surface implements paper navigation; native panning would also move it with one finger.
    this.viewport.style.touchAction = "none";
    this.paper.style.touchAction = "none";
    this.canvas.style.touchAction = "none";
  }

  private clearTouchNavigation(keepOrigin = false): void {
    const pointers = [...this.touchPointers.keys()];
    this.touchPointers.clear();
    this.pinchStart = null;
    this.singlePan = null;
    if (!keepOrigin) this.touchOrigin = null;
    for (const pointerID of pointers) {
      try { this.canvas.releasePointerCapture(pointerID); } catch { /* capture may already be gone */ }
    }
  }

  private touchPoint(event: PointerEvent): TouchPointer {
    if (this.navigationMode !== "paged") return { x: event.clientX, y: event.clientY };
    const rect = this.viewport.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private capturePointer(pointerID: number): void {
    try { this.canvas.setPointerCapture(pointerID); } catch { /* a browser may reject an already-lost pointer */ }
  }

  private trackTouch(event: PointerEvent): void {
    this.stopMomentum();
    // A fresh down may reuse a pointer ID after the browser lost its last up.
    if (event.isPrimary && !this.isWriting && this.palmContacts.size && !this.touchPointers.size) this.palmContacts.clear();
    this.palmContacts.delete(event.pointerId);
    this.draggedContacts.delete(event.pointerId);
    this.lastDragRelease = null;
    const now = performance.now();
    const penContact = this.isWriting || this.handDrag !== null || this.selectionDrag?.pointerType === "pen";
    if (this.palmContacts.size || penContact || broadContact(event)) {
      this.rejectHeldTouches();
      this.palmContacts.add(event.pointerId);
      return;
    }
    const point = this.touchPoint(event);
    if (this.touchPointers.size === 0 && this.tool.kind !== "hand") {
      this.touchOrigin = { at: now, scale: this.scale, fit: this.fitMode, moved: false,
        x: this.navigationMode === "paged" ? this.offsetX : this.scrollViewport.scrollLeft,
        y: this.navigationMode === "paged" ? this.offsetY : this.scrollViewport.scrollTop };
    }
    this.touchPointers.set(event.pointerId, point);
    if (this.touchPointers.size > 1) {
      if (this.selectionDrag?.pointerType === "touch") this.cancelSelectionDrag();
      for (const id of this.touchPointers.keys()) this.draggedContacts.add(id);
    }
    // Touch has implicit capture on its original target, preserving taps on previews and images.
    this.rebaseTouchGesture();
    if (this.touchPointers.size !== 1 || (this.tool.kind !== "hand" && this.requireTwoWhileWriting) ||
        (this.tool.kind === "select" && event.target === this.canvas) ||
        (event.target instanceof Element && event.target.closest("button, input, select, textarea, a, .paper-image-object"))) return;
    this.singlePan = { id: event.pointerId, start: point, startedAt: now, active: false };
  }

  private moveSingleFinger(point: CanvasPoint, previous: CanvasPoint): void {
    const pan = this.singlePan!;
    if (!pan.active) {
      const now = performance.now();
      const elapsed = now - pan.startedAt;
      const writing = this.tool.kind !== "hand";
      const travel = distance(point, pan.start);
      // A fresh fingertip can rest briefly after writing. Require a clearer drag
      // near the pen, but keep accepting movement from that same finger.
      const restedNearPen = elapsed >= PALM_REST_MS && this.lastPenAt >= pan.startedAt - AFTER_PEN_MS;
      const slop = writing ? (restedNearPen ? 20 : 9) : 4;
      if (travel <= slop) return;
      this.draggedContacts.add(pan.id);
      if (writing && elapsed < 45 && travel < 20) return;
      pan.active = true;
      // Apply the part beyond tap jitter even if the browser coalesced the
      // entire swipe into one move. Subsequent deltas follow the finger 1:1.
      previous = { x: pan.start.x + (point.x - pan.start.x) * slop / travel,
        y: pan.start.y + (point.y - pan.start.y) * slop / travel };
    }
    if (this.touchOrigin) this.touchOrigin.moved = true;
    const dx = point.x - previous.x, dy = point.y - previous.y;
    if (this.navigationMode === "paged") {
      this.offsetX += dx;
      this.offsetY += dy;
      this.applyPan();
    } else {
      this.scrollViewport.scrollLeft -= dx;
      this.scrollViewport.scrollTop -= dy;
    }
  }

  private rebaseTouchGesture(): void {
    this.singlePan = null;
    if (this.touchPointers.size === 2) this.beginPinch();
    else this.pinchStart = null;
  }

  private beginPinch(): void {
    const [first, second] = this.touchPointers.values();
    if (!first || !second) return;
    const center = midpoint(first, second);
    const rect = this.viewport.getBoundingClientRect();
    this.pinchStart = {
      distance: Math.max(1, distance(first, second)),
      scale: this.scale,
      offsetX: this.navigationMode === "paged" ? this.offsetX : rect.left,
      offsetY: this.navigationMode === "paged" ? this.offsetY : rect.top,
      center,
    };
  }

  private updatePinch(): void {
    const start = this.pinchStart;
    const [first, second] = this.touchPointers.values();
    if (!start || !first || !second) return;
    if (this.touchOrigin) this.touchOrigin.moved = true;
    const nextCenter = midpoint(first, second);
    const nextDistance = Math.max(1, distance(first, second));
    const world = worldPointAt(start.center, start.scale, start.offsetX, start.offsetY);
    const requestedScale = start.scale * (nextDistance / start.distance);
    const nextScale = clamp(requestedScale, this.minimumScale, this.maximumScale);
    const nextOffset = offsetAtAnchor(world, nextScale, nextCenter);
    if (this.navigationMode !== "paged") {
      const rect = this.viewport.getBoundingClientRect();
      nextOffset.x -= rect.left;
      nextOffset.y -= rect.top;
    }
    this.fitMode = "custom";
    this.applyTransform(nextScale, nextOffset, true);
    if (nextScale !== requestedScale) this.beginPinch();
  }

  private endTouchPointer(event: PointerEvent): void {
    const pageTurn = event.type === "pointerup" ? this.fittedPageSwipe(event.pointerId) : 0;
    const palm = this.palmContacts.delete(event.pointerId);
    const dragged = this.draggedContacts.delete(event.pointerId);
    const now = performance.now();
    const held = this.touchPointers.has(event.pointerId) && this.touchOrigin && now - this.touchOrigin.at >= PALM_REST_MS;
    if (palm || dragged || held) this.lastDragRelease = { id: event.pointerId, x: event.clientX, y: event.clientY, at: now };
    const tracked = this.touchPointers.delete(event.pointerId);
    if (!this.touchPointers.size && !this.palmContacts.size) this.touchOrigin = null;
    if (!tracked) return;
    this.rebaseTouchGesture();
    if (pageTurn) this.callbacks.onPageTurn?.(pageTurn);
  }

  private fittedPageSwipe(id: number): -1 | 0 | 1 {
    if (this.navigationMode !== "paged" || !this.callbacks.onPageTurn ||
        this.width * this.scale > this.viewport.getBoundingClientRect().width + 1) return 0;
    const point = this.touchPointers.get(id);
    if (!point) return 0;
    let start: CanvasPoint, end: CanvasPoint;
    if (this.singlePan?.id === id && this.singlePan.active) {
      start = this.singlePan.start;
      end = point;
    } else if (this.pinchStart && this.touchPointers.size === 2) {
      const [first, second] = this.touchPointers.values();
      if (!first || !second || Math.abs(distance(first, second) / this.pinchStart.distance - 1) > .08) return 0;
      start = this.pinchStart.center;
      end = midpoint(first, second);
    } else return 0;
    const dx = end.x - start.x;
    if (Math.abs(dx) < 70 || Math.abs(dx) < 2 * Math.abs(end.y - start.y)) return 0;
    return dx < 0 ? 1 : -1;
  }

  private applyPan(): void {
    const rect = this.viewport.getBoundingClientRect();
    const gutter = viewportGutter(rect.width);
    const bounded = clampPan(
      this.offsetX,
      this.offsetY,
      this.width,
      this.height,
      this.scale,
      rect.width,
      rect.height,
      gutter,
    );
    this.offsetX = bounded.x;
    this.offsetY = bounded.y;
    this.updateTransform();
  }

  private scrollWithHand(point: CanvasPoint, previous: CanvasPoint): void {
    const deltaX = point.x - previous.x;
    const deltaY = point.y - previous.y;
    const time = performance.now();
    const delta = this.navigationMode === "horizontal" ? deltaX : deltaY;
    this.scrollVelocity = -delta / Math.max(8, time - this.scrollTime);
    this.scrollTime = time;
    this.scrollViewport.scrollTop -= deltaY;
    this.scrollViewport.scrollLeft -= deltaX;
  }

  private stopMomentum(): void {
    if (this.momentumFrame !== null) cancelAnimationFrame(this.momentumFrame);
    this.momentumFrame = null;
  }

  private startMomentum(): void {
    if (Math.abs(this.scrollVelocity) < .1 || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let last = performance.now();
    const tick = (time: number): void => {
      const dt = Math.min(32, Math.max(0, time - last)); last = time;
      const axis = this.navigationMode === "horizontal" ? "scrollLeft" : "scrollTop";
      const before = this.scrollViewport[axis];
      this.scrollViewport[axis] += this.scrollVelocity * dt;
      this.scrollVelocity *= Math.pow(.94, dt / 16);
      if (Math.abs(this.scrollVelocity) > .05 && this.scrollViewport[axis] !== before) this.momentumFrame = requestAnimationFrame(tick);
      else this.momentumFrame = null;
    };
    this.momentumFrame = requestAnimationFrame(tick);
  }

  private applyTransform(nextScale: number, nextOffset: CanvasPoint, notifyZoom: boolean): void {
    const scale = clamp(finite(nextScale) ? nextScale : this.scale, this.minimumScale, this.maximumScale);
    const rect = this.viewport.getBoundingClientRect();
    if (this.navigationMode !== "paged") {
      this.scale = scale;
      this.updateTransform();
      // Resize every sheet before adjusting scroll to keep the gesture anchor fixed.
      this.callbacks.onZoom(this.scale);
      const nextRect = this.viewport.getBoundingClientRect();
      const left = this.scrollViewport.scrollLeft + nextRect.left - rect.left - nextOffset.x;
      const top = this.scrollViewport.scrollTop + nextRect.top - rect.top - nextOffset.y;
      this.scrollViewport.scrollLeft = left;
      this.scrollViewport.scrollTop = top;
      if (this.pinchStart) {
        // Discard movement beyond a boundary so reversing the fingers responds immediately.
        this.pinchStart.offsetX += (left - this.scrollViewport.scrollLeft) * this.pinchStart.scale / scale;
        this.pinchStart.offsetY += (top - this.scrollViewport.scrollTop) * this.pinchStart.scale / scale;
      }
      return;
    }
    const gutter = viewportGutter(rect.width);
    const bounded = clampPan(
      finite(nextOffset.x) ? nextOffset.x : this.offsetX,
      finite(nextOffset.y) ? nextOffset.y : this.offsetY,
      this.width,
      this.height,
      scale,
      rect.width,
      rect.height,
      gutter,
    );
    this.scale = scale;
    this.offsetX = bounded.x;
    this.offsetY = bounded.y;
    if (this.pinchStart) {
      this.pinchStart.offsetX += (bounded.x - nextOffset.x) * this.pinchStart.scale / scale;
      this.pinchStart.offsetY += (bounded.y - nextOffset.y) * this.pinchStart.scale / scale;
    }
    this.updateTransform();
    if (notifyZoom) this.callbacks.onZoom(this.scale);
  }

  private cancelActiveInput(render = true, preserveActiveStroke = false): void {
    const pointers = [...this.touchPointers.keys()];
    if (this.selectionDrag) pointers.push(this.selectionDrag.pointerID);
    this.cancelSelectionDrag();
    if (this.active) pointers.push(this.active.pointerID);
    if (this.eraserPointerID !== null) pointers.push(this.eraserPointerID);
    if (this.handDrag) pointers.push(this.handDrag.pointerID);
    this.handDrag = null;
    const active = this.active;
    const eraserBefore = this.eraserBefore;
    this.active = null;
    this.lostCapturePointers.clear();
    if (eraserBefore) this.strokes = eraserBefore;
    this.eraserBefore = null;
    this.eraserPointerID = null;
    this.touchPointers.clear();
    this.penPointers.clear();
    this.pinchStart = null;
    this.singlePan = null;
    this.touchOrigin = null;
    for (const pointerID of pointers) {
      try { this.canvas.releasePointerCapture(pointerID); } catch { /* capture may already be gone */ }
    }
    if (this.activeFrame !== null) {
      cancelAnimationFrame(this.activeFrame);
      this.activeFrame = null;
    }
    if (preserveActiveStroke && active?.stroke.points.length) this.commitActiveStroke(active);
    if (render) {
      if (this.resizePending) this.handleResize();
      if (eraserBefore) this.renderStatic();
      this.renderVisible();
    }
  }

  private pushUndo(snapshot: InkStroke[]): void {
    // Committed strokes are immutable, so snapshots share their point data.
    if (historyPointCount(snapshot) > MAX_HISTORY_POINTS) {
      this.undoStack = [];
      this.redoStack = [];
      return;
    }
    this.undoStack.push(snapshot);
    this.trimHistory();
  }

  private trimHistory(): void {
    while (
      this.undoStack.length + this.redoStack.length > MAX_HISTORY_ENTRIES ||
      historyStackPointCount(this.undoStack) + historyStackPointCount(this.redoStack) > MAX_HISTORY_POINTS
    ) {
      if (this.undoStack.length > 0) this.undoStack.shift();
      else if (this.redoStack.length > 0) this.redoStack.shift();
      else break;
    }
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    if (this.isInputActive) return;
    if (!event.ctrlKey && !event.metaKey) {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.scrollViewport.clientHeight : 1;
      if (this.navigationMode === "continuous") {
        this.scrollViewport.scrollLeft += event.deltaX * unit;
        this.scrollViewport.scrollTop += event.deltaY * unit;
        return;
      }
      if (this.navigationMode === "horizontal") {
        this.scrollViewport.scrollLeft += (event.deltaX || event.deltaY) * unit;
        return;
      }
      this.offsetX -= event.deltaX * unit;
      this.offsetY -= event.deltaY * unit;
      this.applyPan();
      return;
    }
    if (!finite(event.deltaY) || event.deltaY === 0) return;
    const rect = this.viewport.getBoundingClientRect();
    this.zoomTo(this.scale * (event.deltaY < 0 ? 1.08 : 0.92), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  private addPoints(event: PointerEvent, includeCurrent = true): void {
    if (!this.active) return;
    const coalesced = coalescedSamples(event);
    // getCoalescedEvents contains historical samples; the dispatched event is
    // the newest sample and must be retained for fast Pencil strokes.
    const events = coalesced.length > 0
      ? (includeCurrent ? [...coalesced, event] : coalesced)
      : (includeCurrent ? [event] : []);
    if (events.length === 0) return;
    const rect = this.active.rect;
    for (const sample of events) {
      if (sample !== event && event.pointerType === "pen" && sample.pressure === 0 && sample.buttons === 0) continue;
      if (this.active.stroke.points.length >= this.activePointBudget && !(this.tool.kind === "line" && this.activePointBudget >= 2)) {
        if (!this.limitReported) this.callbacks.onLimit?.("This page reached its ink limit. The sampled ink was kept; continue on a new page.");
        this.limitReported = true;
        break;
      }
      const position = this.pagePoint(sample, rect);
      const timestamp = finite(sample.timeStamp) ? sample.timeStamp : performance.now();
      const pressure = finite(sample.pressure) && sample.pressure > 0 ? clamp(sample.pressure, 0, 1) : 0.5;
      const previous = this.active.stroke.points.at(-1);
      const point: StrokePoint = {
        // Two decimals are sub-pixel at normal page zoom and keep dense ink
        // comfortably below the server's operation-size limit.
        x: roundTo(position.x, 2),
        y: roundTo(position.y, 2),
        pressure: this.tool.kind === "pen" && this.tool.pressureSensitive !== false ? roundTo(pressure, 3) : 1,
        // Coalesced samples and pointerup can arrive with older timestamps.
        time: Math.max(previous?.time ?? 0, Math.round(timestamp - this.active.startedAt)),
        tiltX: finite(sample.tiltX) ? clamp(roundTo(sample.tiltX, 1), -90, 90) : null,
        tiltY: finite(sample.tiltY) ? clamp(roundTo(sample.tiltY, 1), -90, 90) : null,
      };
      // A tap commonly arrives as a down and an up with an empty coalesced
      // array. Keep its single canonical point instead of duplicating it.
      if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) > 0.01) {
        this.active.stroke.points.push(point);
        const bounds = this.active.bounds;
        if (bounds) {
          bounds.left = Math.min(bounds.left, point.x);
          bounds.top = Math.min(bounds.top, point.y);
          bounds.right = Math.max(bounds.right, point.x);
          bounds.bottom = Math.max(bounds.bottom, point.y);
        } else {
          this.active.bounds = { left: point.x, top: point.y, right: point.x, bottom: point.y, padding: this.active.stroke.width + 2 };
        }
      }
      if (this.tool.kind === "line" && this.active.stroke.points.length > 2) {
        this.active.stroke.points = [this.active.stroke.points[0]!, point];
      }
    }
    this.scheduleActiveRender();
  }

  private commitActiveStroke(active = this.active): void {
    if (!active) return;
    // Capture before mutating so undo restores the exact page, including a
    // single-point tap or an empty stroke.
    this.pushUndo(this.strokes);
    this.strokes = [...this.strokes, active.stroke];
    this.redoStack = [];
    // Commit just this stroke to the cached page, independent of page length.
    this.renderStroke(this.staticContext, active.stroke);
    if (this.active === active) this.active = null;
    if (this.activeFrame !== null) cancelAnimationFrame(this.activeFrame);
    this.activeFrame = null;
    this.lostCapturePointers.delete(active.pointerID);
    this.penPointers.delete(active.pointerID);
    this.renderVisible();
    this.callbacks.onChange(cloneStrokes(this.strokes));
    if (this.resizePending) this.handleResize();
  }

  private eraseAt(point: { x: number; y: number }): void {
    const radius = Math.max(12, this.tool.kind === "eraser" ? this.tool.width * 4 : 16);
    const kept = this.strokes.filter((stroke) => !strokeHit(stroke, point, radius));
    if (kept.length !== this.strokes.length) {
      this.strokes = kept;
      this.render();
    }
  }

  private setSelection(selection: InkSelection | null): void {
    const previousCount = this.selectedStrokeCount;
    this.selection = selection;
    this.showSelectionBox(selection?.bounds);
    if (previousCount !== this.selectedStrokeCount) this.callbacks.onSelectionChange?.(this.selectedStrokeCount);
  }

  private showSelectionBox(bounds?: InkRect): void {
    this.selectionBox.hidden = !bounds;
    if (!bounds) return;
    const style = this.selectionBox.style;
    style.left = `${bounds.left}px`; style.top = `${bounds.top}px`;
    style.width = `${Math.max(1, bounds.right - bounds.left)}px`;
    style.height = `${Math.max(1, bounds.bottom - bounds.top)}px`;
  }

  private beginSelection(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const start = this.pagePoint(event, rect);
    const bounds = this.selection?.bounds;
    // Give even a single dot a finger-sized grab target in screen coordinates.
    const margin = (event.pointerType === "touch" ? 12 : 4) * this.width / Math.max(1, rect.width);
    const moving = bounds && start.x >= bounds.left - margin && start.x <= bounds.right + margin &&
      start.y >= bounds.top - margin && start.y <= bounds.bottom + margin;
    this.selectionDrag = { kind: moving ? "move" : "box", pointerID: event.pointerId,
      pointerType: event.pointerType, rect, start, current: start };
    if (moving && this.selection) {
      // Rasterize the selected ink once. While dragging, only this transparent
      // layer moves; the underlying page retains its paper, images and other ink.
      this.renderStatic();
      for (const stroke of this.strokes) if (this.selection.ids.has(stroke.id)) drawInkStroke(this.context, stroke);
      this.canvas.style.cursor = "grabbing";
    }
    this.moveSelection(event);
  }

  private moveSelection(event: PointerEvent): void {
    const drag = this.selectionDrag!;
    const point = this.pagePoint(event, drag.rect);
    if (drag.kind === "move" && this.selection) {
      const b = this.selection.bounds;
      const x = clamp(point.x - drag.start.x, -b.left, this.width - b.right);
      const y = clamp(point.y - drag.start.y, -b.top, this.height - b.bottom);
      drag.current = { x: drag.start.x + x, y: drag.start.y + y };
      this.canvas.style.transform = `translate(${x}px, ${y}px)`;
      this.showSelectionBox(offsetInkRect(b, x, y));
    } else {
      drag.current = point;
      this.showSelectionBox(this.dragRect(drag));
    }
  }

  private dragRect({ start, current }: SelectionDrag): InkRect {
    return { left: Math.min(start.x, current.x), right: Math.max(start.x, current.x),
      top: Math.min(start.y, current.y), bottom: Math.max(start.y, current.y) };
  }

  private finishSelection(event: PointerEvent): void {
    // A Pencil lift may contain the last contact followed by an off-paper hover.
    const sample = event.pointerType === "pen" && event.pressure === 0
      ? coalescedSamples(event).filter(sample => sample.pressure > 0 || sample.buttons > 0).at(-1)
      : event;
    if (sample) this.moveSelection(sample);
    const drag = this.selectionDrag!;
    this.selectionDrag = null;
    if (drag.kind === "box") {
      const box = this.dragRect(drag);
      this.setSelection(selectInk(this.strokes, this.width, this.height, (_, b) =>
        b.left >= box.left && b.top >= box.top && b.right <= box.right && b.bottom <= box.bottom));
    } else if (this.selection) {
      const x = drag.current.x - drag.start.x;
      const y = drag.current.y - drag.start.y;
      if (x || y) {
        const { ids, bounds } = this.selection;
        this.pushUndo(this.strokes);
        this.redoStack = [];
        this.strokes = this.strokes.map(stroke => ids.has(stroke.id) ? { ...stroke,
          points: stroke.points.map(p => ({ ...p, x: p.x + x, y: p.y + y })) } : stroke);
        this.setSelection({ ids, bounds: offsetInkRect(bounds, x, y) });
      }
      this.endMovePreview();
      if (x || y) this.callbacks.onChange(cloneStrokes(this.strokes));
    }
    if (this.resizePending) this.handleResize();
  }

  private cancelSelectionDrag(): void {
    if (!this.selectionDrag) return;
    const moving = this.selectionDrag.kind === "move";
    this.selectionDrag = null;
    if (moving) this.endMovePreview();
    this.showSelectionBox(this.selection?.bounds);
    if (this.resizePending) this.handleResize();
  }

  private endMovePreview(): void {
    this.canvas.style.removeProperty("transform");
    this.canvas.style.cursor = "crosshair";
    this.context.clearRect(0, 0, this.width, this.height);
    this.renderStatic();
  }

  private pagePoint(event: PointerEvent, rect = this.canvas.getBoundingClientRect()): { x: number; y: number } {
    return {
      x: clamp((event.clientX - rect.left) * this.width / Math.max(1, rect.width), 0, this.width),
      y: clamp((event.clientY - rect.top) * this.height / Math.max(1, rect.height), 0, this.height),
    };
  }

  private zoomTo(next: number, anchor: TouchPointer, previousAnchor = anchor): void {
    const world = worldPointAt(previousAnchor, this.scale, this.offsetX, this.offsetY);
    const nextScale = clamp(finite(next) ? next : this.scale, this.minimumScale, this.maximumScale);
    this.fitMode = "custom";
    this.applyTransform(nextScale, offsetAtAnchor(world, nextScale, anchor), true);
  }

  private updateTransform(): void {
    if (this.navigationMode !== "paged") this.offsetX = this.offsetY = 0;
    this.paper.style.transform = `translate3d(${this.offsetX}px, ${this.offsetY}px, 0) scale(${this.scale})`;
  }

  private render(): void {
    this.renderStatic();
    this.renderVisible();
  }

  private renderStatic(): void {
    const ctx = this.staticContext;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    renderPaperBackground(ctx, this.width, this.height, this.background);
    for (const image of this.images) {
      const cached = this.ensureImage(image);
      if (!cached?.ready) continue;
      try { ctx.drawImage(cached.element, image.x, image.y, image.width, image.height); } catch { /* an image can be invalidated while loading */ }
    }
    drawPageText(ctx, this.text, this.width, this.height);
    const moving = this.selectionDrag?.kind === "move" ? this.selection?.ids : undefined;
    for (const stroke of this.strokes) if (!moving?.has(stroke.id)) drawInkStroke(ctx, stroke);
    ctx.restore();
  }

  private replaceImages(images: readonly CanvasImage[]): void {
    const next = normalizeCanvasImages(images);
    this.images = next;
    const activeIDs = new Set(next.map((image) => image.id));
    for (const [imageID] of this.imageCache) {
      if (!activeIDs.has(imageID)) this.imageCache.delete(imageID);
    }
  }

  private ensureImage(image: CanvasImage): CachedImage | null {
    const current = this.imageCache.get(image.id);
    if (current?.src === image.src) return current;
    if (typeof Image === "undefined") return null;
    const element = new Image();
    const cached: CachedImage = { src: image.src, element, ready: false, failed: false };
    element.onload = (): void => {
      cached.ready = true;
      if (this.imageCache.get(image.id) === cached) this.render();
    };
    element.onerror = (): void => {
      cached.failed = true;
    };
    this.imageCache.set(image.id, cached);
    element.src = image.src;
    if (element.complete && element.naturalWidth > 0) cached.ready = true;
    return cached;
  }

  private renderVisible(): void {
    this.context.save();
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const bounds = this.visibleInkBounds;
    if (bounds) {
      const { left, top, right, bottom, padding } = bounds;
      this.context.clearRect(left - padding, top - padding, right - left + 2 * padding, bottom - top + 2 * padding);
    }
    if (this.active) this.renderStroke(this.context, this.active.stroke);
    this.visibleInkBounds = this.active?.bounds ?? null;
    this.renderedPointCount = this.active?.stroke.points.length ?? 0;
    this.context.restore();
  }

  private scheduleActiveRender(): void {
    if (this.activeFrame !== null) return;
    this.activeFrame = requestAnimationFrame(() => {
      this.activeFrame = null;
      const active = this.active;
      const stroke = active?.stroke;
      if (stroke && (stroke.color >>> 24) === 255 && this.tool.kind !== "line") {
        // Every segment depends on its incoming direction and its measured
        // endpoints, so drawing more samples cannot move earlier segments.
        if (stroke.points.length > this.renderedPointCount) {
          this.renderStroke(this.context, stroke, this.renderedPointCount);
          this.renderedPointCount = stroke.points.length;
          this.visibleInkBounds = active.bounds;
        }
      } else this.renderVisible();
    });
  }

  private renderStroke(context: CanvasRenderingContext2D, stroke: InkStroke, rendered = 0): void {
    drawInkStroke(context, stroke, rendered);
  }
}

function drawPagePreview(canvas: HTMLCanvasElement, state: PreviewState): void {
  const scale = Math.min(1, state.maxWidth / state.width);
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.max(1, Math.round(state.width * scale * dpr));
  canvas.height = Math.max(1, Math.round(state.height * scale * dpr));
  canvas.style.aspectRatio = `${state.width} / ${state.height}`;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.save();
  context.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  renderPaperBackground(context, state.width, state.height, state.background);
  for (const image of state.images) {
    const cached = ensurePreviewImage(canvas, state, image);
    if (!cached?.ready) continue;
    try { context.drawImage(cached.element, image.x, image.y, image.width, image.height); } catch { /* An image may be invalidated while loading. */ }
  }
  drawPageText(context, state.text ?? "", state.width, state.height);
  for (const stroke of state.strokes) drawInkStroke(context, stroke);
  context.restore();
}

function ensurePreviewImage(canvas: HTMLCanvasElement, state: PreviewState, image: CanvasImage): CachedImage | null {
  const current = state.imageCache.get(image.id);
  if (current?.src === image.src) return current;
  if (typeof Image === "undefined") return null;
  const element = new Image();
  const cached: CachedImage = { src: image.src, element, ready: false, failed: false };
  element.onload = (): void => {
    cached.ready = true;
    if (state.imageCache.get(image.id) === cached && previewStates.get(canvas) === state) drawPagePreview(canvas, state);
  };
  element.onerror = (): void => { cached.failed = true; };
  state.imageCache.set(image.id, cached);
  element.src = image.src;
  if (element.complete && element.naturalWidth > 0) cached.ready = true;
  return cached;
}

export function renderPaperBackground(context: CanvasRenderingContext2D, width: number, height: number, background: PageBackground): void {
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#fffdf7";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = background === "grid" ? "rgba(125, 106, 82, .16)" : "rgba(176, 82, 59, .16)";
  context.lineWidth = 1;
  const spacing = 36;
  if (background === "ruled") {
    for (let y = spacing; y < height; y += spacing) {
      context.beginPath(); context.moveTo(0, y + 0.5); context.lineTo(width, y + 0.5); context.stroke();
    }
  } else if (background === "grid") {
    for (let x = spacing; x < width; x += spacing) {
      context.beginPath(); context.moveTo(x + 0.5, 0); context.lineTo(x + 0.5, height); context.stroke();
    }
    for (let y = spacing; y < height; y += spacing) {
      context.beginPath(); context.moveTo(0, y + 0.5); context.lineTo(width, y + 0.5); context.stroke();
    }
  }
}

export function drawPageText(context: CanvasRenderingContext2D, text: string, width: number, height: number): void {
  const canvas = context.canvas;
  if (!text) {
    paperTextLayouts.delete(canvas);
    return;
  }
  context.save();
  context.fillStyle = "#252429";
  context.font = "24px system-ui, sans-serif";
  context.textBaseline = "top";
  const fontMetrics = [context.font, context.direction, context.fontKerning, context.fontStretch,
    context.fontVariantCaps, context.letterSpacing, context.wordSpacing, context.textRendering].join("|");
  let layout = paperTextLayouts.get(canvas);
  if (!layout || layout.text !== text || layout.width !== width || layout.height !== height || layout.fontMetrics !== fontMetrics) {
    layout = { text, width, height, fontMetrics, lines: wrapPageText(context, text, width, height) };
    paperTextLayouts.set(canvas, layout);
  }
  layout.lines.forEach((line, index) => context.fillText(line, 32, 32 + index * 34));
  context.restore();
}

function wrapPageText(context: CanvasRenderingContext2D, text: string, width: number, height: number): string[] {
  const lines: string[] = [];
  let y = 32;
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const char of paragraph) {
      if (line && context.measureText(line + char).width > width - 64) {
        lines.push(line);
        y += 34;
        line = "";
        if (y > height - 32) break;
      }
      line += char;
    }
    if (y > height - 32) break;
    lines.push(line);
    y += 34;
  }
  return lines;
}

/** Await every image for deterministic exports, using the same layer order as the editor. */
export async function renderPageExport(page: CanvasPreviewPage): Promise<HTMLCanvasElement> {
  await document.fonts?.ready;
  const canvas = document.createElement("canvas");
  const scale = Math.min(2, 2400 / Math.max(page.width, page.height));
  canvas.width = Math.max(1, Math.round(page.width * scale));
  canvas.height = Math.max(1, Math.round(page.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Cannot export this page in this browser.");
  context.scale(scale, scale);
  renderPaperBackground(context, page.width, page.height, page.background);
  for (const image of page.images ?? []) {
    const element = new Image();
    await new Promise<void>((resolve, reject) => {
      element.onload = () => resolve();
      element.onerror = () => reject(new Error("A page image could not be loaded. Export stopped to avoid missing content."));
      element.src = image.src;
    });
    context.drawImage(element, image.x, image.y, image.width, image.height);
  }
  drawPageText(context, page.text ?? "", page.width, page.height);
  for (const stroke of page.strokes) drawInkStroke(context, stroke);
  return canvas;
}

export function drawInkStroke(context: CanvasRenderingContext2D, stroke: InkStroke, rendered = 0): void {
  const points = stroke.points;
  const color = stroke.color >>> 0;
  const alpha = ((color >>> 24) & 0xff) / 255;
  context.strokeStyle = `rgba(${(color >>> 16) & 0xff}, ${(color >>> 8) & 0xff}, ${color & 0xff}, ${alpha})`;
  context.fillStyle = context.strokeStyle;
  context.lineCap = "round";
  context.lineJoin = "round";
  if (points.length === 0) return;
  if (rendered === 0 && (points.length === 1 || alpha === 1)) {
    const point = points[0]!;
    context.beginPath();
    context.arc(point.x, point.y, Math.max(0.25, stroke.width * (0.65 + point.pressure * 0.35) / 2), 0, Math.PI * 2);
    context.fill();
  }
  if (points.length === 1) return;
  // One path gives translucent ink uniform opacity at segment joins.
  // ARGB is already part of the archive and sync format; no schema change.
  if (alpha < 1) {
    context.lineWidth = stroke.width;
    context.beginPath();
    context.moveTo(points[0]!.x, points[0]!.y);
    for (let index = 1; index < points.length; index += 1) appendInkSegment(context, points, index);
    context.stroke();
    return;
  }
  for (let index = Math.max(1, rendered); index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    context.lineWidth = Math.max(0.5, stroke.width * (0.65 + ((from.pressure + to.pressure) / 2) * 0.35));
    context.beginPath();
    context.moveTo(from.x, from.y);
    appendInkSegment(context, points, index);
    context.stroke();
  }
}

function appendInkSegment(context: CanvasRenderingContext2D, points: readonly StrokePoint[], index: number): void {
  const from = points[index - 1]!;
  const to = points[index]!;
  const before = points[index - 2];
  if (before) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const incomingX = from.x - before.x;
    const incomingY = from.y - before.y;
    // Soften a bend while keeping each measured point fixed and preserving
    // deliberate sharp corners and direction reversals.
    if (incomingX * dx + incomingY * dy > 0 && incomingX * dy !== incomingY * dx) {
      const incoming = Math.hypot(incomingX, incomingY);
      const reach = Math.min(1, Math.hypot(dx, dy) / incoming) / 3;
      const controlX = clamp(from.x + incomingX * reach, Math.min(before.x, from.x, to.x), Math.max(before.x, from.x, to.x));
      const controlY = clamp(from.y + incomingY * reach, Math.min(before.y, from.y, to.y), Math.max(before.y, from.y, to.y));
      context.bezierCurveTo(controlX, controlY, to.x - dx / 3, to.y - dy / 3, to.x, to.y);
      return;
    }
  }
  context.lineTo(to.x, to.y);
}

const CANVAS_CHROME_SELECTOR = ".library, .topbar, .editor-toolbar, .page-bar, .stage-foot, .sidebar, .drawer-backdrop, .inspector, .dialog, .paper-viewport, .paper-scroll, .page-flow, .flow-page, .paper, #ink-canvas, canvas";
const TEXT_SELECTION_SELECTOR = "input, textarea, select, [contenteditable]:not([contenteditable=\"false\"])";

function isCanvasChromeTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(CANVAS_CHROME_SELECTOR) !== null;
}

function isTextSelectionTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TEXT_SELECTION_SELECTOR) !== null;
}

function normalizeCanvasImages(images: readonly CanvasImage[]): CanvasImage[] {
  return images.filter((image) => (
    typeof image.id === "string" && image.id.length > 0
    && typeof image.src === "string" && image.src.length > 0
    && [image.x, image.y, image.width, image.height].every(finite)
    && image.width > 0 && image.height > 0
  )).map((image) => ({ ...image }));
}

function cloneStrokes(strokes: InkStroke[]): InkStroke[] {
  return strokes.map((stroke) => ({ ...stroke, points: stroke.points.map((point) => ({ ...point })) }));
}

function historyPointCount(strokes: InkStroke[]): number {
  return strokes.reduce((total, stroke) => total + stroke.points.length, 0);
}

function historyStackPointCount(history: InkStroke[][]): number {
  return history.reduce((total, snapshot) => total + historyPointCount(snapshot), 0);
}

function strokeHit(stroke: InkStroke, point: { x: number; y: number }, radius: number): boolean {
  if (stroke.points.length === 0) return false;
  if (stroke.points.length === 1) return Math.hypot(stroke.points[0]!.x - point.x, stroke.points[0]!.y - point.y) <= radius;
  for (let index = 1; index < stroke.points.length; index += 1) {
    if (segmentDistance(point, stroke.points[index - 1]!, stroke.points[index]!) <= radius + stroke.width) return true;
  }
  return false;
}

function segmentDistance(point: { x: number; y: number }, first: StrokePoint, second: StrokePoint): number {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - first.x, point.y - first.y);
  const t = clamp(((point.x - first.x) * dx + (point.y - first.y) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(point.x - (first.x + t * dx), point.y - (first.y + t * dy));
}

function distance(first: TouchPointer, second: TouchPointer): number { return Math.hypot(first.x - second.x, first.y - second.y); }
function midpoint(first: TouchPointer, second: TouchPointer): TouchPointer { return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }; }
function finite(value: number): boolean { return Number.isFinite(value); }
function isStalePointerEvent(event: PointerEvent, startedAt: number): boolean {
  // Zero is a valid value on some WebKit PointerEvents. It cannot establish
  // that a reused-ID event is older, so let the lifecycle event close input.
  return finite(event.timeStamp) && event.timeStamp > 0 && startedAt > 0 && event.timeStamp < startedAt;
}
function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
function coalescedSamples(event: PointerEvent): PointerEvent[] {
  try { return event.getCoalescedEvents?.() ?? []; }
  catch { return []; } // Some browsers reject the request after releasing capture.
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
