import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperCanvas } from "../src/canvas";

function pointer(type: string, props: Record<string, unknown>): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  for (const [key, value] of Object.entries({ pointerId: 1, pointerType: "pen", clientX: 100, clientY: 100, button: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timeStamp: 10, ...props })) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  return event;
}

function setup(): { canvas: HTMLCanvasElement; paper: HTMLElement; viewport: HTMLElement; changes: ReturnType<typeof vi.fn>; canvasController: PaperCanvas } {
  const viewport = document.createElement("div");
  const paper = document.createElement("div");
  const canvas = document.createElement("canvas");
  viewport.append(paper);
  paper.append(canvas);
  document.body.append(viewport);
  Object.defineProperty(viewport, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 600, height: 700, right: 600, bottom: 700 }) });
  Object.defineProperty(canvas, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 512, height: 683, right: 512, bottom: 683 }) });
  const changes = vi.fn();
  const canvasController = new PaperCanvas(canvas, paper, viewport, { onChange: changes, onZoom: vi.fn() });
  canvasController.setPage("page", 1024, 1366, "blank", []);
  return { canvas, paper, viewport, changes, canvasController };
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

  it("drops a cancelled pen stroke without emitting a save", () => {
    const { canvas, changes } = setup();
    canvas.dispatchEvent(pointer("pointerdown", { timeStamp: 10 }));
    canvas.dispatchEvent(pointer("pointermove", { timeStamp: 15, clientX: 120 }));
    canvas.dispatchEvent(pointer("pointercancel", { timeStamp: 16 }));
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
});
