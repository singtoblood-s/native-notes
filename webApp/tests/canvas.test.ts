import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPanBounds, MAX_HISTORY_POINTS, MOBILE_FIT_GUTTER, PAN_MARGIN, PaperCanvas, worldPointAt } from "../src/canvas";

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
  viewportRect: { width: number; height: number };
} {
  const viewport = document.createElement("div");
  const paper = document.createElement("div");
  const canvas = document.createElement("canvas");
  viewport.append(paper);
  paper.append(canvas);
  document.body.append(viewport);
  const viewportRect = { width: 800, height: 600 };
  Object.defineProperty(viewport, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: viewportRect.width, height: viewportRect.height, right: viewportRect.width, bottom: viewportRect.height }) });
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

  it("drops a cancelled pen stroke without emitting a save", () => {
    const { canvas, changes, canvasController } = setup();
    canvas.dispatchEvent(pointer("pointerdown", { timeStamp: 10 }));
    expect(canvasController.isInputActive).toBe(true);
    canvas.dispatchEvent(pointer("pointermove", { timeStamp: 15, clientX: 120 }));
    canvas.dispatchEvent(pointer("pointercancel", { timeStamp: 16 }));
    expect(canvasController.isInputActive).toBe(false);
    expect(changes).not.toHaveBeenCalled();
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

  it("keeps input active for touch navigation until the last finger ends", () => {
    const { canvas, canvasController } = setup();
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 41, pointerType: "touch", clientX: 250, clientY: 250 }));
    canvas.dispatchEvent(pointer("pointerdown", { pointerId: 42, pointerType: "touch", clientX: 450, clientY: 250 }));
    expect(canvasController.isInputActive).toBe(true);
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 41, pointerType: "touch", clientX: 250, clientY: 250 }));
    expect(canvasController.isInputActive).toBe(true);
    canvas.dispatchEvent(pointer("pointerup", { pointerId: 42, pointerType: "touch", clientX: 450, clientY: 250 }));
    expect(canvasController.isInputActive).toBe(false);
  });

  it("fits writing view to width and keeps a dragged page reachable", () => {
    const { canvas, paper, viewportRect } = setup();
    const initial = transformOf(paper);
    expect(initial.scale).toBeCloseTo((viewportRect.width - PAN_MARGIN * 2) / 1024, 6);

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
    const { canvas, paper } = setup();
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
