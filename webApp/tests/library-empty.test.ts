import { expect, it, vi } from "vitest";

const writes = vi.hoisted(() => vi.fn());
vi.mock("../src/coordinator", () => ({ SyncCoordinator: class {
  start() {} stop() {} notifyLocalWrite() { writes(); }
} }));
vi.mock("../src/storage", () => ({ SQLiteNoteStore: { open: async () => ({
  accountKey: "https://sync.example.test:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", listNotebooks: async () => [], listPages: async () => [],
  getPage: async () => null, getNotebook: async () => null,
  ensureStarterData: writes, saveNotebook: writes, savePage: writes,
}) } }));
vi.mock("../src/canvas", () => ({ PaperCanvas: class { setTool() {} } }));

it("opens a truly empty library without creating or entering a notebook, including stale saved selection", async () => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("notepad.endpoint", "https://sync.example.test");
  sessionStorage.setItem("notepad.session", JSON.stringify({ endpoint: "https://sync.example.test", user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", identifier: "tester" }, sessionToken: "test-token", expiresAt: "2099-01-01T00:00:00Z" }));
  localStorage.setItem("notepad.selection:https://sync.example.test:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", JSON.stringify({
    notebookID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pageID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  }));
  document.body.innerHTML = '<div id="app"></div>';
  try {
    await import("../src/main");
    await vi.waitFor(() => expect(document.getElementById("library-empty")?.textContent).toContain("Create your first notebook"));
    expect(document.getElementById("library")!.hidden).toBe(false);
    expect(document.getElementById("editor-workspace")!.hidden).toBe(true);
    expect(document.querySelectorAll("[data-open-book]")).toHaveLength(0);
    expect(writes).not.toHaveBeenCalled();
  } finally {
    document.body.innerHTML = "";
    sessionStorage.clear();
    localStorage.clear();
  }
});
