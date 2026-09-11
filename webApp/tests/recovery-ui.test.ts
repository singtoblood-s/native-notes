// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createNotebook, createPage, type NotePage, type Notebook } from "../src/models";

const state = vi.hoisted(() => ({
  notebooks: [] as Notebook[],
  pages: [] as NotePage[],
  options: null as null | { onStatus: (status: unknown) => void },
  savePage: vi.fn(),
}));

vi.mock("../src/coordinator", () => ({ SyncCoordinator: class {
  constructor(options: { onStatus: (status: unknown) => void }) { state.options = options; }
  start() {}
  stop() {}
  notifyLocalWrite() {}
  notifyAuthChanged() {}
  request() {}
} }));

vi.mock("../src/storage", () => ({ SQLiteNoteStore: { open: async () => ({
  accountKey: "https://sync.example.test:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  listNotebooks: async () => structuredClone(state.notebooks),
  listPages: async (notebookID: string) => structuredClone(state.pages.filter((page) => page.notebookId === notebookID)),
  getNotebook: async (notebookID: string) => structuredClone(state.notebooks.find((notebook) => notebook.id === notebookID) ?? null),
  getPage: async (pageID: string) => structuredClone(state.pages.find((page) => page.id === pageID) ?? null),
  savePage: (page: NotePage) => state.savePage(page),
}) } }));

vi.mock("../src/canvas", () => ({ PaperCanvas: class {
  readonly isInputActive = false;
  readonly hasUndo = false;
  readonly hasRedo = false;
  setTool() {}
  setPage() {}
  destroy() {}
  undo() {}
  redo() {}
  fitToViewport() {}
  fitToPage() {}
  zoomBy() {}
} }));

it("keeps recovery copies out of normal lists and exposes a durable keep action", async () => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("notepad.endpoint", "https://sync.example.test");
  sessionStorage.setItem("notepad.session", JSON.stringify({ endpoint: "https://sync.example.test", user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", identifier: "tester" }, sessionToken: "test-token", expiresAt: "2099-01-01T00:00:00Z" }));

  const firstNotebook = createNotebook("Notebook one");
  const secondNotebook = createNotebook("Notebook two");
  const normal = createPage(firstNotebook.id, "Normal page");
  const firstRecovery = createPage(firstNotebook.id, "Normal page · conflict");
  const secondRecovery = createPage(secondNotebook.id, "Other page · conflict");
  firstRecovery.conflictOf = normal.id;
  secondRecovery.conflictOf = normal.id;
  const stroke = { id: crypto.randomUUID(), color: 0xff252429, width: 3, points: [{ x: 1, y: 2, pressure: 0.5, time: 1, tiltX: null, tiltY: null }] };
  secondRecovery.strokes = [stroke];
  state.notebooks = [firstNotebook, secondNotebook];
  state.pages = [normal, firstRecovery, secondRecovery];
  state.savePage.mockImplementation(async (page: NotePage) => {
    const index = state.pages.findIndex((value) => value.id === page.id);
    if (index >= 0) state.pages[index] = structuredClone(page);
    return { status: "saved", revision: page.revision };
  });
  document.body.innerHTML = '<div id="app"></div>';

  try {
    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector("[data-open-book]")).not.toBeNull());
    expect(document.getElementById("recovery-count")?.textContent).toBe("2");
    const bookCaptions = [...document.querySelectorAll<HTMLElement>(".book-caption small")].map((caption) => caption.textContent ?? "");
    expect(bookCaptions.some((caption) => caption.startsWith("1 page"))).toBe(true);
    expect(bookCaptions.some((caption) => caption.startsWith("0 pages"))).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-open-book]')!.click();
    await vi.waitFor(() => expect(document.getElementById("page-title-label")?.textContent).toBe("Normal page"));
    expect(document.querySelectorAll("#page-list [data-page]")).toHaveLength(1);
    expect(document.getElementById("library-count")?.textContent).toBe("2 notebooks");

    document.getElementById("recovery-toggle")!.click();
    await vi.waitFor(() => expect(document.querySelectorAll("#page-list [data-page]")).toHaveLength(2));
    expect(document.getElementById("recovery-toggle")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.getElementById("recovery-page-badge")?.hidden).toBe(false);
    expect((document.getElementById("add-page") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("duplicate-page") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("new-page") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("new-notebook") as HTMLButtonElement).disabled).toBe(true);

    document.querySelector<HTMLButtonElement>(`#page-list [data-page="${secondRecovery.id}"]`)!.click();
    await vi.waitFor(() => expect(document.getElementById("notebook-name")?.textContent).toBe("Notebook two"));
    expect(document.getElementById("page-title-label")?.textContent).toBe(secondRecovery.title);
    document.getElementById("keep-page")!.click();
    await vi.waitFor(() => expect(document.getElementById("recovery-toggle")?.getAttribute("aria-pressed")).toBe("false"));
    expect(state.pages.find((page) => page.id === secondRecovery.id)?.conflictOf).toBeUndefined();
    expect(state.pages.find((page) => page.id === secondRecovery.id)?.strokes).toEqual([stroke]);
    expect(document.querySelectorAll("#page-list [data-page]")).toHaveLength(1);

    state.options!.onStatus({ state: "idle", reason: "periodic", pending: 0, pendingMayContinue: false, conflicts: 18, lastAttemptAt: "2026-09-11T10:00:00Z", lastSuccessAt: "2026-09-11T10:01:00Z", error: null });
    expect(document.getElementById("sync-label")?.textContent).toContain("Synced");
    expect(document.getElementById("sync-label")?.textContent).not.toContain("conflict");
  } finally {
    document.body.innerHTML = "";
    sessionStorage.clear();
    localStorage.clear();
  }
});
