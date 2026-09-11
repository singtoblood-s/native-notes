import { InkStroke, PageBackground, StrokePoint, id } from "./models";

export type CanvasTool =
  | { kind: "pen"; color: number; width: number }
  | { kind: "eraser"; width: number };

interface ActiveStroke {
  pointerID: number;
  stroke: InkStroke;
  startedAt: number;
}

interface TouchPointer { x: number; y: number; }

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
  private touchPointers = new Map<number, TouchPointer>();
  private panLast: TouchPointer | null = null;
  private pinchStart: { distance: number; scale: number; center: TouchPointer } | null = null;
  private undoStack: InkStroke[][] = [];
  private redoStack: InkStroke[][] = [];
  private dpr = 1;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private pageKey = "";
  private activeFrame: number | null = null;

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
    this.canvas.addEventListener("pointerdown", this.handlePointerDown, { passive: false });
    this.canvas.addEventListener("pointermove", this.handlePointerMove, { passive: false });
    this.canvas.addEventListener("pointerup", this.handlePointerUp, { passive: false });
    this.canvas.addEventListener("pointercancel", this.handlePointerCancel, { passive: false });
    this.canvas.addEventListener("lostpointercapture", this.handlePointerCancel);
    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    window.addEventListener("resize", this.handleResize, { passive: true });
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
    if (newPage || dimensionsChanged) this.fitToViewport();
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

  setTool(tool: CanvasTool): void { this.tool = tool; }

  get currentScale(): number { return this.scale; }
  get hasUndo(): boolean { return this.undoStack.length > 0; }
  get hasRedo(): boolean { return this.redoStack.length > 0; }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(cloneStrokes(this.strokes));
    this.strokes = cloneStrokes(previous);
    this.render();
    this.callbacks.onChange(cloneStrokes(this.strokes));
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(cloneStrokes(this.strokes));
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

  fitToViewport(): void {
    const rect = this.viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const nextScale = Math.min((rect.width - 64) / this.width, (rect.height - 64) / this.height);
    this.scale = clamp(nextScale, 0.25, 1.4);
    this.offsetX = (rect.width - this.width * this.scale) / 2;
    this.offsetY = (rect.height - this.height * this.scale) / 2;
    this.updateTransform();
    this.callbacks.onZoom(this.scale);
  }

  destroy(): void {
    window.removeEventListener("resize", this.handleResize);
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerCancel);
    this.canvas.removeEventListener("lostpointercapture", this.handlePointerCancel);
    this.canvas.removeEventListener("wheel", this.handleWheel);
  }

  private readonly handleResize = (): void => {
    this.resizeCanvas();
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
    if (event.pointerType === "touch") {
      if (this.active) return;
      this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.canvas.setPointerCapture(event.pointerId);
      if (this.touchPointers.size === 1) this.panLast = { x: event.clientX, y: event.clientY };
      if (this.touchPointers.size === 2) {
        const [first, second] = [...this.touchPointers.values()];
        if (first && second) {
          const rect = this.viewport.getBoundingClientRect();
          const center = midpoint(first, second);
          this.pinchStart = { distance: distance(first, second), scale: this.scale, center: { x: center.x - rect.left, y: center.y - rect.top } };
        }
      }
      return;
    }
    if (event.pointerType !== "pen" && event.pointerType !== "mouse") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (this.active) return;
    this.touchPointers.clear();
    this.canvas.setPointerCapture(event.pointerId);
    if (this.tool.kind === "eraser") {
      this.eraserBefore = cloneStrokes(this.strokes);
      this.eraseAt(this.pagePoint(event));
      return;
    }
    const timestamp = finite(event.timeStamp) ? event.timeStamp : performance.now();
    this.active = {
      pointerID: event.pointerId,
      startedAt: timestamp,
      stroke: { id: id(), color: this.tool.color >>> 0, width: this.tool.width, points: [] },
    };
    this.addPoints(event);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    event.preventDefault();
    if (event.pointerType === "touch") {
      if (this.active) return;
      if (!this.touchPointers.has(event.pointerId)) return;
      this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const values = [...this.touchPointers.values()];
      if (values.length >= 2 && this.pinchStart) {
        const [first, second] = values;
        if (first && second) {
          const nextCenter = midpoint(first, second);
          const nextDistance = distance(first, second);
          const rect = this.viewport.getBoundingClientRect();
          this.zoomTo(
            this.pinchStart.scale * (nextDistance / Math.max(1, this.pinchStart.distance)),
            { x: nextCenter.x - rect.left, y: nextCenter.y - rect.top },
            this.pinchStart.center,
          );
        }
      } else if (values.length === 1 && this.panLast) {
        this.offsetX += event.clientX - this.panLast.x;
        this.offsetY += event.clientY - this.panLast.y;
        this.panLast = { x: event.clientX, y: event.clientY };
        this.updateTransform();
      }
      return;
    }
    if (!this.active || this.active.pointerID !== event.pointerId) {
      if (this.tool.kind === "eraser" && this.eraserBefore) this.eraseAt(this.pagePoint(event));
      return;
    }
    this.addPoints(event);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    event.preventDefault();
    if (event.pointerType === "touch") {
      if (this.active) return;
      this.touchPointers.delete(event.pointerId);
      if (this.touchPointers.size < 2) this.pinchStart = null;
      if (this.touchPointers.size === 0) this.panLast = null;
      return;
    }
    if (this.tool.kind === "eraser") {
      if (this.eraserBefore && !sameStrokes(this.eraserBefore, this.strokes)) {
        this.pushUndo(this.eraserBefore);
        this.redoStack = [];
        this.callbacks.onChange(cloneStrokes(this.strokes));
      }
      this.eraserBefore = null;
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
    this.active = null;
    this.render();
    this.callbacks.onChange(cloneStrokes(this.strokes));
  };

  private readonly handlePointerCancel = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    if (pointerEvent.pointerType === "touch" || this.active?.pointerID !== pointerEvent.pointerId) {
      this.touchPointers.delete(pointerEvent.pointerId);
      return;
    }
    this.cancelActiveInput();
  };

  private cancelActiveInput(): void {
    if (this.active) {
      try { this.canvas.releasePointerCapture(this.active.pointerID); } catch { /* capture may already be gone */ }
    }
    this.active = null;
    if (this.eraserBefore) this.strokes = cloneStrokes(this.eraserBefore);
    this.eraserBefore = null;
    this.touchPointers.clear();
    this.pinchStart = null;
    if (this.activeFrame !== null) {
      cancelAnimationFrame(this.activeFrame);
      this.activeFrame = null;
    }
    this.render();
  }

  private pushUndo(snapshot: InkStroke[]): void {
    // A page can be large; cap history so a long writing session cannot grow
    // memory without bound. The page itself remains fully canonical.
    if (this.undoStack.length >= 100) this.undoStack.shift();
    this.undoStack.push(cloneStrokes(snapshot));
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const rect = this.viewport.getBoundingClientRect();
    this.zoomTo(this.scale * (event.deltaY < 0 ? 1.08 : 0.92), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  private addPoints(event: PointerEvent): void {
    if (!this.active) return;
    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    const events = coalesced.length > 0 ? coalesced : [event];
    for (const sample of events) {
      const position = this.pagePoint(sample);
      const timestamp = finite(sample.timeStamp) ? sample.timeStamp : performance.now();
      const pressure = finite(sample.pressure) && sample.pressure > 0 ? clamp(sample.pressure, 0, 1) : 0.5;
      const point: StrokePoint = {
        x: position.x,
        y: position.y,
        pressure,
        time: Math.max(0, Math.round(timestamp - this.active.startedAt)),
        tiltX: finite(sample.tiltX) ? sample.tiltX : null,
        tiltY: finite(sample.tiltY) ? sample.tiltY : null,
      };
      const previous = this.active.stroke.points.at(-1);
      // A tap commonly arrives as a down and an up with an empty coalesced
      // array. Keep its single canonical point instead of duplicating it.
      if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) > 0.01) this.active.stroke.points.push(point);
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

  private pagePoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) * this.width / Math.max(1, rect.width), 0, this.width),
      y: clamp((event.clientY - rect.top) * this.height / Math.max(1, rect.height), 0, this.height),
    };
  }

  private zoomTo(next: number, anchor: TouchPointer, previousAnchor = anchor): void {
    const nextScale = clamp(next, 0.25, 2.8);
    const worldX = (previousAnchor.x - this.offsetX) / this.scale;
    const worldY = (previousAnchor.y - this.offsetY) / this.scale;
    this.scale = nextScale;
    this.offsetX = anchor.x - worldX * this.scale;
    this.offsetY = anchor.y - worldY * this.scale;
    this.updateTransform();
    this.callbacks.onZoom(this.scale);
  }

  private updateTransform(): void {
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
    this.context.restore();
  }

  private scheduleActiveRender(): void {
    if (this.activeFrame !== null) return;
    this.activeFrame = requestAnimationFrame(() => {
      this.activeFrame = null;
      this.renderVisible();
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
      context.arc(point.x, point.y, Math.max(0.5, stroke.width * (0.65 + point.pressure * 0.35)), 0, Math.PI * 2);
      context.fill();
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
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
