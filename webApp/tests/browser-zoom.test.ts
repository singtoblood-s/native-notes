import { expect, it } from "vitest";
import { lockBrowserZoom } from "../src/browser-zoom";

it("blocks browser zoom without swallowing paper gestures, ordinary scrolling, or text input", () => {
  const unlock = lockBrowserZoom();
  const field = document.createElement("input");
  document.body.append(field);
  try {
    for (const modifier of ["ctrlKey", "metaKey"]) {
      for (const key of ["+", "=", "-", "_", "0"]) {
        const event = new KeyboardEvent("keydown", { key, [modifier]: true, bubbles: true, cancelable: true });
        field.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      const wheel = new WheelEvent("wheel", { [modifier]: true, deltaY: -100, bubbles: true, cancelable: true });
      let reachedPaper = false;
      field.addEventListener("wheel", () => { reachedPaper = true; }, { once: true });
      field.dispatchEvent(wheel);
      expect(wheel.defaultPrevented).toBe(true);
      expect(reachedPaper).toBe(true);
    }
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
      const gesture = new Event(type, { bubbles: true, cancelable: true });
      field.dispatchEvent(gesture);
      expect(gesture.defaultPrevented).toBe(true);
    }
    for (const count of [1, 2, 3]) {
      const touch = new Event("touchmove", { bubbles: true, cancelable: true });
      Object.defineProperty(touch, "touches", { value: Array(count).fill({}) });
      field.dispatchEvent(touch);
      expect(touch.defaultPrevented).toBe(count > 1);
    }
    for (const event of [
      new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }),
      new KeyboardEvent("keydown", { key: "+", bubbles: true, cancelable: true }),
      new KeyboardEvent("keydown", { key: "=", ctrlKey: true, altKey: true, bubbles: true, cancelable: true }),
      new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true }),
    ]) {
      field.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  } finally { unlock(); field.remove(); }
});
