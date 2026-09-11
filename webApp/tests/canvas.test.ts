import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPanBounds, MAX_HISTORY_POINTS, MOBILE_FIT_GUTTER, PAN_MARGIN, PaperCanvas, renderPagePreview, worldPointAt } from "../src/canvas";

function pointer(type: string, props: Record<string, unknown>): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  for (const [key, value] of Object.entries({ pointerId: 1, pointerType: "pen", clientX: 100, clientY: 100, button: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timeStamp: 10, ...props })) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  return event;
}

function setup(): {
  canvas: HTMLCanvasElement;
  paper: HTMLElement;
  viewport: HTMLElement;
  changes: ReturnType<typeof vi.fn>;
  canvasController: PaperCanvas;
  viewportRect: { width: number; height: number; top: number };
} {
  const viewport = document.createElement("div");
  const paper = document.createElement("div");
  const canvas = document.createElement("canvas");
  viewport.append(paper);
  paper.append(canvas);
  document.body.append(viewport);
  const viewportRect = { width: 800, height: 600, top: 0 };
  Object.defineProperty(viewport, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: viewportRect.top, width: viewportRect.width, height: viewportRect.height, right: viewportRect.width, bottom: viewportRect.height }) });
  Object.defineProperty(canvas, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 512, height: 683, right: 512, bottom: 683 }) });
  const changes = vi.fn();
  const canvasController = new PaperCanvas(canvas, paper, viewport, { onChange: changes, onZoom: vi.fn() });
  canvasController.setPage("page", 1024, 1366, "blank", []);
  return { canvas, paper, viewport, changes, canvasController, viewportRect };
}

function transformOf(paper: HTMLElement): { x: number; y: number; scale: number } {
  const match = paper.style.transform.match(/translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) scale\((-?[\d.]+)\)/);
  if (!match) throw new Error(`Unexpected transform: ${paper.style.transform}`);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => ({
    setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(), drawImage: vi.fn(),
  }) });
  Object.defineProperty(HTMLCanvasElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLCanvasElement.prototype, "releasePointerCapture", { configurable: true, value: vi.fn() });
});

afterEach(() => { document.body.innerHTML = ""; vi.unstubAllGlobals(); });

describe("PaperCanvas pointer contract", () => {
  it("bounds raster memory for large imported PDF page dimensions", () => {
    const { canvasController, canvas } = setup();
    canvasController.setPage("poster", 10_000, 10_000, "blank", []);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(8_010_000);
    expect(canvas.width).toBeLessThanOrEqual(8192);
    expect(canvasController.currentScale * 10_000).toBeLessThanOrEqual(800);
    canvasController.destroy();
  });
  it("fits small picture pages to the same width as their flow previews", () => {
    const { canvasController } = setup();
    canvasController.setNavigationMode("continuous");
    canvasController.setPage("small-picture", 320, 400, "blank", []);
    expect(canvasController.currentScale * 320).toBe(800);
    canvasController.destroy();
  });
  it("uses screen deltas during flow scrolling and keeps a single touch active until release", () => {
    const { canvas, viewport, viewportRect, canvasController } = setup();
    canvasController.setNavigationMode("continuous");
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 92, pointerType: "touch", clientY: 300 }));
    expect(canvasController.isInputActive).toBe(true);
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 92, pointerType: "touch", clientY: 200 }));
    // Simulate the active viewport moving with its parent scroller.
    viewportRect.top = -100;
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 92, pointerType: "touch", clientY: 100 }));
    expect(viewport.scrollTop).toBe(200);
    canvas.dispatchEvent(pointer("pointercancel", { pointerId: 92, pointerType: "touch" }));
    expect(canvasController.isInputActive).toBe(false);
    canvasController.destroy();
  });

  it("preserves zoom on equally sized pages in page-turn mode", () => {
    const { canvasController, paper } = setup();
    canvasController.zoomBy(1.5);
    const before = transformOf(paper);
    canvasController.setPage("next", 1024, 1366, "blank", []);
    expect(transformOf(paper)).toEqual(before);
    canvasController.destroy();
  });
  it.each(["continuous", "horizontal"] as const)("pans with two fingers across page previews and gutters in %s mode", (mode) => {
    const { canvasController, canvas, viewport, changes } = setup();
    const scroll = document.createElement("div");
    const preview = document.createElement("canvas");
    document.body.append(scroll);
    scroll.append(viewport, preview);
    Object.defineProperty(scroll, "getBoundingClientRect", { value: () => ({ width: 800, height: 600, left: 0, top: 0 }) });
    Object.defineProperty(viewport, "getBoundingClientRect", { configurable: true, value: () => ({ width: 800, height: 1067, left: -scroll.scrollLeft, top: -scroll.scrollTop }) });
    canvasController.setNavigationMode(mode, scroll);
    canvasController.setPage("flow", 1024, 1366, "blank", []);
    const scale = canvasController.currentScale;
    preview.dispatchEvent(pointer("pointerdown", { pointerId: 90, pointerType: "touch", clientX: 300, clientY: 300 }));
    scroll.dispatchEvent(pointer("pointerdown", { pointerId: 91, pointerType: "touch", clientX: 500, clientY: 300 }));
    // Each finger reports separately, and the page origin moves with the scroller.
    preview.dispatchEvent(pointer("pointermove", { pointerId: 90, pointerType: "touch", clientX: 250, clientY: 200 }));
    scroll.dispatchEvent(pointer("pointermove", { pointerId: 91, pointerType: "touch", clientX: 450, clientY: 200 }));
    expect(canvasController.currentScale).toBeCloseTo(scale);
    expect(scroll.scrollLeft).toBeCloseTo(50);
    expect(scroll.scrollTop).toBeCloseTo(100);
    preview.dispatchEvent(pointer("pointercancel", { pointerId: 90, pointerType: "touch" }));
    scroll.dispatchEvent(pointer("pointercancel", { pointerId: 91, pointerType: "touch" }));
    expect(canvasController.isInputActive).toBe(false);
    expect(changes).not.toHaveBeenCalled();
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaX: 20, deltaY: 30, bubbles: true, cancelable: true }));
    expect(scroll.scrollLeft).toBeCloseTo(70);
    canvasController.destroy();
  });
  it.each(["continuous", "horizontal"] as const)("keeps shared zoom for mixed page sizes in %s mode", (mode) => {
    const { canvasController, paper, canvas, viewport } = setup();
    canvasController.setNavigationMode(mode);
    canvasController.setPage("first", 1024, 1366, "blank", []);
    canvasController.zoomBy(1.5);
    const scale = canvasController.currentScale;
    canvasController.setPage("landscape", 1366, 1024, "blank", []);
    expect(canvasController.currentScale).toBe(scale);
    expect(transformOf(paper)).toEqual({ x: 0, y: 0, scale });
    canvasController.setTool({ kind: "hand" });
    const top = viewport.scrollTop, left = viewport.scrollLeft;
    canvas.dispatchEvent(pointer("pointerdown", { pointerType: "touch", clientX: 300, clientY: 300 }));
    canvas.dispatchEvent(pointer("pointermove", { pointerType: "touch", clientX: 250, clientY: 200 }));
    expect(viewport.scrollTop - top).toBe(100);
    expect(viewport.scrollLeft - left).toBe(50);
    expect(transformOf(paper)).toEqual({ x: 0, y: 0, scale });
    canvasController.destroy();
  });
  it("cancels native canvas touch moves without duplicate ink or blocking outside scrolling", () => {
    const { canvas, viewport, changes, canvasController } = setup();
    canvasController.setNavigationMode("continuous");
    const nativeMove = () => new Event("touchmove", { bubbles: true, cancelable: true });
    const down = pointer("pointerdown", { pointerId: 90, pointerType: "touch", clientX: 300, clientY: 300 });
    canvas.dispatchEvent(down);
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 90, pointerType: "touch", clientX: 300, clientY: 200 }));
    const touch = nativeMove();
    canvas.dispatchEvent(touch);
    expect(touch.defaultPrevented).toBe(true);
    expect(viewport.scrollTop).toBe(100);
    expect(changes).not.toHaveBeenCalled();
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 90, pointerType: "touch" }));

    canvas.dispatchEvent(pointer("pointerdown", {}));
    canvas.dispatchEvent(pointer("pointermove", { clientX: 120 }));
    canvas.dispatchEvent(nativeMove());
    canvas.dispatchEvent(pointer("pointerup", { clientX: 140 }));
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes.mock.calls[0]![0]).toHaveLength(1);

    const outside = nativeMove();
    viewport.dispatchEvent(outside);
    expect(outside.defaultPrevented).toBe(false);
    canvasController.destroy();
    const afterDestroy = nativeMove();
    canvas.dispatchEvent(afterDestroy);
    expect(afterDestroy.defaultPrevented).toBe(false);
  });

  it("renders bounded page previews with the page aspect ratio and ink", () => {
    const preview = document.createElement("canvas");
    const context = {
      setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    Object.defineProperty(preview, "getContext", { configurable: true, value: () => context });
    renderPagePreview(preview, {
      width: 1024,
      height: 1366,
      background: "blank",
      strokes: [{ id: "preview", color: 0xff252429, width: 3, points: [
        { x: 10, y: 20, pressure: 0.5, time: 0, tiltX: null, tiltY: null },
        { x: 50, y: 60, pressure: 0.5, time: 1, tiltX: null, tiltY: null },
      ] }],
    }, 256);
    expect(preview.width).toBe(256);
    expect(preview.height).toBe(342);
    expect(preview.style.aspectRatio).toBe("1024 / 1366");
    expect(context.stroke).toHaveBeenCalled();
  });

  it("keeps point times monotonic across stale coalesced samples and pointerup", () => {
    const { canvas, changes, canvasController } = setup();
    canvas.dispatchEvent(pointer("pointerdown", { timeStamp: 100, clientX: 10 }));
    canvas.dispatchEvent(pointer("pointermove", { timeStamp: 140, clientX: 35, getCoalescedEvents: () => [
      pointer("pointermove", { timeStamp: 130, clientX: 20 }),
      pointer("pointermove", { timeStamp: 120, clientX: 30 }),
    ] }));
    canvas.dispatchEvent(pointer("pointerup", { timeStamp: 110, clientX: 40 }));
    expect(changes.mock.lastCall![0][0].points.map((point: { time: number }) => point.time)).toEqual([0, 30, 30, 40, 40]);
    expect(changes.mock.lastCall![0][0].points.map((point: { x: number }) => point.x)).toEqual([20, 40, 60, 70, 80]);
    canvasController.destroy();
  });

  it("stores translucent highlighter strokes and round-trips undo/redo", () => {
    const { canvas, changes, canvasController } = setup();
    canvasController.setTool({ kind: "highlighter", color: 0xfff2ca52, width: 18 });
    canvas.dispatchEvent(pointer("pointerdown", { pressure: 0.1 }));
    canvas.dispatchEvent(pointer("pointermove", { clientX: 150, pressure: 0.9 }));
    canvas.dispatchEvent(pointer("pointerup", { clientX: 200 }));
    const strokes = changes.mock.lastCall![0];
    expect(strokes[0]).toMatchObject({ color: 0x50f2ca52, width: 18 });
    expect(strokes[0].points.every((point: { pressure: number }) => point.pressure === 1)).toBe(true);
    canvasController.undo();
    expect(changes.mock.lastCall![0]).toEqual([]);
    canvasController.redo();
    expect(changes.mock.lastCall![0]).toEqual(strokes);
    canvasController.destroy();
  });

  it("keeps only endpoints for a straight line and constant pressure for ball pen", () => {
    const { canvas, changes, canvasController } = setup();
    canvasController.setTool({ kind: "line", color: 0xff252429, width: 3 });
    canvas.dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 20 }));
    canvas.dispatchEvent(pointer("pointermove", { clientX: 80, clientY: 100 }));
    canvas.dispatchEvent(pointer("pointerup", { clientX: 120, clientY: 30 }));
    expect(changes.mock.lastCall![0][0].points).toMatchObject([{ x: 20, y: 40 }, { x: 240, y: 60 }]);
    canvasController.setTool({ kind: "pen", color: 0xff252429, width: 3, pressureSensitive: false });
    canvas.dispatchEvent(pointer("pointerdown", { pressure: 0.1 }));
    canvas.dispatchEvent(pointer("pointerup", { clientX: 120, pressure: 0.9 }));
    expect(changes.mock.lastCall![0][1].points.map((point: { pressure: number }) => point.pressure)).toEqual([1, 1]);
    canvasController.destroy();
  });

  it("pans in read mode without writing or allowing undo", () => {
    const { canvas, paper, changes, canvasController } = setup();
    canvas.dispatchEvent(pointer("pointerdown", {}));
    canvas.dispatchEvent(pointer("pointerup", {}));
    changes.mockClear();
    canvasController.setTool({ kind: "hand" });
    const before = paper.style.transform;
    canvas.dispatchEvent(pointer("pointerdown", { pointerType: "mouse", clientY: 300 }));
    canvas.dispatchEvent(pointer("pointermove", { pointerType: "mouse", clientY: 100 }));
    canvas.dispatchEvent(pointer("pointerup", { pointerType: "mouse", clientY: 100 }));
    expect(paper.style.transform).not.toBe(before);
    canvasController.undo();
    expect(changes).not.toHaveBeenCalled();
    expect(canvasController.isInputActive).toBe(false);
    canvasController.destroy();
  });

  it("ignores unrelated pointers and palm movement during erasing, and restores cancelled ink", () => {
    const { canvas, paper, changes, canvasController } = setup();
    canvas.dispatchEvent(pointer("pointerdown", {}));
    canvas.dispatchEvent(pointer("pointerup", {}));
    const original = changes.mock.lastCall![0];
    changes.mockClear();
    canvasController.setTool({ kind: "eraser", width: 6 });
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 7 }));
    const before = paper.style.transform;
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 8, pointerType: "touch" }));
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 8, pointerType: "touch", clientY: 10 }));
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 9, pointerType: "mouse" }));
    canvas.dispatchEvent(pointer("pointercancel", { pointerId: 9 }));
    expect(canvasController.isInputActive).toBe(true);
    expect(paper.style.transform).toBe(before);
    expect(changes).not.toHaveBeenCalled();
    canvas.dispatchEvent(pointer("pointercancel", { pointerId: 7 }));
    expect(canvasController.isInputActive).toBe(false);
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 7 }));
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 7 }));
    expect(changes.mock.lastCall![0]).toEqual([]);
    canvasController.undo();
    expect(changes.mock.lastCall![0]).toEqual(original);
    canvasController.destroy();
  });

  it("renders only newly received opaque segments between animation frames", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    const { canvas, canvasController } = setup();
    const renderStroke = vi.spyOn(canvasController as unknown as { renderStroke: (ctx: unknown, stroke: { points: unknown[] }) => void }, "renderStroke");
    canvas.dispatchEvent(pointer("pointerdown", { clientX: 10 }));
    frames.shift()!(0);
    for (let i = 1; i <= 100; i++) {
      renderStroke.mockClear();
      canvas.dispatchEvent(pointer("pointermove", { clientX: 10 + i }));
      frames.shift()!(i);
      expect(renderStroke).toHaveBeenCalledTimes(1);
      expect(renderStroke.mock.calls[0]![1].points).toHaveLength(2);
    }
    const renderStatic = vi.spyOn(canvasController as unknown as { renderStatic: () => void }, "renderStatic");
    canvas.dispatchEvent(pointer("pointerup", { clientX: 110 }));
    expect(renderStatic).not.toHaveBeenCalled();
    canvasController.destroy();
  });

  it("keeps the photo layer in place without full-page copies while highlighting and panning", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", callback => { frames.push(callback); return frames.length; });
    const { canvas, paper, canvasController } = setup();
    const internals = canvasController as unknown as { context: CanvasRenderingContext2D; renderStatic(): void };
    const redraw = vi.spyOn(internals, "renderStatic");
    const background = paper.querySelector<HTMLCanvasElement>(".paper-background-canvas")!;
    expect(background.nextElementSibling).toBe(canvas);
    expect([background.width, background.height]).toEqual([canvas.width, canvas.height]);
    canvasController.setTool({ kind: "highlighter", color: 0xffffcc00, width: 18 });
    canvas.dispatchEvent(pointer("pointerdown", { clientX: 10 }));
    frames.shift()!(0);
    for (let index = 1; index <= 10; index++) {
      canvas.dispatchEvent(pointer("pointermove", { clientX: 10 + index }));
      frames.shift()!(index);
    }
    canvas.dispatchEvent(pointer("pointerup", { clientX: 20 }));
    canvasController.setTool({ kind: "hand" });
    canvas.dispatchEvent(pointer("pointerdown", { pointerType: "touch", clientX: 200 }));
    canvas.dispatchEvent(pointer("pointermove", { pointerType: "touch", clientX: 240 }));
    canvas.dispatchEvent(pointer("pointerup", { pointerType: "touch", clientX: 240 }));
    expect(internals.context.drawImage).not.toHaveBeenCalled();
    expect(redraw).not.toHaveBeenCalled();
    expect(paper.querySelector(".paper-background-canvas")).toBe(background);
    canvasController.destroy();
    expect(background.isConnected).toBe(false);
    expect([background.width, background.height]).toEqual([1, 1]);
  });

  it("keeps a tap when coalesced events is empty", () => {
    const { canvas, changes } = setup();
    const down = pointer("pointerdown", { clientX: 100, clientY: 100, timeStamp: 10 });
    Object.defineProperty(down, "getCoalescedEvents", { value: () => [] });
    const up = pointer("pointerup", { clientX: 100, clientY: 100, timeStamp: 11 });
    Object.defineProperty(up, "getCoalescedEvents", { value: () => [] });
    canvas.dispatchEvent(down);
    canvas.dispatchEvent(up);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes.mock.calls[0]?.[0]).toHaveLength(1);
    expect(changes.mock.calls[0]?.[0][0].points).toHaveLength(1);
  });

  it("rounds newly captured samples without changing the page coordinate scale", () => {
    const { canvas, changes } = setup();
    canvas.dispatchEvent(pointer("pointerdown", {
      clientX: 123.456,
      clientY: 234.567,
      pressure: 0.67894,
      tiltX: 12.34,
      tiltY: -4.56,
    }));
    canvas.dispatchEvent(pointer("pointerup", {
      clientX: 123.456,
      clientY: 234.567,
      pressure: 0.67894,
      tiltX: 12.34,
      tiltY: -4.56,
    }));
    const point = changes.mock.calls[0]?.[0][0].points[0];
    expect(point).toMatchObject({ x: 246.91, y: 469.13, pressure: 0.679, tiltX: 12.3, tiltY: -4.6 });
  });

  it("does not duplicate an oversized page into undo history", () => {
    const { canvas, canvasController } = setup();
    const points = Array.from({ length: MAX_HISTORY_POINTS + 1 }, (_, index) => ({
      x: index % 1024,
      y: index % 1366,
      pressure: 0.5,
      time: index,
      tiltX: null,
      tiltY: null,
    }));
    canvasController.setStrokes([{ id: "large", color: 0xff252429, width: 2.5, points }], true);
    canvas.dispatchEvent(pointer("pointerdown", { clientX: 120, clientY: 120 }));
    canvas.dispatchEvent(pointer("pointerup", { clientX: 120, clientY: 120 }));
    expect(canvasController.hasUndo).toBe(false);
  });

  it("commits sampled ink when the browser cancels a pen contact", () => {
    const { canvas, changes, canvasController } = setup();
    canvas.dispatchEvent(pointer("pointerdown", { timeStamp: 10 }));
    expect(canvasController.isInputActive).toBe(true);
    canvas.dispatchEvent(pointer("pointermove", { timeStamp: 15, clientX: 120 }));
    canvas.dispatchEvent(pointer("pointercancel", { timeStamp: 16 }));
    expect(canvasController.isInputActive).toBe(false);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes.mock.lastCall![0][0].points).toHaveLength(2);
  });

  it("ignores palm touch while a pen stroke is active", () => {
    const { canvas, paper, changes } = setup();
    const before = paper.style.transform;
    canvas.dispatchEvent(pointer("pointerdown", { timeStamp: 10, pointerId: 1, pointerType: "pen" }));
    canvas.dispatchEvent(pointer("pointerdown", { timeStamp: 11, pointerId: 2, pointerType: "touch", clientX: 200, clientY: 200 }));
    canvas.dispatchEvent(pointer("pointermove", { timeStamp: 12, pointerId: 2, pointerType: "touch", clientX: 320, clientY: 320 }));
    expect(paper.style.transform).toBe(before);
    canvas.dispatchEvent(pointer("pointerup", { timeStamp: 15, pointerId: 1, pointerType: "pen" }));
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("keeps one-finger touch inert in writing mode while allowing a two-finger pinch", () => {
    const { canvas, paper, canvasController } = setup();
    const before = transformOf(paper);
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 50, pointerType: "touch", clientX: 300, clientY: 300 }));
    expect(canvasController.isInputActive).toBe(false);
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 50, pointerType: "touch", clientX: 320, clientY: 320 }));
    expect(transformOf(paper)).toEqual(before);
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 51, pointerType: "touch", clientX: 500, clientY: 300 }));
    expect(canvasController.isInputActive).toBe(true);
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 50, pointerType: "touch", clientX: 200, clientY: 300 }));
    expect(transformOf(paper).scale).toBeGreaterThan(before.scale);
    const afterPinch = transformOf(paper);
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 50, pointerType: "touch", clientX: 200, clientY: 300 }));
    expect(canvasController.isInputActive).toBe(false);
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 51, pointerType: "touch", clientX: 700, clientY: 300 }));
    expect(transformOf(paper)).toEqual(afterPinch);
    expect(canvasController.isInputActive).toBe(false);
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 51, pointerType: "touch", clientX: 700, clientY: 300 }));
    canvasController.destroy();
  });

  it("forwards one-finger flow touches to the page scroll axis while keeping pinch available", () => {
    const { canvas, viewport, canvasController } = setup();
    canvasController.setNavigationMode("continuous");
    const down = pointer("pointerdown", { pointerId: 90, pointerType: "touch", clientX: 300, clientY: 300 });
    canvas.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 90, pointerType: "touch", clientX: 300, clientY: 200 }));
    expect(viewport.scrollTop).toBe(100);
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 90, pointerType: "touch", clientX: 300, clientY: 200 }));
    canvasController.setNavigationMode("horizontal");
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 91, pointerType: "touch", clientX: 300, clientY: 300 }));
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 91, pointerType: "touch", clientX: 200, clientY: 300 }));
    expect(viewport.scrollLeft).toBe(100);
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 91, pointerType: "touch", clientX: 200, clientY: 300 }));

    const outerFlow = document.createElement("div");
    document.body.append(outerFlow);
    canvasController.setNavigationMode("continuous", outerFlow);
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 92, pointerType: "touch", clientX: 300, clientY: 300 }));
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 92, pointerType: "touch", clientX: 300, clientY: 200 }));
    expect(outerFlow.scrollTop).toBe(100);
    expect(viewport.scrollTop).toBe(100);
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 92, pointerType: "touch", clientX: 300, clientY: 200 }));
    canvasController.destroy();
  });

  it("gives pen hover and contact priority over pending and remaining palm touch", () => {
    const { canvas, paper, changes, canvasController } = setup();
    const before = transformOf(paper);
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 60, pointerType: "touch", clientX: 300, clientY: 300 }));
    canvas.dispatchEvent(pointer("pointerover", { pointerId: 61, pointerType: "pen", buttons: 0, clientX: 100, clientY: 100 }));
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 61, pointerType: "pen", buttons: 0, clientX: 100, clientY: 100 }));
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 60, pointerType: "touch", clientX: 500, clientY: 500 }));
    expect(transformOf(paper)).toEqual(before);
    expect(canvasController.isInputActive).toBe(false);
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 61, pointerType: "pen", clientX: 100, clientY: 100 }));
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 62, pointerType: "touch", clientX: 200, clientY: 200 }));
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 62, pointerType: "touch", clientX: 600, clientY: 600 }));
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 61, pointerType: "pen", clientX: 100, clientY: 100 }));
    expect(changes).toHaveBeenCalledTimes(1);
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 62, pointerType: "touch", clientX: 700, clientY: 700 }));
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 62, pointerType: "touch", clientX: 700, clientY: 700 }));
    expect(transformOf(paper)).toEqual(before);
    expect(canvasController.isInputActive).toBe(false);
    canvasController.destroy();
  });

  it("keeps a pen stroke through lost capture and finishes it on an outside pointerup", () => {
    const { canvas, paper, changes, canvasController } = setup();
    const before = transformOf(paper);
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 70, pointerType: "pen", timeStamp: 10 }));
    canvas.dispatchEvent(pointer("lostpointercapture", { pointerId: 70, pointerType: "pen", timeStamp: 11 }));
    expect(canvasController.isInputActive).toBe(true);
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 70, pointerType: "pen", timeStamp: 12, clientX: 500 }));
    document.dispatchEvent(pointer("pointerup", { pointerId: 70, pointerType: "pen", timeStamp: 13, clientX: 500 }));
    expect(canvasController.isInputActive).toBe(false);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes.mock.lastCall![0][0].points.length).toBeGreaterThan(1);
    expect(transformOf(paper)).toEqual(before);
    canvasController.destroy();
  });

  it("preserves sampled ink when focus or visibility interrupts a pen contact", () => {
    const { canvas, changes, canvasController } = setup();
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 71, pointerType: "pen", timeStamp: 10 }));
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 71, pointerType: "pen", timeStamp: 15, clientX: 150 }));
    window.dispatchEvent(new Event("blur"));
    expect(canvasController.isInputActive).toBe(false);
    expect(changes).toHaveBeenCalledTimes(1);
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 71, pointerType: "touch", clientX: 300, clientY: 300 }));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 73, pointerType: "pen", timeStamp: 20 }));
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 73, pointerType: "pen", timeStamp: 25, clientX: 180 }));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(canvasController.isInputActive).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    canvasController.destroy();
  });

  it("ignores a late pointerup after an iPad pointer id is reused", () => {
    const { canvas, changes, canvasController } = setup();
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 80, pointerType: "pen", timeStamp: 100, clientX: 10 }));
    canvas.dispatchEvent(pointer("lostpointercapture", { pointerId: 80, pointerType: "pen", timeStamp: 110 }));
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 80, pointerType: "pen", timeStamp: 200, clientX: 20 }));
    expect(changes).toHaveBeenCalledTimes(1);
    document.dispatchEvent(pointer("pointerup", { pointerId: 80, pointerType: "pen", timeStamp: 150, clientX: 30 }));
    expect(changes).toHaveBeenCalledTimes(1);
    document.dispatchEvent(pointer("pointerup", { pointerId: 80, pointerType: "pen", timeStamp: 220, clientX: 40 }));
    expect(changes).toHaveBeenCalledTimes(2);
    canvasController.destroy();
  });

  it("commits every rapid pen contact when Safari reports zero pressure and buttons", () => {
    const { canvas, changes, canvasController } = setup();
    const contacts = 40;
    for (let index = 0; index < contacts; index += 1) {
      const time = 1_000 + index * 2;
      const position = 20 + index * 4;
      canvas.dispatchEvent(pointer("pointerdown", {
        pointerId: 81,
        pointerType: "pen",
        clientX: position,
        clientY: position,
        buttons: 0,
        pressure: 0,
        timeStamp: time,
      }));
      canvas.dispatchEvent(pointer("pointerup", {
        pointerId: 81,
        pointerType: "pen",
        clientX: position,
        clientY: position,
        buttons: 0,
        pressure: 0,
        timeStamp: time + 1,
      }));
    }
    const strokes = changes.mock.lastCall![0];
    expect(strokes).toHaveLength(contacts);
    expect(strokes.every((stroke: { points: Array<{ pressure: number }> }) => stroke.points.length === 1 && stroke.points[0]!.pressure === 0.5)).toBe(true);
    canvasController.destroy();
  });

  it("starts a same-ID contact after a missing pointerup without lost capture", () => {
    const { canvas, changes, canvasController } = setup();
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 82, timeStamp: 100, clientX: 20 }));
    // The next down is the only reliable boundary when WebKit omits both
    // pointerup and lostpointercapture for a very short Pencil contact.
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 82, timeStamp: 200, clientX: 80 }));
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 82, timeStamp: 201, clientX: 80, buttons: 0, pressure: 0 }));
    expect(changes).toHaveBeenCalledTimes(2);
    expect(changes.mock.lastCall![0]).toHaveLength(2);
    expect(changes.mock.lastCall![0].map((stroke: { points: Array<{ x: number }> }) => stroke.points[0]!.x)).toEqual([40, 160]);
    canvasController.destroy();
  });

  it("commits before a zero-pressure pen hover move without adding its hover point", () => {
    const { canvas, changes, canvasController } = setup();
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 86, timeStamp: 100, clientX: 20, pressure: 0.6, buttons: 1 }));
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 86, timeStamp: 110, clientX: 40, pressure: 0.6, buttons: 1 }));
    const hover = pointer("pointermove", { pointerId: 86, timeStamp: 120, clientX: 400, pressure: 0, buttons: 0 });
    Object.defineProperty(hover, "getCoalescedEvents", { value: () => [pointer("pointermove", { pointerId: 86, timeStamp: 115, clientX: 60, pressure: 0.6, buttons: 1 })] });
    canvas.dispatchEvent(hover);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes.mock.lastCall![0][0].points.map((point: { x: number }) => point.x)).toEqual([40, 80, 120]);
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 86, timeStamp: 200, clientX: 80, pressure: 0, buttons: 0 }));
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 86, timeStamp: 201, clientX: 80, pressure: 0, buttons: 0 }));
    expect(changes).toHaveBeenCalledTimes(2);
    expect(changes.mock.lastCall![0]).toHaveLength(2);
    expect(changes.mock.lastCall![0][1].points).toHaveLength(1);
    canvasController.destroy();
  });

  it("accepts a pointerup when Safari reports a zero timestamp", () => {
    const { canvas, changes, canvasController } = setup();
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 83, timeStamp: 100, clientX: 40 }));
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 83, timeStamp: 0, clientX: 40, buttons: 0, pressure: 0 }));
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes.mock.lastCall![0]).toHaveLength(1);
    expect(changes.mock.lastCall![0][0].points[0]!.time).toBe(0);
    canvasController.destroy();
  });

  it("does not let a different pen pointer terminate the active contact", () => {
    const { canvas, changes, canvasController } = setup();
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 84, timeStamp: 100, clientX: 20 }));
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 85, timeStamp: 200, clientX: 80 }));
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 85, timeStamp: 201, clientX: 80, buttons: 0, pressure: 0 }));
    expect(changes).not.toHaveBeenCalled();
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 84, timeStamp: 202, clientX: 20, buttons: 0, pressure: 0 }));
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes.mock.lastCall![0]).toHaveLength(1);
    canvasController.destroy();
  });

  it("suppresses selection and context menus on canvas chrome but preserves form selection", () => {
    const { canvas, canvasController } = setup();
    const chrome = document.createElement("div");
    chrome.className = "editor-toolbar";
    const input = document.createElement("textarea");
    chrome.append(input);
    document.body.append(chrome);
    const canvasMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    canvas.dispatchEvent(canvasMenu);
    expect(canvasMenu.defaultPrevented).toBe(true);
    const chromeMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    chrome.dispatchEvent(chromeMenu);
    expect(chromeMenu.defaultPrevented).toBe(true);
    const inputMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    input.dispatchEvent(inputMenu);
    expect(inputMenu.defaultPrevented).toBe(false);
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "plaintext-only");
    chrome.append(editable);
    const editableMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    editable.dispatchEvent(editableMenu);
    expect(editableMenu.defaultPrevented).toBe(false);
    const selectStart = new Event("selectstart", { bubbles: true, cancelable: true });
    chrome.dispatchEvent(selectStart);
    expect(selectStart.defaultPrevented).toBe(true);
    const inputSelectStart = new Event("selectstart", { bubbles: true, cancelable: true });
    input.dispatchEvent(inputSelectStart);
    expect(inputSelectStart.defaultPrevented).toBe(false);
    canvasController.destroy();
  });

  it("rebuilds the page once after replacing page input", () => {
    const { canvasController } = setup();
    const render = vi.spyOn(canvasController as unknown as { render: () => void }, "render");
    canvasController.setPage("next", 1024, 1366, "ruled", []);
    expect(render).toHaveBeenCalledTimes(1);
    canvasController.destroy();
  });

  it("counts two-finger writing navigation as active until one finger remains", () => {
    const { canvas, canvasController } = setup();
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 41, pointerType: "touch", clientX: 250, clientY: 250 }));
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 42, pointerType: "touch", clientX: 450, clientY: 250 }));
    expect(canvasController.isInputActive).toBe(true);
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 41, pointerType: "touch", clientX: 250, clientY: 250 }));
    expect(canvasController.isInputActive).toBe(false);
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 42, pointerType: "touch", clientX: 450, clientY: 250 }));
    expect(canvasController.isInputActive).toBe(false);
  });

  it("fits writing view to width and keeps a dragged page reachable", () => {
    const { canvas, paper, viewportRect, canvasController } = setup();
    const initial = transformOf(paper);
    expect(initial.scale).toBeCloseTo((viewportRect.width - PAN_MARGIN * 2) / 1024, 6);

    canvasController.setTool({ kind: "hand" });
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 11, pointerType: "touch", clientX: 300, clientY: 300 }));
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 11, pointerType: "touch", clientX: 5300, clientY: 5300 }));
    const dragged = transformOf(paper);
    const bounds = getPanBounds(1024, 1366, dragged.scale, viewportRect.width, viewportRect.height);
    expect(dragged.x).toBeGreaterThanOrEqual(bounds.minX - 0.001);
    expect(dragged.x).toBeLessThanOrEqual(bounds.maxX + 0.001);
    expect(dragged.y).toBeGreaterThanOrEqual(bounds.minY - 0.001);
    expect(dragged.y).toBeLessThanOrEqual(bounds.maxY + 0.001);
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 11, pointerType: "touch", clientX: 5300, clientY: 5300 }));
  });

  it("top-aligns the width fit on a portrait phone", () => {
    const { paper, viewportRect, canvasController } = setup();
    viewportRect.width = 430;
    viewportRect.height = 932;
    canvasController.fitToWidth();
    const fitted = transformOf(paper);
    expect(fitted.scale).toBeCloseTo((430 - MOBILE_FIT_GUTTER * 2) / 1024, 6);
    expect(fitted.x).toBeCloseTo(MOBILE_FIT_GUTTER, 6);
    expect(fitted.y).toBeCloseTo(MOBILE_FIT_GUTTER, 6);
  });

  it("keeps the pinch anchor stable across multiple move events", () => {
    const { canvas, paper } = setup();
    const initial = transformOf(paper);
    const startCenter = { x: 400, y: 250 };
    const startWorld = worldPointAt(startCenter, initial.scale, initial.x, initial.y);

    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 21, pointerType: "touch", clientX: 300, clientY: 250 }));
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 22, pointerType: "touch", clientX: 500, clientY: 250 }));
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 21, pointerType: "touch", clientX: 250, clientY: 250 }));
    let current = transformOf(paper);
    let mapped = worldPointAt({ x: 375, y: 250 }, current.scale, current.x, current.y);
    expect(mapped.x).toBeCloseTo(startWorld.x, 5);
    expect(mapped.y).toBeCloseTo(startWorld.y, 5);
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 22, pointerType: "touch", clientX: 550, clientY: 250 }));
    current = transformOf(paper);
    mapped = worldPointAt(startCenter, current.scale, current.x, current.y);
    expect(current.scale).toBeCloseTo(initial.scale * 1.5, 5);
    expect(mapped.x).toBeCloseTo(startWorld.x, 5);
    expect(mapped.y).toBeCloseTo(startWorld.y, 5);
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 21, pointerType: "touch", clientX: 200, clientY: 250 }));
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 22, pointerType: "touch", clientX: 600, clientY: 250 }));
    current = transformOf(paper);
    mapped = worldPointAt(startCenter, current.scale, current.x, current.y);
    expect(current.scale).toBeCloseTo(initial.scale * 2, 5);
    expect(mapped.x).toBeCloseTo(startWorld.x, 5);
    expect(mapped.y).toBeCloseTo(startWorld.y, 5);
  });

  it("rebases a one-finger pan after pinch and pointer cancel", () => {
    const { canvas, paper, canvasController } = setup();
    canvasController.setTool({ kind: "hand" });
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 31, pointerType: "touch", clientX: 300, clientY: 300 }));
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 31, pointerType: "touch", clientX: 340, clientY: 320 }));
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 32, pointerType: "touch", clientX: 500, clientY: 320 }));
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 32, pointerType: "touch", clientX: 700, clientY: 320 }));
    canvas.dispatchEvent(pointer("pointercancel", { pointerId: 31, pointerType: "touch", clientX: 340, clientY: 320 }));
    const beforeSingleFingerMove = transformOf(paper);
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 32, pointerType: "touch", clientX: 710, clientY: 320 }));
    const afterSingleFingerMove = transformOf(paper);
    expect(afterSingleFingerMove.x - beforeSingleFingerMove.x).toBeCloseTo(10, 5);
    expect(Math.abs(afterSingleFingerMove.x - beforeSingleFingerMove.x)).toBeLessThan(20);
    canvas.dispatchEvent(pointer("pointercancel", { pointerId: 32, pointerType: "touch", clientX: 710, clientY: 320 }));
    const afterCancel = transformOf(paper);
    canvas.dispatchEvent(pointer("pointermove", { pointerId: 32, pointerType: "touch", clientX: 900, clientY: 320 }));
    expect(transformOf(paper)).toEqual(afterCancel);
  });

  it("preserves a custom zoom center when the viewport resizes", () => {
    const { paper, viewportRect, canvasController } = setup();
    canvasController.zoomBy(1.5);
    const before = transformOf(paper);
    const oldWorld = worldPointAt({ x: viewportRect.width / 2, y: viewportRect.height / 2 }, before.scale, before.x, before.y);
    viewportRect.width = 1000;
    viewportRect.height = 700;
    window.dispatchEvent(new Event("resize"));
    const after = transformOf(paper);
    const newWorld = worldPointAt({ x: viewportRect.width / 2, y: viewportRect.height / 2 }, after.scale, after.x, after.y);
    expect(newWorld.x).toBeCloseTo(oldWorld.x, 5);
    expect(newWorld.y).toBeCloseTo(oldWorld.y, 5);
  });
});
