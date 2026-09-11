import { expect, it, vi } from "vitest";
import { createNotebook, createPage, type NotePage, type Notebook } from "../src/models";

const state = vi.hoisted(() => ({
  notebooks: [] as Notebook[],
  pages: [] as NotePage[],
  getPage: vi.fn(),
  savePage: vi.fn(),
}));

vi.mock("../src/coordinator", () => ({ SyncCoordinator: class {
  start() {}
  stop() {}
  notifyLocalWrite() {}
  notifyAuthChanged() {}
} }));

vi.mock("../src/storage", () => ({ SQLiteNoteStore: { open: async () => ({
  accountKey: "https://sync.example.test:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  listNotebooks: async () => structuredClone(state.notebooks),
  listPages: async (notebookID: string) => structuredClone(state.pages.filter((page) => page.notebookId === notebookID)),
  getNotebook: async (notebookID: string) => structuredClone(state.notebooks.find((notebook) => notebook.id === notebookID) ?? null),
  getPage: (pageID: string) => state.getPage(pageID),
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

it("keeps the newest page selection and coalesces rapid back taps into one durable save", async () => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("notepad.endpoint", "https://sync.example.test");
  sessionStorage.setItem("notepad.session", JSON.stringify({ endpoint: "https://sync.example.test", user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", identifier: "tester" }, sessionToken: "test-token", expiresAt: "2099-01-01T00:00:00Z" }));

  const notebook = createNotebook("Notebook");
  const first = createPage(notebook.id, "First page");
  const second = createPage(notebook.id, "Second page");
  state.notebooks = [notebook];
  state.pages = [first, second];
  state.getPage.mockImplementation(async (pageID: string) => structuredClone(state.pages.find((page) => page.id === pageID) ?? null));
  state.savePage.mockImplementation(async (page: NotePage) => {
    const index = state.pages.findIndex((value) => value.id === page.id);
    if (index >= 0) state.pages[index] = structuredClone(page);
    return { status: "saved", revision: page.revision };
  });
  document.body.innerHTML = '<div id="app"></div>';

  try {
    await import("../src/main");
    await vi.waitFor(() => expect(document.querySelector("[data-open-book]")).not.toBeNull());
    document.querySelector<HTMLButtonElement>("[data-open-book]")!.click();
    await vi.waitFor(() => expect(document.getElementById("page-title-label")?.textContent).toBe("First page"));

    const reads = new Map<string, ReturnType<typeof deferred<NotePage | null>>>();
    state.getPage.mockImplementation((pageID: string) => {
      const result = deferred<NotePage | null>();
      reads.set(pageID, result);
      return result.promise;
    });
    document.querySelector<HTMLButtonElement>(`[data-page="${second.id}"]`)!.click();
    await vi.waitFor(() => expect(reads.has(second.id)).toBe(true));
    document.getElementById("back-library")!.click();
    await vi.waitFor(() => expect(document.getElementById("library")!.hidden).toBe(false));
    reads.get(second.id)!.resolve(structuredClone(second));
    await settle();
    expect(document.getElementById("library")!.hidden).toBe(false);

    document.querySelector<HTMLButtonElement>("[data-open-book]")!.click();
    await vi.waitFor(() => expect(document.getElementById("page-title-label")?.textContent).toBe("First page"));
    reads.clear();
    document.querySelector<HTMLButtonElement>(`[data-page="${second.id}"]`)!.click();
    await vi.waitFor(() => expect(reads.has(second.id)).toBe(true));
    const text = document.getElementById("page-text") as HTMLTextAreaElement;
    text.value = "edited during read";
    text.dispatchEvent(new Event("input"));
    reads.get(second.id)!.resolve(structuredClone(second));
    await settle();
    expect(document.getElementById("page-title-label")?.textContent).toBe("First page");
    expect(text.value).toBe("edited during read");
    document.getElementById("back-library")!.click();
    await vi.waitFor(() => expect(document.getElementById("library")!.hidden).toBe(false));
    state.savePage.mockClear();

    document.querySelector<HTMLButtonElement>("[data-open-book]")!.click();
    await vi.waitFor(() => expect(document.getElementById("page-title-label")?.textContent).toBe("First page"));
    reads.clear();
    document.querySelector<HTMLButtonElement>(`[data-page="${second.id}"]`)!.click();
    await vi.waitFor(() => expect(reads.has(second.id)).toBe(true));
    document.querySelector<HTMLButtonElement>(`[data-page="${first.id}"]`)!.click();
    await vi.waitFor(() => expect(reads.has(first.id)).toBe(true));
    reads.get(first.id)!.resolve(structuredClone(first));
    await vi.waitFor(() => expect(document.getElementById("page-title-label")?.textContent).toBe("First page"));
    reads.get(second.id)!.resolve(structuredClone(second));
    await settle();
    expect(document.getElementById("page-title-label")?.textContent).toBe("First page");

    const pendingSaves = [deferred<{ status: "saved"; revision: number }>(), deferred<{ status: "saved"; revision: number }>()];
    let saveCount = 0;
    state.savePage.mockImplementation(async (page: NotePage) => {
      const index = state.pages.findIndex((value) => value.id === page.id);
      if (index >= 0) state.pages[index] = structuredClone(page);
      return pendingSaves[saveCount++]!.promise;
    });
    text.value = "pending text";
    text.dispatchEvent(new Event("input"));
    document.getElementById("back-library")!.click();
    document.getElementById("back-library")!.click();
    await vi.waitFor(() => expect(state.savePage).toHaveBeenCalledTimes(1));
    expect(document.getElementById("library")!.hidden).toBe(true);
    text.value = "newer text";
    text.dispatchEvent(new Event("input"));
    document.getElementById("back-library")!.click();
    pendingSaves[0]!.resolve({ status: "saved", revision: first.revision });
    await vi.waitFor(() => expect(state.savePage).toHaveBeenCalledTimes(2));
    pendingSaves[1]!.resolve({ status: "saved", revision: first.revision });
    await vi.waitFor(() => expect(document.getElementById("library")!.hidden).toBe(false));
    await settle();
    expect(state.savePage).toHaveBeenCalledTimes(2);
    expect(state.savePage.mock.calls[0]![0].text).toBe("pending text");
    expect(state.savePage.mock.calls[1]![0].text).toBe("newer text");
  } finally {
    document.body.innerHTML = "";
    sessionStorage.clear();
    localStorage.clear();
  }
});
