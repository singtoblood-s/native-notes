import { expect, it, vi } from "vitest";
import { createNotebook, createPage, type Notebook, type NotePage } from "../src/models";

const data = vi.hoisted(() => ({ notebooks: [] as Notebook[], pages: [] as NotePage[], failSave: false }));
vi.mock("../src/coordinator", () => ({ SyncCoordinator: class {
  start() {} stop() {} notifyLocalWrite() {}
} }));
vi.mock("../src/storage", () => ({ SQLiteNoteStore: { open: async () => ({
  accountKey: "https://sync.example.test:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  listNotebooks: async () => structuredClone(data.notebooks),
  listPages: async (id: string) => structuredClone(data.pages.filter((page) => page.notebookId === id)),
  getNotebook: async (id: string) => structuredClone(data.notebooks.find((notebook) => notebook.id === id)),
  getPage: async (id: string) => structuredClone(data.pages.find((page) => page.id === id)),
  saveNotebook: async (notebook: Notebook) => {
    data.notebooks.push(structuredClone(notebook));
    return { status: "saved", revision: 1 };
  },
  savePage: async (page: NotePage) => {
    if (data.failSave) return { status: "failed", message: "Disk full" };
    const index = data.pages.findIndex((item) => item.id === page.id);
    if (index < 0) data.pages.push(structuredClone(page));
    else data.pages[index] = structuredClone(page);
    return { status: "saved", revision: 1 };
  },
}) } }));

it("creates notebooks, preserves tool settings, duplicates paper and prevents navigation after a failed save", async () => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("notepad.endpoint", "https://sync.example.test");
  sessionStorage.setItem("notepad.session", JSON.stringify({ endpoint: "https://sync.example.test", user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", identifier: "tester" }, sessionToken: "test-token", expiresAt: "2099-01-01T00:00:00Z" }));
  // Damaged optional settings must not stop the notebook from opening.
  localStorage.setItem("notepad.writing-tools", '{"kind":"unknown","settings":{"pen":{"width":-1}}}');
  const notebook = createNotebook("Original notebook");
  const original = createPage(notebook.id, "Original page");
  original.background = "grid";
  original.text = "ข้อความทดสอบ";
  data.notebooks = [notebook];
  data.pages = [original];
  document.body.innerHTML = '<div id="app"></div>';
  const context = new Proxy({}, { get: () => vi.fn(), set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as CanvasRenderingContext2D);
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
  const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  try {
    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector("[data-open-book]")).not.toBeNull());
    expect(element("library").hidden).toBe(false);
    expect(element("editor-workspace").hidden).toBe(true);
    document.querySelector<HTMLButtonElement>("[data-favorite]")!.click();
    element("library-favorites").click();
    expect(document.querySelectorAll("[data-open-book]")).toHaveLength(1);
    const search = element<HTMLInputElement>("library-search");
    search.value = "ข้อความทดสอบ";
    search.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll("[data-open-book]")).toHaveLength(1);
    search.value = "no matching notebook";
    search.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll("[data-open-book]")).toHaveLength(0);
    element("library-documents").click();
    document.querySelector<HTMLButtonElement>("[data-open-book]")!.click();
    await vi.waitFor(() => expect(element("page-title-label")?.textContent).toBe("Original page"));
    expect(element("editor-workspace").hidden).toBe(false);
    element("highlighter-tool").click();
    expect(element("highlighter-tool").getAttribute("aria-pressed")).toBe("true");
    expect(element<HTMLInputElement>("width-range").value).toBe("18");
    element("pen-tool").click();
    expect(element<HTMLInputElement>("width-range").value).toBe("3");
    element("highlighter-tool").click();
    expect(JSON.parse(localStorage.getItem("notepad.writing-tools")!).settings.highlighter.width).toBe(18);

    element("duplicate-page").click();
    await vi.waitFor(() => expect(element("page-title-label").textContent).toBe("Original page (copy)"));
    expect(data.pages[1]).toMatchObject({ background: "grid", text: "ข้อความทดสอบ" });
    expect(data.pages[1]!.id).not.toBe(original.id);
    element("add-page").click();
    await vi.waitFor(() => expect(element("page-position").textContent).toBe("3 / 3"));
    expect(data.pages[2]).toMatchObject({ background: "grid", text: "", strokes: [] });

    const text = element<HTMLTextAreaElement>("page-text");
    text.value = "Not saved yet";
    text.dispatchEvent(new Event("input"));
    data.failSave = true;
    element("previous-page").click();
    await vi.waitFor(() => expect(element("sync-label").textContent).toBe("Disk full"));
    expect(element("page-position").textContent).toBe("3 / 3");
    element("back-library").click();
    await vi.waitFor(() => expect(element("sync-label").textContent).toBe("Disk full"));
    expect(element("library").hidden).toBe(true);
    element("previous-page").click();
    await vi.waitFor(() => expect(element("sync-label").textContent).toBe("Disk full"));
    expect(element("page-position").textContent).toBe("3 / 3");
    data.failSave = false;
    element("previous-page").click();
    await vi.waitFor(() => expect(element("page-position").textContent).toBe("2 / 3"));
    expect(data.pages[2]!.text).toBe("Not saved yet");

    element("back-library").click();
    await vi.waitFor(() => expect(element("library").hidden).toBe(false));
    expect(element("editor-workspace").hidden).toBe(true);
    element("library-new").click();
    expect(element("new-document-dialog").hasAttribute("open")).toBe(true);
    element("new-document-notebook").click();
    expect(element("notebook-dialog").hasAttribute("open")).toBe(true);
    element<HTMLInputElement>("notebook-title").value = "Created in the app";
    document.querySelector<HTMLButtonElement>('[data-paper="grid"]')!.click();
    element("notebook-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(element("notebook-name").textContent).toBe("Created in the app"));
    expect(element("notebook-dialog").hasAttribute("open")).toBe(false);
    expect(element("page-position").textContent).toBe("1 / 1");
    expect(data.pages.at(-1)!.background).toBe("grid");
    expect(element("library").hidden).toBe(true);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sessionStorage.clear();
    localStorage.clear();
    document.body.innerHTML = "";
  }
});
