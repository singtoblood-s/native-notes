// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createNotebook, createPage, type NotePage, type Notebook } from "../src/models";

const state = vi.hoisted(() => ({
  notebooks: [] as Notebook[],
  pages: [] as NotePage[],
  options: null as null | { onStatus: (status: unknown) => void },
  request: vi.fn(),
}));

vi.mock("../src/coordinator", () => ({ SyncCoordinator: class {
  constructor(options: { onStatus: (status: unknown) => void }) { state.options = options; }
  start() {}
  stop() {}
  notifyLocalWrite() {}
  notifyAuthChanged() {}
  request(reason: string) { state.request(reason); }
} }));

vi.mock("../src/storage", () => ({ SQLiteNoteStore: { open: async () => ({
  accountKey: "https://sync.example.test:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  listNotebooks: async () => structuredClone(state.notebooks),
  listPages: async (notebookID: string) => structuredClone(state.pages.filter((page) => page.notebookId === notebookID)),
  getNotebook: async (notebookID: string) => structuredClone(state.notebooks.find((notebook) => notebook.id === notebookID) ?? null),
  getPage: async (pageID: string) => structuredClone(state.pages.find((page) => page.id === pageID) ?? null),
}) } }));

vi.mock("../src/canvas", () => ({ PaperCanvas: class {
  readonly isInputActive = false;
  readonly hasUndo = false;
  readonly hasRedo = false;
  setTool() {}
  setPage() {}
  destroy() {}
} }));

it("keeps sync status and manual retry visible outside the editor", async () => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("notepad.endpoint", "https://sync.example.test");
  sessionStorage.setItem("notepad.session", JSON.stringify({ endpoint: "https://sync.example.test", user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", identifier: "tester" }, sessionToken: "test-token", expiresAt: "2099-01-01T00:00:00Z" }));
  const notebook = createNotebook("Shared notebook");
  state.notebooks = [notebook];
  state.pages = [createPage(notebook.id, "First page")];
  document.body.innerHTML = '<div id="app"></div>';
  try {
    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector("[data-open-book]")).not.toBeNull());
    expect(document.getElementById("library-sync-label")?.textContent).toBe("Saved locally");
    expect(document.getElementById("settings-sync-label")?.textContent).toBe("Saved locally");

    state.options!.onStatus({ state: "scheduled", reason: "local-write", pending: 2, pendingMayContinue: false, conflicts: 0, lastAttemptAt: null, lastSuccessAt: null, error: null });
    expect(document.getElementById("library-sync-label")?.textContent).toBe("Saved locally · 2 queued");
    expect(document.getElementById("settings-sync-label")?.textContent).toBe("Saved locally · 2 queued");

    state.options!.onStatus({ state: "error", reason: "retry", pending: 2, pendingMayContinue: false, conflicts: 0, lastAttemptAt: null, lastSuccessAt: null, error: "Sync unavailable" });
    expect(document.getElementById("library-sync-label")?.textContent).toBe("Sync unavailable");
    expect(document.getElementById("settings-sync-label")?.textContent).toBe("Sync unavailable");
    document.getElementById("library-sync-button")!.click();
    document.getElementById("settings-sync-button")!.click();
    expect(state.request).toHaveBeenNthCalledWith(1, "manual");
    expect(state.request).toHaveBeenNthCalledWith(2, "manual");
  } finally {
    document.body.innerHTML = "";
    sessionStorage.clear();
    localStorage.clear();
  }
});
