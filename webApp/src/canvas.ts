import { InkStroke, PageBackground, StrokePoint, id } from "./models";

export type CanvasTool =
  | { kind: "pen" | "highlighter" | "line"; color: number; width: number; pressureSensitive?: boolean }
  | { kind: "eraser"; width: number }
  | { kind: "hand" };

export type CanvasNavigationMode = "continuous" | "horizontal" | "paged";

interface ActiveStroke {
  pointerID: number;
  stroke: InkStroke;
  startedAt: number;
}

export interface CanvasPoint { x: number; y: number; }

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
  onZoom: (scale: number) => void;
}

const previewStates = new WeakMap<HTMLCanvasElement, PreviewState>();

export function clearPagePreview(canvas: HTMLCanvasElement): void {
  previewStates.delete(canvas);
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
  /** The outer flow container used for one-finger continuous/book scrolling. */
  private scrollViewport: HTMLElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly staticCanvas: HTMLCanvasElement;
  private readonly staticContext: CanvasRenderingContext2D;
  private readonly callbacks: CanvasCallbacks;
  private strokes: InkStroke[] = [];
  private background: PageBackground = "blank";
  private text = "";
  private width = 1024;
  private height = 1366;
  private tool: CanvasTool = { kind: "pen", color: 0xff252429, width: 2.5 };
  private active: ActiveStroke | null = null;
  private eraserBefore: InkStroke[] | null = null;
  private eraserPointerID: number | null = null;
  private renderedPointCount = 0;
  private touchPointers = new Map<number, TouchPointer>();
  /** Some browsers can lose capture before dispatching the matching pointerup. */
  private lostCapturePointers = new Set<number>();
  /** Pen hover/contact takes priority over touch navigation on writing tools. */
  private penPointers = new Set<number>();
  private panLast: TouchPointer | null = null;
  private scrollLast: TouchPointer | null = null;
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
    const staticContext = this.staticCanvas.getContext("2d");
    if (!staticContext) throw new Error("This browser cannot create an off-screen canvas.");
    this.staticContext = staticContext;
    // The canvas owns all touch gestures. This also prevents browser navigation
    // and native page scrolling from stealing a pen/pinch sequence.
    this.updateTouchAction();
    this.canvas.addEventListener("touchmove", this.handleNativeTouchMove, { passive: false });
    this.canvas.addEventListener("pointerdown", this.handlePointerDown, { passive: false });
    this.canvas.addEventListener("pointermove", this.handlePointerMove, { passive: false });
    this.canvas.addEventListener("pointerup", this.handlePointerUp, { passive: false });
    this.canvas.addEventListener("pointercancel", this.handlePointerCancel, { passive: false });
    this.canvas.addEventListener("lostpointercapture", this.handleLostPointerCapture);
    document.addEventListener("pointerup", this.handleDocumentPointerUp, { passive: false });
    document.addEventListener("pointercancel", this.handleDocumentPointerCancel, { passive: false });
    this.canvas.addEventListener("pointerover", this.handlePenPresence);
    this.canvas.addEventListener("pointerenter", this.handlePenPresence);
    this.canvas.addEventListener("pointerout", this.handlePointerOut);
    this.canvas.addEventListener("pointerleave", this.handlePointerOut);
    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
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
    if (dimensionsChanged || this.canvas.width !== Math.round(width * this.dpr)) this.resizeCanvas(false);
    this.setStrokes(strokes, newPage, false);
    if (firstPage || this.needsFit || (dimensionsChanged && this.navigationMode === "paged")) {
      this.needsFit = false;
      this.fitToWidth();
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

  /** Route one-finger flow touches to the surrounding scroll container. */
  setNavigationMode(mode: CanvasNavigationMode, scrollViewport?: HTMLElement): void {
    if (this.navigationMode === mode && (!scrollViewport || this.scrollViewport === scrollViewport)) return;
    this.navigationMode = mode;
    this.needsFit = true;
    this.stopMomentum();
    if (scrollViewport) this.scrollViewport = scrollViewport;
    this.resizeObserver?.disconnect();
    this.resizeObserver?.observe(this.navigationMode === "paged" ? this.viewport : this.scrollViewport);
    this.clearTouchNavigation();
    this.updateTouchAction();
  }

  setStrokes(strokes: InkStroke[], resetHistory = false, render = true): void {
    this.strokes = cloneStrokes(strokes);
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
    this.tool = tool;
    this.canvas.style.cursor = tool.kind === "hand" ? "grab" : "crosshair";
  }

  get currentScale(): number { return this.scale; }
  /** True while a stroke, erase gesture, or intentional touch navigation is active. */
  get isInputActive(): boolean {
    return this.active !== null || this.eraserBefore !== null || ((this.tool.kind === "hand" || this.navigationMode !== "paged") ? this.touchPointers.size > 0 : this.touchPointers.size >= 2);
  }
  get hasUndo(): boolean { return this.undoStack.length > 0; }
  get hasRedo(): boolean { return this.redoStack.length > 0; }

  undo(): void {
    if (this.isInputActive || this.tool.kind === "hand") return;
    const previous = this.undoStack.pop();
    if (!previous) return;
    if (historyPointCount(this.strokes) <= MAX_HISTORY_POINTS) this.redoStack.push(cloneStrokes(this.strokes));
    this.trimHistory();
    this.strokes = cloneStrokes(previous);
    this.render();
    this.callbacks.onChange(cloneStrokes(this.strokes));
  }

  redo(): void {
    if (this.isInputActive || this.tool.kind === "hand") return;
    const next = this.redoStack.pop();
    if (!next) return;
    if (historyPointCount(this.strokes) <= MAX_HISTORY_POINTS) this.undoStack.push(cloneStrokes(this.strokes));
    this.trimHistory();
    this.strokes = cloneStrokes(next);
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
      if (width > 0) this.applyTransform(width / this.width, { x: 0, y: 0 }, true);
      return;
    }
    const rect = this.viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
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
    window.removeEventListener("resize", this.handleResize);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvas.removeEventListener("touchmove", this.handleNativeTouchMove);
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerCancel);
    this.canvas.removeEventListener("lostpointercapture", this.handleLostPointerCapture);
    document.removeEventListener("pointerup", this.handleDocumentPointerUp);
    document.removeEventListener("pointercancel", this.handleDocumentPointerCancel);
    this.canvas.removeEventListener("pointerover", this.handlePenPresence);
    this.canvas.removeEventListener("pointerenter", this.handlePenPresence);
    this.canvas.removeEventListener("pointerout", this.handlePointerOut);
    this.canvas.removeEventListener("pointerleave", this.handlePointerOut);
    this.canvas.removeEventListener("wheel", this.handleWheel);
    document.removeEventListener("contextmenu", this.handleContextMenu);
    document.removeEventListener("selectstart", this.handleSelectStart);
    window.removeEventListener("blur", this.handleWindowBlur);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
  }

  private readonly handleResize = (): void => {
    if (this.navigationMode !== "paged") {
      if (this.dpr !== this.rasterScale()) this.resizeCanvas();
      if (this.pageKey && this.fitMode === "width") this.fitToWidth();
      else if (this.pageKey && this.fitMode === "page") this.fitToPage();
      return;
    }
    const currentRect = this.viewport.getBoundingClientRect();
    if (this.lastViewportSize?.width === currentRect.width && this.lastViewportSize?.height === currentRect.height && this.dpr === this.rasterScale()) return;
    const previousSize = this.lastViewportSize ?? { width: currentRect.width, height: currentRect.height };
    const previousCenter = { x: previousSize.width / 2, y: previousSize.height / 2 };
    const previousWorld = worldPointAt(previousCenter, this.scale, this.offsetX, this.offsetY);
    if (this.dpr !== this.rasterScale()) this.resizeCanvas(false);
    const nextRect = this.viewport.getBoundingClientRect();
    if (this.pageKey && nextRect.width > 0 && nextRect.height > 0 && this.fitMode === "width") {
      this.fitToWidth();
      this.rebaseTouchGesture();
    } else if (this.pageKey && nextRect.width > 0 && nextRect.height > 0 && this.fitMode === "page") {
      this.fitToPage();
      this.rebaseTouchGesture();
    } else if (this.pageKey && previousSize.width > 0 && previousSize.height > 0 && nextRect.width > 0 && nextRect.height > 0) {
      const nextOffset = offsetAtAnchor(previousWorld, this.scale, { x: nextRect.width / 2, y: nextRect.height / 2 });
      const gutter = viewportGutter(nextRect.width);
      const bounded = clampPan(
        nextOffset.x,
        nextOffset.y,
        this.width,
        this.height,
        this.scale,
        nextRect.width,
        nextRect.height,
        gutter,
      );
      this.offsetX = bounded.x;
      this.offsetY = bounded.y;
      this.updateTransform();
      this.rebaseTouchGesture();
    }
    this.render();
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

  private resizeCanvas(render = true): void {
    this.dpr = this.rasterScale();
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.staticCanvas.width = this.canvas.width;
    this.staticCanvas.height = this.canvas.height;
    this.staticContext.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (render) this.renderStatic();
  }

  // WebKit/Scribble can swallow rapid Pencil contacts before pointerdown.
  // A non-passive touchmove listener is a reported workaround even with
  // touch-action:none and pointer-event preventDefault already in place:
  // https://mikepk.com/2020/10/iOS-safari-scribble-bug/
  // Keep this on the active canvas: Pointer Events own its ink/pan/pinch,
  // while neighbouring page previews still need native finger scrolling.
  // This does not disable Scribble or recover events the OS never dispatches.
  private readonly handleNativeTouchMove = (event: TouchEvent): void => {
    if (event.cancelable) event.preventDefault();
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    this.stopMomentum();
    event.preventDefault();
    this.markPenPointer(event);
    // A reused pointer ID is a fresh contact boundary even when Safari omitted
    // both pointerup and lostpointercapture for the previous contact. Commit
    // that partial stroke before accepting the new down. A different pen ID
    // cannot safely terminate the current contact, so leave it alone.
    const samePointerContact = this.active && event.pointerType !== "touch" && event.pointerId === this.active.pointerID;
    const previousCaptureLost = this.active && this.lostCapturePointers.has(this.active.pointerID);
    if (this.active && this.tool.kind !== "hand" && (samePointerContact || previousCaptureLost)) this.commitActiveStroke();
    if (event.pointerType === "touch" || this.tool.kind === "hand") {
      if (this.active || this.eraserBefore) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (event.pointerType === "touch" && this.tool.kind !== "hand" && this.penPointers.size > 0) return;
      this.touchPointers.set(event.pointerId, this.touchPoint(event));
      this.scrollLast = { x: event.clientX, y: event.clientY };
      this.scrollTime = performance.now();
      this.scrollVelocity = 0;
      this.capturePointer(event.pointerId);
      this.rebaseTouchGesture();
      return;
    }
    if (event.pointerType !== "pen" && event.pointerType !== "mouse") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (this.active || this.eraserBefore) return;
    this.touchPointers.clear();
    this.panLast = null;
    this.pinchStart = null;
    this.capturePointer(event.pointerId);
    if (this.tool.kind === "eraser") {
      this.eraserBefore = cloneStrokes(this.strokes);
      this.eraserPointerID = event.pointerId;
      this.eraseAt(this.pagePoint(event));
      return;
    }
    const timestamp = finite(event.timeStamp) ? event.timeStamp : performance.now();
    this.renderedPointCount = 0;
    this.active = {
      pointerID: event.pointerId,
      startedAt: timestamp,
      stroke: { id: id(), color: this.tool.kind === "highlighter" ? ((this.tool.color & 0xffffff) | 0x50000000) >>> 0 : this.tool.color >>> 0, width: this.tool.width, points: [] },
    };
    this.addPoints(event);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    event.preventDefault();
    this.markPenPointer(event);
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
    if (event.pointerType === "touch" || this.touchPointers.has(event.pointerId)) {
      if (this.active || this.eraserBefore) return;
      if (!this.touchPointers.has(event.pointerId)) return;
      this.touchPointers.set(event.pointerId, this.touchPoint(event));
      const values = [...this.touchPointers.values()];
      if (values.length >= 2) {
        if (!this.pinchStart) this.beginPinch();
        this.updatePinch();
      } else if (values.length === 1 && this.navigationMode !== "paged") {
        this.scrollWithTouch({ x: event.clientX, y: event.clientY });
      } else if (values.length === 1 && this.tool.kind === "hand" && this.panLast) {
        const point = values[0]!;
        this.offsetX += point.x - this.panLast.x;
        this.offsetY += point.y - this.panLast.y;
        this.panLast = point;
        this.applyPan();
      }
      return;
    }
    if (this.eraserPointerID === event.pointerId) this.eraseAt(this.pagePoint(event));
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    event.preventDefault();
    if (this.active?.pointerID === event.pointerId && isStalePointerEvent(event, this.active.startedAt)) return;
    if (this.active?.pointerID === event.pointerId) {
      this.addPoints(event);
      this.commitActiveStroke();
      return;
    }
    const penPointer = event.pointerType === "pen" || this.penPointers.has(event.pointerId);
    if (penPointer) this.penPointers.delete(event.pointerId);
    this.lostCapturePointers.delete(event.pointerId);
    if (event.pointerType === "touch" || this.touchPointers.has(event.pointerId)) {
      if (this.active || this.eraserBefore) return;
      if (this.touchPointers.size === 1 && this.navigationMode !== "paged" && performance.now() - this.scrollTime < 100) this.startMomentum();
      this.endTouchPointer(event.pointerId);
      return;
    }
    if (this.tool.kind === "eraser") {
      if (this.eraserPointerID !== event.pointerId) return;
      this.eraseAt(this.pagePoint(event));
      if (this.eraserBefore && !sameStrokes(this.eraserBefore, this.strokes)) {
        this.pushUndo(this.eraserBefore);
        this.redoStack = [];
        this.callbacks.onChange(cloneStrokes(this.strokes));
      }
      this.eraserBefore = null;
      this.eraserPointerID = null;
      this.render();
      return;
    }
  };

  private readonly handlePointerCancel = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    if (this.active?.pointerID === pointerEvent.pointerId && isStalePointerEvent(pointerEvent, this.active.startedAt)) return;
    if (this.active?.pointerID === pointerEvent.pointerId) {
      this.cancelActiveInput(true, true);
      return;
    }
    const penPointer = pointerEvent.pointerType === "pen" || this.penPointers.has(pointerEvent.pointerId);
    if (penPointer) this.penPointers.delete(pointerEvent.pointerId);
    if (this.touchPointers.has(pointerEvent.pointerId) || pointerEvent.pointerType === "touch") {
      this.endTouchPointer(pointerEvent.pointerId);
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
    if (this.active?.pointerID === pointerEvent.pointerId && isStalePointerEvent(pointerEvent, this.active.startedAt)) return;
    if (this.active?.pointerID === pointerEvent.pointerId) {
      this.lostCapturePointers.add(pointerEvent.pointerId);
      return;
    }
    if (this.touchPointers.has(pointerEvent.pointerId) || pointerEvent.pointerType === "touch") {
      this.endTouchPointer(pointerEvent.pointerId);
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
    return this.active?.pointerID === pointerID || this.eraserPointerID === pointerID || this.touchPointers.has(pointerID);
  }

  private readonly handlePointerOut = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    if (this.penPointers.has(pointerEvent.pointerId) && this.active?.pointerID !== pointerEvent.pointerId) this.penPointers.delete(pointerEvent.pointerId);
  };

  private readonly handlePenPresence = (event: Event): void => { this.markPenPointer(event as PointerEvent); };

  private readonly handleWindowBlur = (): void => { this.cancelActiveInput(true, true); };

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") this.cancelActiveInput(true, true);
  };

  private readonly handleContextMenu = (event: MouseEvent): void => {
    if (this.canvas.isConnected && isCanvasChromeTarget(event.target) && !isTextSelectionTarget(event.target)) event.preventDefault();
  };

  private readonly handleSelectStart = (event: Event): void => {
    if (this.canvas.isConnected && isCanvasChromeTarget(event.target) && !isTextSelectionTarget(event.target)) event.preventDefault();
  };

  private markPenPointer(event: PointerEvent): void {
    if (event.pointerType !== "pen") return;
    this.penPointers.add(event.pointerId);
    if (this.tool.kind !== "hand") this.blockTouchNavigation();
  }

  private updateTouchAction(): void {
    // Keep capture deterministic for Pencil input. In flow modes one-finger
    // touch deltas are forwarded to the scroll container below instead of
    // relying on browser-specific touch-action negotiation.
    this.viewport.style.touchAction = "none";
    this.paper.style.touchAction = "none";
    this.canvas.style.touchAction = "none";
  }

  private clearTouchNavigation(): void {
    const pointers = [...this.touchPointers.keys()];
    this.touchPointers.clear();
    this.panLast = null;
    this.pinchStart = null;
    for (const pointerID of pointers) {
      try { this.canvas.releasePointerCapture(pointerID); } catch { /* capture may already be gone */ }
    }
  }

  private blockTouchNavigation(): void {
    if (this.tool.kind === "hand") return;
    const pointers = [...this.touchPointers.keys()];
    this.touchPointers.clear();
    this.panLast = null;
    this.pinchStart = null;
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

  private rebaseTouchGesture(): void {
    if (this.touchPointers.size === 0) {
      this.panLast = null;
      this.pinchStart = null;
    } else if (this.touchPointers.size === 1) {
      this.panLast = [...this.touchPointers.values()][0] ?? null;
      this.pinchStart = null;
    } else {
      this.panLast = null;
      this.beginPinch();
    }
  }

  private beginPinch(): void {
    const [first, second] = [...this.touchPointers.values()].slice(0, 2);
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
    const [first, second] = [...this.touchPointers.values()].slice(0, 2);
    if (!start || !first || !second) return;
    const nextCenter = midpoint(first, second);
    const nextDistance = Math.max(1, distance(first, second));
    const world = worldPointAt(start.center, start.scale, start.offsetX, start.offsetY);
    const nextScale = clamp(start.scale * (nextDistance / start.distance), this.minimumScale, this.maximumScale);
    const nextOffset = offsetAtAnchor(world, nextScale, nextCenter);
    if (this.navigationMode !== "paged") {
      const rect = this.viewport.getBoundingClientRect();
      nextOffset.x -= rect.left;
      nextOffset.y -= rect.top;
    }
    this.fitMode = "custom";
    this.applyTransform(nextScale, nextOffset, true);
  }

  private endTouchPointer(pointerID: number): void {
    if (!this.touchPointers.delete(pointerID)) return;
    this.scrollLast = null;
    this.rebaseTouchGesture();
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

  private scrollWithTouch(point: TouchPointer): void {
    const previous = this.scrollLast;
    this.scrollLast = point;
    if (!previous) return;
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
      this.scrollViewport.scrollLeft += nextRect.left - rect.left - nextOffset.x;
      this.scrollViewport.scrollTop += nextRect.top - rect.top - nextOffset.y;
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
    this.updateTransform();
    if (notifyZoom) this.callbacks.onZoom(this.scale);
  }

  private cancelActiveInput(render = true, preserveActiveStroke = false): void {
    const pointers = [...this.touchPointers.keys()];
    if (this.active) pointers.push(this.active.pointerID);
    if (this.eraserPointerID !== null) pointers.push(this.eraserPointerID);
    const active = this.active;
    this.active = null;
    this.lostCapturePointers.clear();
    if (this.eraserBefore) this.strokes = cloneStrokes(this.eraserBefore);
    this.eraserBefore = null;
    this.eraserPointerID = null;
    this.touchPointers.clear();
    this.penPointers.clear();
    this.panLast = null;
    this.pinchStart = null;
    for (const pointerID of pointers) {
      try { this.canvas.releasePointerCapture(pointerID); } catch { /* capture may already be gone */ }
    }
    if (this.activeFrame !== null) {
      cancelAnimationFrame(this.activeFrame);
      this.activeFrame = null;
    }
    if (preserveActiveStroke && active?.stroke.points.length) this.commitActiveStroke(active);
    if (render) this.render();
  }

  private pushUndo(snapshot: InkStroke[]): void {
    // Every entry is a full page snapshot. Cap both entry count and retained
    // points so a large note cannot multiply its memory footprint on undo.
    if (historyPointCount(snapshot) > MAX_HISTORY_POINTS) {
      this.undoStack = [];
      this.redoStack = [];
      return;
    }
    this.undoStack.push(cloneStrokes(snapshot));
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
    const rect = this.viewport.getBoundingClientRect();
    this.zoomTo(this.scale * (event.deltaY < 0 ? 1.08 : 0.92), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  private addPoints(event: PointerEvent, includeCurrent = true): void {
    if (!this.active) return;
    let coalesced: PointerEvent[] = [];
    if (typeof event.getCoalescedEvents === "function") {
      try { coalesced = event.getCoalescedEvents(); } catch { /* A browser can reject after capture changes. */ }
    }
    // getCoalescedEvents contains historical samples; the dispatched event is
    // the newest sample and must be retained for fast Pencil strokes.
    const events = coalesced.length > 0
      ? (includeCurrent ? [...coalesced, event] : coalesced)
      : (includeCurrent ? [event] : []);
    if (events.length === 0) return;
    const rect = this.canvas.getBoundingClientRect();
    for (const sample of events) {
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
        tiltX: finite(sample.tiltX) ? roundTo(sample.tiltX, 1) : null,
        tiltY: finite(sample.tiltY) ? roundTo(sample.tiltY, 1) : null,
      };
      // A tap commonly arrives as a down and an up with an empty coalesced
      // array. Keep its single canonical point instead of duplicating it.
      if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) > 0.01) this.active.stroke.points.push(point);
      if (this.tool.kind === "line" && this.active.stroke.points.length > 2) {
        this.active.stroke.points = [this.active.stroke.points[0]!, point];
      }
    }
    this.scheduleActiveRender();
  }

  private commitActiveStroke(active = this.active): void {
    if (!active) return;
    const before = cloneStrokes(this.strokes);
    this.strokes.push(active.stroke);
    // Capture before mutating so undo restores the exact page, including a
    // single-point tap or an empty stroke.
    this.pushUndo(before);
    this.redoStack = [];
    // Commit just this stroke to the cached page, independent of page length.
    this.renderStroke(this.staticContext, active.stroke);
    if (this.active === active) this.active = null;
    this.lostCapturePointers.delete(active.pointerID);
    this.penPointers.delete(active.pointerID);
    this.renderVisible();
    this.callbacks.onChange(cloneStrokes(this.strokes));
  }

  private eraseAt(point: { x: number; y: number }): void {
    const radius = Math.max(12, this.tool.kind === "eraser" ? this.tool.width * 4 : 16);
    const kept = this.strokes.filter((stroke) => !strokeHit(stroke, point, radius));
    if (kept.length !== this.strokes.length) {
      this.strokes = kept;
      this.render();
    }
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
    const rect = this.viewport.getBoundingClientRect();
    this.lastViewportSize = { width: rect.width, height: rect.height };
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
    for (const stroke of this.strokes) drawInkStroke(ctx, stroke);
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
    this.context.clearRect(0, 0, this.width, this.height);
    this.context.drawImage(this.staticCanvas, 0, 0, this.width, this.height);
    if (this.active) this.renderStroke(this.context, this.active.stroke);
    this.renderedPointCount = this.active?.stroke.points.length ?? 0;
    this.context.restore();
  }

  private scheduleActiveRender(): void {
    if (this.activeFrame !== null) return;
    this.activeFrame = requestAnimationFrame(() => {
      this.activeFrame = null;
      const stroke = this.active?.stroke;
      if (stroke && (stroke.color >>> 24) === 255 && this.tool.kind !== "line") {
        // O(new samples) per frame for opaque ink; retain the preceding point
        // to connect the next segment without redrawing the growing stroke.
        if (stroke.points.length > this.renderedPointCount) {
          this.renderStroke(this.context, { ...stroke, points: stroke.points.slice(Math.max(0, this.renderedPointCount - 1)) });
          this.renderedPointCount = stroke.points.length;
        }
      } else this.renderVisible();
    });
  }

  private renderStroke(context: CanvasRenderingContext2D, stroke: InkStroke): void {
    drawInkStroke(context, stroke);
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
  if (!text) return;
  context.save();
  context.fillStyle = "#252429";
  context.font = "24px system-ui, sans-serif";
  context.textBaseline = "top";
  let y = 32;
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const char of paragraph) {
      if (line && context.measureText(line + char).width > width - 64) {
        context.fillText(line, 32, y); y += 34; line = "";
        if (y > height - 32) break;
      }
      line += char;
    }
    if (y > height - 32) break;
    context.fillText(line, 32, y); y += 34;
  }
  context.restore();
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

export function drawInkStroke(context: CanvasRenderingContext2D, stroke: InkStroke): void {
  const points = stroke.points;
  const color = stroke.color >>> 0;
  const alpha = ((color >>> 24) & 0xff) / 255;
  context.strokeStyle = `rgba(${(color >>> 16) & 0xff}, ${(color >>> 8) & 0xff}, ${color & 0xff}, ${alpha})`;
  context.fillStyle = context.strokeStyle;
  context.lineCap = "round";
  context.lineJoin = "round";
  if (points.length === 0) return;
  if (points.length === 1) {
    const point = points[0]!;
    context.beginPath();
    context.arc(point.x, point.y, Math.max(0.25, stroke.width * (0.65 + point.pressure * 0.35) / 2), 0, Math.PI * 2);
    context.fill();
    return;
  }
  // One path gives translucent ink uniform opacity at segment joins.
  // ARGB is already part of the archive and sync format; no schema change.
  if (alpha < 1) {
    context.lineWidth = stroke.width;
    context.beginPath();
    context.moveTo(points[0]!.x, points[0]!.y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
    return;
  }
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    context.lineWidth = Math.max(0.5, stroke.width * (0.65 + ((from.pressure + to.pressure) / 2) * 0.35));
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
  }
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

function sameStrokes(left: InkStroke[], right: InkStroke[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
