import { InkStroke, PageBackground, StrokePoint, id } from "./models";

export type CanvasTool =
  | { kind: "pen" | "highlighter" | "line"; color: number; width: number; pressureSensitive?: boolean }
  | { kind: "eraser"; width: number }
  | { kind: "hand" };

interface ActiveStroke {
  pointerID: number;
  stroke: InkStroke;
  startedAt: number;
}

export interface CanvasPoint { x: number; y: number; }

interface TouchPointer extends CanvasPoint {}

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

/** A page-coordinate Pencil/pen canvas with high-DPI rendering and touch pan. */
export class PaperCanvas {
  private readonly canvas: HTMLCanvasElement;
  private readonly paper: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly staticCanvas: HTMLCanvasElement;
  private readonly staticContext: CanvasRenderingContext2D;
  private readonly callbacks: CanvasCallbacks;
  private strokes: InkStroke[] = [];
  private background: PageBackground = "blank";
  private width = 1024;
  private height = 1366;
  private tool: CanvasTool = { kind: "pen", color: 0xff252429, width: 2.5 };
  private active: ActiveStroke | null = null;
  private eraserBefore: InkStroke[] | null = null;
  private eraserPointerID: number | null = null;
  private renderedPointCount = 0;
  private touchPointers = new Map<number, TouchPointer>();
  private panLast: TouchPointer | null = null;
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

  constructor(canvas: HTMLCanvasElement, paper: HTMLElement, viewport: HTMLElement, callbacks: CanvasCallbacks) {
    this.canvas = canvas;
    this.paper = paper;
    this.viewport = viewport;
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
    this.viewport.style.touchAction = "none";
    this.paper.style.touchAction = "none";
    this.canvas.style.touchAction = "none";
    this.canvas.addEventListener("pointerdown", this.handlePointerDown, { passive: false });
    this.canvas.addEventListener("pointermove", this.handlePointerMove, { passive: false });
    this.canvas.addEventListener("pointerup", this.handlePointerUp, { passive: false });
    this.canvas.addEventListener("pointercancel", this.handlePointerCancel, { passive: false });
    this.canvas.addEventListener("lostpointercapture", this.handlePointerCancel);
    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    window.addEventListener("resize", this.handleResize, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.handleResize);
      this.resizeObserver.observe(this.viewport);
    }
  }

  setPage(pageID: string, width: number, height: number, background: PageBackground, strokes: InkStroke[]): void {
    this.cancelActiveInput();
    const dimensionsChanged = this.width !== width || this.height !== height;
    const newPage = pageID !== this.pageKey;
    this.pageKey = pageID;
    this.width = width;
    this.height = height;
    this.background = background;
    this.paper.style.width = `${width}px`;
    this.paper.style.height = `${height}px`;
    if (dimensionsChanged || newPage) this.resizeCanvas();
    this.setStrokes(strokes, newPage);
    if (newPage || dimensionsChanged) this.fitToWidth();
  }

  setStrokes(strokes: InkStroke[], resetHistory = false): void {
    this.strokes = cloneStrokes(strokes);
    if (resetHistory) {
      this.undoStack = [];
      this.redoStack = [];
    }
    this.render();
  }

  setBackground(background: PageBackground): void {
    this.background = background;
    this.render();
  }

  setTool(tool: CanvasTool): void {
    if (this.isInputActive) this.cancelActiveInput();
    this.tool = tool;
    this.canvas.style.cursor = tool.kind === "hand" ? "grab" : "crosshair";
  }

  get currentScale(): number { return this.scale; }
  /** True while a stroke, erase gesture, or touch navigation gesture is active. */
  get isInputActive(): boolean {
    return this.active !== null || this.eraserBefore !== null || this.touchPointers.size > 0;
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
    this.zoomTo(this.scale * factor, { x: rect.width / 2, y: rect.height / 2 });
  }

  /** Fit the page to the viewport width and leave vertical space pannable. */
  fitToWidth(): void {
    this.fitMode = "width";
    const rect = this.viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const gutter = viewportGutter(rect.width);
    const nextScale = clamp((rect.width - gutter * 2) / this.width, MIN_CANVAS_SCALE, FIT_MAX_SCALE);
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
    const rect = this.viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const gutter = viewportGutter(rect.width);
    const availableWidth = Math.max(1, rect.width - gutter * 2);
    const availableHeight = Math.max(1, rect.height - gutter * 2);
    this.scale = clamp(Math.min(availableWidth / this.width, availableHeight / this.height), MIN_CANVAS_SCALE, FIT_MAX_SCALE);
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
    this.cancelActiveInput();
    window.removeEventListener("resize", this.handleResize);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerCancel);
    this.canvas.removeEventListener("lostpointercapture", this.handlePointerCancel);
    this.canvas.removeEventListener("wheel", this.handleWheel);
  }

  private readonly handleResize = (): void => {
    const currentRect = this.viewport.getBoundingClientRect();
    const previousSize = this.lastViewportSize ?? { width: currentRect.width, height: currentRect.height };
    const previousCenter = { x: previousSize.width / 2, y: previousSize.height / 2 };
    const previousWorld = worldPointAt(previousCenter, this.scale, this.offsetX, this.offsetY);
    this.resizeCanvas();
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

  private resizeCanvas(): void {
    this.dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.staticCanvas.width = this.canvas.width;
    this.staticCanvas.height = this.canvas.height;
    this.staticContext.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.renderStatic();
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    if (event.pointerType === "touch" || this.tool.kind === "hand") {
      if (this.active || this.eraserBefore) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      this.touchPointers.set(event.pointerId, this.touchPoint(event));
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
    if (event.pointerType === "touch" || this.touchPointers.has(event.pointerId)) {
      if (this.active || this.eraserBefore) return;
      if (!this.touchPointers.has(event.pointerId)) return;
      this.touchPointers.set(event.pointerId, this.touchPoint(event));
      const values = [...this.touchPointers.values()];
      if (values.length >= 2) {
        if (!this.pinchStart) this.beginPinch();
        this.updatePinch();
      } else if (values.length === 1 && this.panLast) {
        const point = values[0]!;
        this.offsetX += point.x - this.panLast.x;
        this.offsetY += point.y - this.panLast.y;
        this.panLast = point;
        this.applyPan();
      }
      return;
    }
    if (!this.active || this.active.pointerID !== event.pointerId) {
      if (this.eraserPointerID === event.pointerId) this.eraseAt(this.pagePoint(event));
      return;
    }
    this.addPoints(event);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    event.preventDefault();
    if (event.pointerType === "touch" || this.touchPointers.has(event.pointerId)) {
      if (this.active || this.eraserBefore) return;
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
    if (!this.active || this.active.pointerID !== event.pointerId) return;
    this.addPoints(event);
    const before = cloneStrokes(this.strokes);
    this.strokes.push(this.active.stroke);
    // Capture before mutating so undo restores the exact page, including a
    // single-point tap or an empty stroke.
    this.pushUndo(before);
    this.redoStack = [];
    // Commit just this stroke to the cached page, independent of page length.
    this.renderStroke(this.staticContext, this.active.stroke);
    this.active = null;
    this.renderVisible();
    this.callbacks.onChange(cloneStrokes(this.strokes));
  };

  private readonly handlePointerCancel = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    if (this.touchPointers.has(pointerEvent.pointerId) || pointerEvent.pointerType === "touch") {
      this.endTouchPointer(pointerEvent.pointerId);
      return;
    }
    if (this.active?.pointerID === pointerEvent.pointerId || this.eraserPointerID === pointerEvent.pointerId) this.cancelActiveInput();
  };

  private touchPoint(event: PointerEvent): TouchPointer {
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
    this.pinchStart = {
      distance: Math.max(1, distance(first, second)),
      scale: this.scale,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
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
    const nextScale = clamp(start.scale * (nextDistance / start.distance), MIN_CANVAS_SCALE, MAX_CANVAS_SCALE);
    const nextOffset = offsetAtAnchor(world, nextScale, nextCenter);
    this.fitMode = "custom";
    this.applyTransform(nextScale, nextOffset, true);
  }

  private endTouchPointer(pointerID: number): void {
    if (!this.touchPointers.delete(pointerID)) return;
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

  private applyTransform(nextScale: number, nextOffset: CanvasPoint, notifyZoom: boolean): void {
    const scale = clamp(finite(nextScale) ? nextScale : this.scale, MIN_CANVAS_SCALE, MAX_CANVAS_SCALE);
    const rect = this.viewport.getBoundingClientRect();
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

  private cancelActiveInput(): void {
    const pointers = [...this.touchPointers.keys()];
    if (this.active) pointers.push(this.active.pointerID);
    if (this.eraserPointerID !== null) pointers.push(this.eraserPointerID);
    this.active = null;
    if (this.eraserBefore) this.strokes = cloneStrokes(this.eraserBefore);
    this.eraserBefore = null;
    this.eraserPointerID = null;
    this.touchPointers.clear();
    this.panLast = null;
    this.pinchStart = null;
    for (const pointerID of pointers) {
      try { this.canvas.releasePointerCapture(pointerID); } catch { /* capture may already be gone */ }
    }
    if (this.activeFrame !== null) {
      cancelAnimationFrame(this.activeFrame);
      this.activeFrame = null;
    }
    this.render();
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
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewport.clientHeight : 1;
      this.offsetX -= event.deltaX * unit;
      this.offsetY -= event.deltaY * unit;
      this.applyPan();
      return;
    }
    const rect = this.viewport.getBoundingClientRect();
    this.zoomTo(this.scale * (event.deltaY < 0 ? 1.08 : 0.92), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  private addPoints(event: PointerEvent): void {
    if (!this.active) return;
    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    const events = coalesced.length > 0 ? coalesced : [event];
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
    const nextScale = clamp(finite(next) ? next : this.scale, MIN_CANVAS_SCALE, MAX_CANVAS_SCALE);
    this.fitMode = "custom";
    this.applyTransform(nextScale, offsetAtAnchor(world, nextScale, anchor), true);
  }

  private updateTransform(): void {
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
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = "#fffdf7";
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.strokeStyle = this.background === "grid" ? "rgba(125, 106, 82, .16)" : "rgba(176, 82, 59, .16)";
    ctx.lineWidth = 1;
    const spacing = 36;
    if (this.background === "ruled") {
      for (let y = spacing; y < this.height; y += spacing) {
        ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(this.width, y + 0.5); ctx.stroke();
      }
    } else if (this.background === "grid") {
      for (let x = spacing; x < this.width; x += spacing) {
        ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, this.height); ctx.stroke();
      }
      for (let y = spacing; y < this.height; y += spacing) {
        ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(this.width, y + 0.5); ctx.stroke();
      }
    }
    for (const stroke of this.strokes) this.renderStroke(ctx, stroke);
    ctx.restore();
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
function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
