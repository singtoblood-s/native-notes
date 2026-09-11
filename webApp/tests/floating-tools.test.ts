import { afterEach, expect, it, vi } from "vitest";
import { FloatingTools } from "../src/floating-tools";

let controller: AbortController;
function setup() {
  controller = new AbortController();
  document.body.innerHTML = `<main id="editor-workspace"><header class="topbar"><div class="top-actions"></div><button id="sync-button" aria-label="Saved locally" data-state="saved"><span data-sync-icon>✓</span></button></header><div id="editor-content"><div class="editor-toolbar"><button class="tool-button active" id="pen-tool"><svg></svg></button></div><div class="page-bar"></div><div class="stage-foot"><span id="tool-name">Pen</span></div></div></main>`;
  const closeMenus = vi.fn();
  const canToggle = vi.fn(() => true);
  new FloatingTools(controller.signal, closeMenus, canToggle);
  return { closeMenus, canToggle };
}
const element = (id: string) => document.getElementById(id)!;
afterEach(() => { controller?.abort(); localStorage.clear(); document.body.innerHTML = ""; vi.restoreAllMocks(); });

it("preserves controls, guards active strokes and restores the docked layout", () => {
  const { canToggle } = setup();
  const pen = element("pen-tool");
  const clicked = vi.fn();
  pen.addEventListener("click", clicked);
  canToggle.mockReturnValue(false);
  element("float-tools").click();
  expect(element("floating-tools-button").hidden).toBe(true);
  canToggle.mockReturnValue(true);
  element("float-tools").click();
  expect(element("floating-tools-button").hidden).toBe(false);
  expect(element("floating-tools-panel").hidden).toBe(true);
  element("floating-tools-button").click();
  expect(element("floating-tools-panel").contains(pen)).toBe(true);
  pen.click();
  expect(clicked).toHaveBeenCalledOnce();
  element("dock-tools").click();
  expect(element("editor-content").contains(pen)).toBe(true);
  expect(document.activeElement).toBe(element("float-tools"));
  expect(JSON.parse(localStorage.getItem("notepad.floating-tools")!).floating).toBe(false);
});

it("clamps saved positions, starts closed and keeps save failures visible on the bubble", async () => {
  localStorage.setItem("notepad.floating-tools", JSON.stringify({ floating: true, x: 100, y: -100 }));
  setup();
  expect(element("floating-tools-button").hidden).toBe(false);
  expect(element("floating-tools-panel").hidden).toBe(true);
  expect(element("floating-tools-button").style.top).toBe("12px");
  expect(Number.parseFloat(element("floating-tools-button").style.left)).toBeLessThan(window.innerWidth - 56);
  element("sync-button").dataset.state = "error";
  element("sync-button").setAttribute("aria-label", "Disk full");
  await Promise.resolve();
  expect(element("floating-tools-button").dataset.state).toBe("error");
  expect(element("floating-tools-button").getAttribute("aria-label")).toContain("Disk full");
  element("floating-tools-button").click();
  element("editor-workspace").hidden = true;
  await Promise.resolve();
  expect(element("floating-tools-panel").hidden).toBe(true);
  element("sync-button").setAttribute("aria-label", "Saved locally");
  document.body.innerHTML = "";
  await Promise.resolve(); // A queued status update after shell removal must be harmless.
});

it("remains usable with damaged or unavailable optional storage", () => {
  localStorage.setItem("notepad.floating-tools", "broken json");
  setup();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  element("float-tools").click();
  element("floating-tools-button").click();
  expect(element("floating-tools-panel").hidden).toBe(false);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(element("floating-tools-panel").hidden).toBe(true);
  expect(document.activeElement).toBe(element("floating-tools-button"));
});
