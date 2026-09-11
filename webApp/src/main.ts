import "./styles.css";
import { AuthClient, AuthSession, getEndpoint, setEndpoint, workspaceAccountKey } from "./auth";
import { PaperCanvas, CanvasTool } from "./canvas";
import {
  InkStroke,
  NotePage,
  Notebook,
  PageBackground,
  SyncState,
  clonePage,
  createPage,
  createNotebook,
  isUUID,
  now,
} from "./models";
import { Archive, NoteStore, SQLiteNoteStore } from "./storage";
import { SyncCoordinator, SyncCoordinatorStatus, SyncCompleteContext } from "./coordinator";
import { SyncClient } from "./sync";
import { removeGuestData } from "./remove-guest-data";

const BASE = import.meta.env.BASE_URL;
type OfflineCacheStatus = "preparing" | "ready" | "error" | "unsupported" | "development";
interface SavedSelection { notebookID?: string; pageID?: string; }

class NotePadApp {
  private readonly root: HTMLElement;
  private readonly auth = new AuthSession();
  private readonly authClient = new AuthClient();
  private readonly syncClient = new SyncClient();
  private readonly coordinator = new SyncCoordinator({
    getStore: () => this.store,
    getSession: () => this.auth.session,
    client: this.syncClient,
    onStatus: (status) => this.handleCoordinatorStatus(status),
    onBeforeSync: async () => this.beforeCoordinatorSync(),
    onAfterSync: (context) => this.afterCoordinatorSync(context),
  });
  private store!: NoteStore;
  private notebooks: Notebook[] = [];
  private pages: NotePage[] = [];
  private allPages: NotePage[] = [];
  private currentPage: NotePage | null = null;
  private currentNotebook: Notebook | null = null;
  private canvas: PaperCanvas | null = null;
  private saveTimer: number | null = null;
  private saveInFlight: Promise<boolean> | null = null;
  private unsavedPageID: string | null = null;
  private editGeneration = 0;
  private search = "";
  private showTrash = false;
  private view: "library" | "editor" = "library";
  private libraryTab: "documents" | "favorites" | "search" = "documents";
  private selectedTool: CanvasTool["kind"] = "pen";
  private readonly toolSettings = {
    pen: { color: 0xff252429, width: 3 },
    highlighter: { color: 0xfff2ca52, width: 18 },
    line: { color: 0xff252429, width: 3 },
    eraser: { width: 6 },
  };
  private loginRequired = false;
  private offlineCacheStatus: OfflineCacheStatus = "preparing";
  private offlineCacheMessage = "Preparing offline cache…";
  private coordinatorGeneration = -1;
  private pendingRemoteRefresh: { store: NoteStore; conflicts: number } | null = null;
  private remoteRefreshTimer: number | null = null;
  private navigationGeneration = 0;
  private readonly handlePageHide = (): void => { void this.flushPendingSave(); };

  constructor(root: HTMLElement) {
    this.root = root;
    document.addEventListener("keydown", (event) => { if (!this.loginRequired) this.handleShortcut(event); });
    window.addEventListener("pagehide", this.handlePageHide, { capture: true });
    window.setInterval(() => {
      if (document.getElementById("auth-dialog") && !this.loginRequired && !this.auth.session) this.requireLogin();
    }, 1_000);
    void this.start();
  }

  private async start(): Promise<void> {
    this.root.innerHTML = loadingMarkup();
    try {
      await removeGuestData();
      if (!this.auth.session) {
        this.root.innerHTML = authMarkup();
        this.bindAuthEvents();
        this.requireLogin();
        void this.registerServiceWorker();
        return;
      }
      this.store = await SQLiteNoteStore.open(this.accountKey());
      const startupSession = this.auth.session;
      // An empty workspace starts in the library; notebook creation is explicit.
      this.renderShell();
      await this.reload();
      this.setState(startupSession ? { kind: "saved" } : { kind: "needs-login" });
      this.coordinator.start();
      void this.registerServiceWorker();
    } catch (error) {
      this.root.innerHTML = errorMarkup(error instanceof Error ? error.message : "Could not open the local notebook.");
    }
  }

  private accountKey(): string {
    const key = this.store?.accountKey ?? this.auth.workspaceKey;
    if (!key) throw new Error("Sign in to open a notebook.");
    return key;
  }

  private bindAuthEvents(): void {
    byId("auth-form").addEventListener("submit", (event) => { event.preventDefault(); void this.submitAuth(); });
    onClick("register-mode", () => this.setAuthMode("register"));
    onClick("login-mode", () => this.setAuthMode("login"));
    byId("auth-dialog").addEventListener("cancel", (event) => { if (this.loginRequired) event.preventDefault(); });
    const dialog = byId<HTMLDialogElement>("auth-dialog");
    dialog.addEventListener("close", () => {
      if (this.loginRequired && dialog.isConnected && !dialog.open) dialog.showModal();
    });
  }

  private requireLogin(): void {
    this.loginRequired = true;
    this.root.classList.add("login-required");
    this.pauseCoordinatorForStoreSwitch();
    this.auth.clear();
    document.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach((dialog) => dialog.close());
    this.setAuthMode("login");
    byId<HTMLInputElement>("auth-endpoint").value = getEndpoint();
    byId("auth-endpoint").closest("details")!.open = !getEndpoint();
    byId<HTMLInputElement>("auth-password").value = "";
    this.openDialog("auth-dialog");
  }

  private selectionStorageKey(): string { return `notepad.selection:${this.accountKey()}`; }

  private readSelection(): SavedSelection {
    try {
      const parsed = JSON.parse(localStorage.getItem(this.selectionStorageKey()) ?? "null") as SavedSelection | null;
      if (!parsed || typeof parsed !== "object") return {};
      return {
        notebookID: typeof parsed.notebookID === "string" && isUUID(parsed.notebookID) ? parsed.notebookID : undefined,
        pageID: typeof parsed.pageID === "string" && isUUID(parsed.pageID) ? parsed.pageID : undefined,
      };
    } catch { return {}; }
  }

  private rememberSelection(): void {
    try {
      localStorage.setItem(this.selectionStorageKey(), JSON.stringify({ notebookID: this.currentNotebook?.id, pageID: this.currentPage?.id } satisfies SavedSelection));
    } catch { /* localStorage can be unavailable in private browsing */ }
  }

  private renderShell(): void {
    this.root.innerHTML = shellMarkup(this.auth);
    const canvas = byId<HTMLCanvasElement>("ink-canvas");
    this.canvas = new PaperCanvas(canvas, byId("paper"), byId("paper-viewport"), {
      onChange: (strokes) => this.handleCanvasChange(strokes),
      onZoom: (scale) => {
        byId("zoom-label").textContent = `${Math.round(scale * 100)}%`;
      },
    });
    this.bindEvents();
    this.restoreToolSettings();
    this.selectTool(this.selectedTool);
    byId<HTMLInputElement>("endpoint-input").value = getEndpoint();
    this.renderWorkspaceRecovery();
    this.setOfflineCacheStatus(this.offlineCacheStatus, this.offlineCacheMessage);
    this.syncDrawerState();
  }

  private bindEvents(): void {
    const updatePaperPreview = (): void => {
      const value = byId<HTMLSelectElement>("new-paper").value;
      document.querySelectorAll<HTMLButtonElement>("[data-paper]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.paper === value)));
    };
    byId("new-paper").addEventListener("change", updatePaperPreview);
    document.querySelectorAll<HTMLButtonElement>("[data-paper]").forEach((button) => button.addEventListener("click", () => {
      byId<HTMLSelectElement>("new-paper").value = button.dataset.paper!;
      updatePaperPreview();
    }));
    onClick("back-library", () => { void this.openLibrary(); });
    onClick("library-settings", () => this.openSettings());
    onClick("library-account", () => this.openAuthDialog());
    onClick("library-trash", async () => {
      if (!(await this.flushPendingSave())) return;
      this.view = "editor";
      this.showTrash = true;
      await this.reload();
      await this.toggleDrawer("sidebar");
    });
    onClick("library-new", () => this.openDialog("new-document-dialog"));
    onClick("cancel-new-document", () => this.closeDialog("new-document-dialog"));
    onClick("new-document-notebook", () => {
      this.closeDialog("new-document-dialog");
      this.openNotebookRename(true);
    });
    onClick("new-document-import", () => {
      this.closeDialog("new-document-dialog");
      this.openSettings();
      byId<HTMLInputElement>("import-input").click();
    });
    byId("library-search").addEventListener("input", () => this.renderLibrary());
    byId("library-sort").addEventListener("change", () => this.renderLibrary());
    byId("library-layout").addEventListener("click", () => {
      const button = byId("library-layout");
      const list = button.getAttribute("aria-pressed") !== "true";
      button.setAttribute("aria-pressed", String(list));
      byId("library-books").classList.toggle("is-list", list);
    });
    for (const name of ["documents", "favorites", "search"] as const) onClick(name === "search" ? "library-tab-search" : `library-${name}`, () => {
      this.libraryTab = name;
      byId<HTMLInputElement>("library-search").value = "";
      this.renderLibrary();
      if (name === "search") byId<HTMLInputElement>("library-search").focus();
    });
    onClick("new-notebook", () => this.openNotebookRename(true));
    onClick("new-page", () => this.createNewPage());
    onClick("trash-toggle", () => { void this.toggleTrash(); });
    onClick("mobile-menu", () => { void this.toggleDrawer("sidebar"); });
    onClick("close-sidebar", () => { void this.closeDrawers(); });
    onClick("drawer-backdrop", () => { void this.closeDrawers(); });
    onClick("text-toggle", () => { void this.toggleTextDrawer(); });
    onClick("close-inspector", () => { void this.closeDrawers(); });
    onClick("rename-notebook", () => this.openNotebookRename());
    onClick("rename-page", () => { void this.openTextDrawer(true); });
    onClick("sync-button", () => this.sync());
    onClick("undo-button", () => { this.canvas?.undo(); this.updateToolbar(); });
    onClick("redo-button", () => { this.canvas?.redo(); this.updateToolbar(); });
    onClick("fit-button", () => this.canvas?.fitToViewport());
    onClick("zoom-out", () => this.canvas?.zoomBy(0.86));
    onClick("zoom-in", () => this.canvas?.zoomBy(1.16));
    onClick("pen-tool", () => this.selectTool("pen"));
    onClick("eraser-tool", () => this.selectTool("eraser"));
    onClick("highlighter-tool", () => this.selectTool("highlighter"));
    onClick("line-tool", () => this.selectTool("line"));
    onClick("hand-tool", () => this.selectTool("hand"));
    onClick("previous-page", () => { void this.turnPage(-1); });
    onClick("next-page", () => { void this.turnPage(1); });
    onClick("add-page", () => { void this.createNewPage(); });
    onClick("duplicate-page", () => { void this.createNewPage(true); });
    onClick("fit-whole-page", () => this.canvas?.fitToPage());
    byId<HTMLSelectElement>("pen-style").addEventListener("change", () => this.selectTool("pen"));
    document.querySelectorAll<HTMLButtonElement>("[data-width]").forEach((button) => button.addEventListener("click", () => {
      const range = byId<HTMLInputElement>("width-range");
      range.value = button.dataset.width!;
      range.dispatchEvent(new Event("input"));
    }));
    onClick("print-button", () => window.print());
    onClick("export-button", () => this.exportArchive());
    onClick("share-button", () => this.shareArchive());
    onClick("settings-button", () => this.openSettings());
    onClick("auth-button", () => this.openAuthDialog());
    onClick("logout-button", () => this.logout());
    onClick("archive-notebook", () => this.archiveCurrentNotebook());
    onClick("delete-page", () => this.deleteCurrentPage());
    onClick("cancel-settings", () => this.closeDialog("settings-dialog"));
    onClick("cancel-notebook", () => this.closeDialog("notebook-dialog"));
    onClick("browse-import", () => byId<HTMLInputElement>("import-input").click());
    onClick("settings-export", () => this.exportArchive());
    onClick("settings-share", () => this.shareArchive());
    byId<HTMLInputElement>("import-input").addEventListener("change", (event) => this.importArchive(event));
    byId<HTMLInputElement>("search-input").addEventListener("input", (event) => {
      this.search = (event.target as HTMLInputElement).value.trim().toLocaleLowerCase();
      this.renderLists();
    });
    byId<HTMLInputElement>("page-title").addEventListener("input", (event) => {
      if (!this.currentPage) return;
      this.currentPage.title = (event.target as HTMLInputElement).value || "Untitled page";
      byId("page-title-label").textContent = this.currentPage.title;
      this.editGeneration += 1;
      this.scheduleSave();
      this.renderLists();
    });
    byId<HTMLTextAreaElement>("page-text").addEventListener("input", (event) => {
      if (!this.currentPage) return;
      this.currentPage.text = (event.target as HTMLTextAreaElement).value;
      this.editGeneration += 1;
      this.scheduleSave();
    });
    byId<HTMLInputElement>("page-title").addEventListener("blur", () => { void this.flushPendingSave(); });
    byId<HTMLTextAreaElement>("page-text").addEventListener("blur", () => { void this.flushPendingSave(); });
    byId<HTMLSelectElement>("background-select").addEventListener("change", (event) => {
      if (!this.currentPage) return;
      this.currentPage.background = (event.target as HTMLSelectElement).value as PageBackground;
      this.canvas?.setBackground(this.currentPage.background);
      this.editGeneration += 1;
      this.scheduleSave();
    });
    byId<HTMLInputElement>("width-range").addEventListener("input", (event) => {
      const width = Number((event.target as HTMLInputElement).value);
      if (this.selectedTool === "hand") return;
      this.toolSettings[this.selectedTool].width = width;
      this.selectTool(this.selectedTool);
    });
    document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((button) => button.addEventListener("click", () => {
      const value = Number(button.dataset.color);
      document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
      byId("color-preview").style.backgroundColor = argbToCSS(value);
      this.selectTool(this.selectedTool === "highlighter" || this.selectedTool === "line" ? this.selectedTool : "pen", value);
    }));
    this.bindAuthEvents();
    byId<HTMLFormElement>("settings-form").addEventListener("submit", (event) => { event.preventDefault(); void this.saveSettings(); });
    byId<HTMLFormElement>("notebook-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = byId("notebook-form").querySelector<HTMLButtonElement>('button[type="submit"]')!;
      if (submit.disabled) return;
      submit.disabled = true;
      try { await this.submitNotebookRename(); } finally { submit.disabled = false; }
    });
  }

  private async reload(selectID?: string, guard?: { store: NoteStore; generation: number }): Promise<boolean> {
    const searchAtStart = this.search;
    const trashAtStart = this.showTrash;
    const store = this.store;
    const accountAtStart = this.accountKey();
    const navigationAtStart = this.navigationGeneration;
    const editGenerationAtStart = this.editGeneration;
    const isSafe = (): boolean => store === this.store && accountAtStart === this.accountKey() && navigationAtStart === this.navigationGeneration && editGenerationAtStart === this.editGeneration && this.unsavedPageID === null && this.saveTimer === null && this.saveInFlight === null && !this.canvasInputActive() && searchAtStart === this.search && trashAtStart === this.showTrash && (!guard || (guard.store === this.store && guard.generation === this.editGeneration));
    if (!isSafe()) return false;
    const notebooks = await store.listNotebooks(trashAtStart);
    if (!isSafe()) return false;
    const selection = this.readSelection();
    const preferredNotebookID = this.currentNotebook?.id ?? selection.notebookID;
    const notebookID = preferredNotebookID && notebooks.some((item) => item.id === preferredNotebookID)
      ? preferredNotebookID : notebooks[0]?.id;
    const currentNotebook = notebookID ? await store.getNotebook(notebookID) : null;
    if (!isSafe()) return false;
    const currentPages = currentNotebook ? await store.listPages(currentNotebook.id, trashAtStart) : [];
    if (!isSafe()) return false;
    const allPages = (await Promise.all(notebooks.map((notebook) => store.listPages(notebook.id, trashAtStart)))).flat();
    if (!isSafe()) return false;
    const preferredPageID = selectID ?? this.currentPage?.id ?? selection.pageID;
    let currentPage = preferredPageID ? await store.getPage(preferredPageID) : null;
    if (!isSafe()) return false;
    const visiblePages = trashAtStart ? allPages.filter((page) => this.isPageInTrash(page, notebooks)) : searchAtStart ? allPages.filter((page) => !page.deletedAt) : currentPages;
    if (!currentPage || !visiblePages.some((item) => item.id === currentPage?.id)) currentPage = visiblePages[0] ?? null;
    let finalNotebook = currentNotebook;
    let finalPages = currentPages;
    if (currentPage && currentPage.notebookId !== currentNotebook?.id) {
      finalNotebook = await store.getNotebook(currentPage.notebookId);
      if (!isSafe()) return false;
      finalPages = finalNotebook ? await store.listPages(finalNotebook.id, trashAtStart) : [];
    }
    if (!isSafe()) return false;
    this.notebooks = notebooks;
    this.currentNotebook = finalNotebook;
    this.pages = finalPages;
    this.allPages = allPages;
    this.currentPage = currentPage;
    this.renderLists();
    this.renderEditor();
    this.rememberSelection();
    return true;
  }

  private async toggleTrash(): Promise<void> {
    const navigation = ++this.navigationGeneration;
    if (!(await this.flushPendingSave())) return;
    if (navigation !== this.navigationGeneration) return;
    this.showTrash = !this.showTrash;
    await this.reload();
  }

  private async toggleDrawer(drawer: "sidebar" | "inspector"): Promise<void> {
    const target = byId(drawer);
    const shouldOpen = !target.classList.contains("is-open");
    if (!shouldOpen) {
      await this.closeDrawers();
      return;
    }
    if (byId(drawer === "sidebar" ? "inspector" : "sidebar").classList.contains("is-open") && !(await this.flushPendingSave())) return;
    byId("sidebar").classList.toggle("is-open", drawer === "sidebar" && shouldOpen);
    byId("inspector").classList.toggle("is-open", drawer === "inspector" && shouldOpen);
    this.syncDrawerState();
    if (!shouldOpen) return;
    window.setTimeout(() => {
      if (drawer === "sidebar") byId<HTMLInputElement>("search-input").focus();
      else byId<HTMLTextAreaElement>("page-text").focus();
    }, 0);
  }

  private async toggleTextDrawer(): Promise<void> {
    if (!this.currentPage && !this.currentNotebook) return;
    await this.toggleDrawer("inspector");
  }

  private async openTextDrawer(focusTitle = false): Promise<void> {
    if (!this.currentPage) return;
    if (!byId("inspector").classList.contains("is-open")) await this.toggleDrawer("inspector");
    window.setTimeout(() => {
      const target = focusTitle ? byId<HTMLInputElement>("page-title") : byId<HTMLTextAreaElement>("page-text");
      target.focus();
      if (target instanceof HTMLInputElement) target.select();
    }, 0);
  }

  private syncDrawerState(): void {
    const sidebarOpen = byId("sidebar").classList.contains("is-open");
    const inspectorOpen = byId("inspector").classList.contains("is-open");
    const backdrop = byId<HTMLButtonElement>("drawer-backdrop");
    backdrop.hidden = !sidebarOpen && !inspectorOpen;
    byId("sidebar").setAttribute("aria-hidden", String(!sidebarOpen));
    byId("inspector").setAttribute("aria-hidden", String(!inspectorOpen));
    byId("sidebar").inert = !sidebarOpen;
    byId("inspector").inert = !inspectorOpen;
    byId("mobile-menu").setAttribute("aria-expanded", String(sidebarOpen));
    byId("text-toggle").setAttribute("aria-expanded", String(inspectorOpen));
    document.body.classList.toggle("drawer-open", sidebarOpen || inspectorOpen);
  }

  private async closeDrawers(flush = true): Promise<boolean> {
    if (flush && !(await this.flushPendingSave())) return false;
    byId("sidebar").classList.remove("is-open");
    byId("inspector").classList.remove("is-open");
    this.syncDrawerState();
    return true;
  }

  private openSettings(): void {
    this.renderWorkspaceRecovery();
    this.openDialog("settings-dialog");
  }

  private renderWorkspaceRecovery(): void {
    const target = document.getElementById("workspace-recovery");
    if (!target) return;
    const workspaces = this.auth.savedWorkspaces;
    if (workspaces.length === 0) {
      target.innerHTML = "";
      return;
    }
    target.innerHTML = `<div class="workspace-recovery"><span class="recovery-label">Saved local workspaces</span><p>Export an older account before changing servers or signing in elsewhere. These copies never upload automatically.</p>${workspaces.map((workspace) => {
      const key = workspaceAccountKey(workspace.endpoint, workspace.userID);
      const active = key === this.store.accountKey;
      return `<div class="recovery-row"><span><strong>${escapeHTML(workspace.identifier)}</strong><small>${escapeHTML(workspace.endpoint)}${active ? " · current" : ""}</small></span><button type="button" class="outline-button compact" data-export-workspace="${escapeAttr(workspace.userID)}" data-workspace-endpoint="${escapeAttr(workspace.endpoint)}">Export</button></div>`;
    }).join("")}</div>`;
    target.querySelectorAll<HTMLButtonElement>("[data-export-workspace]").forEach((button) => button.addEventListener("click", () => { void this.exportSavedWorkspace(button); }));
  }

  private async exportSavedWorkspace(button: HTMLButtonElement): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    const endpoint = button.dataset.workspaceEndpoint ?? "";
    const userID = button.dataset.exportWorkspace ?? "";
    const identity = this.auth.savedWorkspaces.find((workspace) => workspace.endpoint === endpoint && workspace.userID === userID.toLowerCase());
    if (!identity || !isUUID(identity.userID)) {
      byId("settings-message").textContent = "That saved workspace is no longer available.";
      return;
    }
    const accountKey = workspaceAccountKey(identity.endpoint, identity.userID);
    let workspaceStore: NoteStore | null = null;
    try {
      workspaceStore = accountKey === this.store.accountKey ? this.store : await SQLiteNoteStore.open(accountKey);
      const archive = await workspaceStore.exportArchive();
      const safeIdentifier = identity.identifier.replace(/[^\w.-]+/g, "-").slice(0, 48) || "workspace";
      download(new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" }), `notepad-${safeIdentifier}-${dateStamp()}.notepad.json`);
      byId("settings-message").textContent = `Exported the ${identity.identifier} workspace. The original local copy remains available.`;
    } catch (error) {
      byId("settings-message").textContent = error instanceof Error ? error.message : "Could not export that workspace.";
    } finally {
      if (workspaceStore && workspaceStore !== this.store) await workspaceStore.close();
    }
  }

  private openNotebookRename(create = false): void {
    if ((!create && !this.currentNotebook) || this.showTrash) return;
    byId("notebook-form").dataset.mode = create ? "create" : "rename";
    byId("notebook-form").querySelector("h2")!.textContent = create ? "New notebook" : "Rename notebook";
    byId("notebook-form").querySelector('button[type="submit"]')!.textContent = create ? "Create notebook" : "Save name";
    const input = byId<HTMLInputElement>("notebook-title");
    input.value = create ? "My notebook" : this.currentNotebook!.title;
    byId("new-notebook-options").hidden = !create;
    if (create) {
      byId<HTMLSelectElement>("new-paper").value = "ruled";
      byId("new-paper").dispatchEvent(new Event("change"));
    }
    byId("notebook-error").textContent = "";
    this.openDialog("notebook-dialog");
    window.setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  private async submitNotebookRename(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    const title = byId<HTMLInputElement>("notebook-title").value.trim();
    if (!title || title.length > 500) {
      byId("notebook-error").textContent = "Use a notebook name from 1 to 500 characters.";
      return;
    }
    if (byId("notebook-form").dataset.mode === "create") {
      await this.createNotebook(title);
      return;
    }
    const notebook = this.currentNotebook;
    if (!notebook) return;
    try {
      const result = await this.store.saveNotebook({ ...notebook, title, updatedAt: now() });
      if (result.status === "failed") {
        byId("notebook-error").textContent = result.message ?? "Could not rename notebook.";
        this.setState({ kind: "error", message: result.message ?? "Could not rename notebook." });
        return;
      }
      if (notebook.id !== this.currentNotebook?.id) return;
      const saved = { ...notebook, title, revision: result.revision ?? notebook.revision, updatedAt: now() };
      this.currentNotebook = saved;
      this.coordinator.notifyLocalWrite();
      const index = this.notebooks.findIndex((item) => item.id === saved.id);
      if (index >= 0) this.notebooks[index] = saved;
      this.renderLists();
      this.renderEditor();
      this.closeDialog("notebook-dialog");
      this.setState(this.auth.session ? { kind: "saved" } : { kind: "offline" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not rename notebook.";
      byId("notebook-error").textContent = message;
      this.setState({ kind: "error", message });
    }
  }

  private async openLibrary(): Promise<void> {
    if (this.canvas?.isInputActive) return;
    const navigation = ++this.navigationGeneration;
    if (!(await this.flushPendingSave())) return;
    if (navigation !== this.navigationGeneration) return;
    await this.closeDrawers(false);
    if (navigation !== this.navigationGeneration) return;
    this.view = "library";
    if (this.showTrash) {
      this.showTrash = false;
      if (!(await this.reload()) || navigation !== this.navigationGeneration) return;
    }
    this.renderLibrary();
    this.renderEditor();
    byId("library-title").focus();
  }

  private favoriteIDs(): string[] {
    try {
      const value = JSON.parse(localStorage.getItem(`notepad.favorites:${this.accountKey()}`) ?? "[]");
      return Array.isArray(value) ? value.filter((id) => typeof id === "string" && isUUID(id)) : [];
    } catch { return []; }
  }

  private renderLibrary(): void {
    if (this.view !== "library") return;
    const query = byId<HTMLInputElement>("library-search").value.trim().toLocaleLowerCase();
    const favorites = this.favoriteIDs();
    const all = this.notebooks.filter((book) => !book.deletedAt);
    const pagesByNotebook = new Map<string, NotePage[]>();
    for (const page of this.allPages) {
      if (page.deletedAt) continue;
      const pages = pagesByNotebook.get(page.notebookId);
      if (pages) pages.push(page);
      else pagesByNotebook.set(page.notebookId, [page]);
    }
    const pagesForBook = (book: Notebook): NotePage[] => pagesByNotebook.get(book.id) ?? [];
    const modifiedByNotebook = new Map<string, string>();
    for (const book of all) {
      let modified = book.updatedAt;
      for (const page of pagesForBook(book)) if (page.updatedAt > modified) modified = page.updatedAt;
      modifiedByNotebook.set(book.id, modified);
    }
    const modified = (book: Notebook): string => modifiedByNotebook.get(book.id) ?? book.updatedAt;
    const books = all.filter((book) => (this.libraryTab !== "favorites" || favorites.includes(book.id)) &&
      (!query || book.title.toLocaleLowerCase().includes(query) || pagesForBook(book).some((page) => `${page.title} ${page.text}`.toLocaleLowerCase().includes(query))));
    const sort = byId<HTMLSelectElement>("library-sort").value;
    books.sort((a, b) => sort === "name" ? a.title.localeCompare(b.title) : modified(b).localeCompare(modified(a)) || a.title.localeCompare(b.title));
    byId("library-title").textContent = ({ documents: "Documents", favorites: "Favorites", search: "Search" })[this.libraryTab];
    byId("library-count").textContent = `${books.length} notebook${books.length === 1 ? "" : "s"}`;
    for (const tab of ["documents", "favorites", "search"]) byId(tab === "search" ? "library-tab-search" : `library-${tab}`).setAttribute("aria-current", this.libraryTab === tab ? "page" : "false");
    byId("library-empty").hidden = books.length !== 0;
    byId("library-empty").textContent = query ? "No matching notebooks. Try a notebook title, page title or typed text." : this.libraryTab === "favorites" ? "Your favorite notebooks will appear here. Tap the star on a notebook to add it." : "Create your first notebook. Choose New, then Notebook to get started.";
    byId("library-books").innerHTML = books.map((book) => {
      const pages = pagesForBook(book);
      const shade = [...book.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5;
      const starred = favorites.includes(book.id);
      const date = new Date(modified(book));
      return `<article class="library-book"><button class="book-open" data-open-book="${book.id}" aria-label="Open notebook ${escapeAttr(book.title)}"><span class="book-cover cover-${shade}"><span class="cover-label"><small>NOTEBOOK</small><strong>${escapeHTML(book.title)}</strong><span>NotePad</span></span></span><span class="book-caption"><strong>${escapeHTML(book.title)}</strong><small>${pages.length} page${pages.length === 1 ? "" : "s"} · ${Number.isFinite(date.getTime()) ? escapeHTML(date.toLocaleDateString(undefined, { month: "short", day: "numeric" })) : ""}</small></span></button><button class="book-star" data-favorite="${book.id}" aria-label="Favorite ${escapeAttr(book.title)}" aria-pressed="${starred}">${starred ? "★" : "☆"}</button></article>`;
    }).join("");
    byId("library-books").querySelectorAll<HTMLButtonElement>("[data-open-book]").forEach((button) => button.addEventListener("click", () => { void this.selectNotebook(button.dataset.openBook!); }));
    byId("library-books").querySelectorAll<HTMLButtonElement>("[data-favorite]").forEach((button) => button.addEventListener("click", () => {
      const id = button.dataset.favorite!;
      const next = this.favoriteIDs();
      try {
        localStorage.setItem(`notepad.favorites:${this.accountKey()}`, JSON.stringify(next.includes(id) ? next.filter((value) => value !== id) : [...next, id]));
        this.renderLibrary();
      } catch { byId("library-empty").hidden = false; byId("library-empty").textContent = "Could not save favorites on this device."; }
    }));
  }

  private renderLists(): void {
    this.renderLibrary();
    const notebookList = byId("notebook-list");
    const notebooks = this.notebooks.filter((notebook) => this.showTrash ? true : !notebook.deletedAt)
      .filter((notebook) => !this.search || notebook.title.toLocaleLowerCase().includes(this.search));
    notebookList.innerHTML = notebooks.length ? notebooks.map((notebook) => `
      <button class="nav-row ${notebook.id === this.currentNotebook?.id ? "selected" : ""}" data-notebook="${escapeAttr(notebook.id)}" aria-current="${notebook.id === this.currentNotebook?.id ? "page" : "false"}">
        <span class="nav-glyph">${notebook.deletedAt ? "◌" : "▱"}</span><span class="nav-copy"><strong>${escapeHTML(notebook.title)}</strong><small>${notebook.id === this.currentNotebook?.id ? `${this.pagesForNotebook(notebook.id)} pages` : "Notebook"}</small></span>
      </button>`).join("") : `<p class="empty-copy">${this.showTrash ? "Trash is empty." : "Create a notebook to begin."}</p>`;
    notebookList.querySelectorAll<HTMLButtonElement>("[data-notebook]").forEach((button) => button.addEventListener("click", () => void this.selectNotebook(button.dataset.notebook!)));

    const pageList = byId("page-list");
    const sourcePages = this.showTrash ? this.allPages : this.search ? this.allPages : this.pages;
    const pages = sourcePages.filter((page) => this.showTrash ? this.isPageInTrash(page) : !page.deletedAt)
      .filter((page) => !this.search || `${page.title} ${page.text}`.toLocaleLowerCase().includes(this.search));
    pageList.innerHTML = pages.length ? pages.map((page) => `
      <button class="page-row ${page.id === this.currentPage?.id ? "selected" : ""}" data-page="${escapeAttr(page.id)}" aria-current="${page.id === this.currentPage?.id ? "page" : "false"}">
        <span class="page-index">${sourcePages.indexOf(page) + 1}</span><span class="page-copy"><strong>${escapeHTML(page.title || "Untitled page")}</strong><small>${pageNotebookLabel(page, this.notebooks)}${page.text.trim() ? ` · ${escapeHTML(preview(page.text))}` : ` · ${page.strokes.length} strokes`}</small></span>
      </button>`).join("") : `<p class="empty-copy">${this.showTrash ? "No deleted pages." : "No pages yet."}</p>`;
    pageList.querySelectorAll<HTMLButtonElement>("[data-page]").forEach((button) => button.addEventListener("click", () => void this.selectPage(button.dataset.page!)));
    byId("trash-toggle").classList.toggle("active", this.showTrash);
    byId("trash-toggle").setAttribute("aria-pressed", String(this.showTrash));
    byId("trash-label").textContent = this.showTrash ? "Back to notebook" : "Trash";
    byId("new-page").toggleAttribute("disabled", this.showTrash || !this.currentNotebook);
    byId("new-notebook").toggleAttribute("disabled", this.showTrash);
  }

  private pagesForNotebook(notebookID: string): number {
    return this.pages.filter((page) => page.notebookId === notebookID && (this.showTrash ? this.isPageInTrash(page) : !page.deletedAt)).length;
  }

  private isPageInTrash(page: NotePage, notebooks = this.notebooks): boolean {
    return Boolean(page.deletedAt) || Boolean(notebooks.find((notebook) => notebook.id === page.notebookId)?.deletedAt);
  }

  private renderEditor(): void {
    byId("library").hidden = this.view !== "library";
    byId("editor-workspace").hidden = this.view !== "editor";
    if (this.view === "library") return;
    const page = this.currentPage;
    const hasPage = Boolean(page);
    document.body.classList.toggle("trash-mode", this.showTrash);
    byId("editor-empty").classList.toggle("hidden", hasPage);
    byId("editor-content").classList.toggle("hidden", !hasPage);
    byId("notebook-name").textContent = this.currentNotebook?.title ?? "No notebook";
    byId<HTMLButtonElement>("rename-notebook").disabled = !this.currentNotebook || this.showTrash;
    const notebookAction = byId<HTMLButtonElement>("archive-notebook");
    notebookAction.disabled = !this.currentNotebook;
    notebookAction.textContent = this.currentNotebook?.deletedAt ? "Restore notebook" : "Archive notebook";
    notebookAction.title = notebookAction.textContent;
    notebookAction.setAttribute("aria-label", notebookAction.textContent);
    byId<HTMLButtonElement>("text-toggle").disabled = !hasPage && !this.currentNotebook;
    byId<HTMLButtonElement>("rename-page").disabled = !hasPage || this.showTrash;
    byId<HTMLInputElement>("page-title").disabled = !hasPage || this.showTrash;
    byId<HTMLTextAreaElement>("page-text").disabled = !hasPage || this.showTrash;
    byId<HTMLSelectElement>("background-select").disabled = !hasPage || this.showTrash;
    const pageAction = byId<HTMLButtonElement>("delete-page");
    pageAction.disabled = !hasPage;
    if (!page) return;
    byId<HTMLInputElement>("page-title").value = page.title;
    byId<HTMLTextAreaElement>("page-text").value = page.text;
    byId<HTMLSelectElement>("background-select").value = page.background;
    byId("page-title-label").textContent = page.title || "Untitled page";
    byId("page-revision").textContent = `revision ${page.revision}`;
    pageAction.disabled = this.showTrash && !page.deletedAt;
    pageAction.textContent = this.showTrash ? page.deletedAt ? "Restore page" : "Restore notebook first" : "Move page to trash";
    pageAction.title = this.showTrash ? "Restore page" : "Move page to trash";
    pageAction.setAttribute("aria-label", pageAction.title);
    byId("print-title").textContent = page.title || "Untitled page";
    byId("print-text").textContent = page.text;
    this.canvas?.setPage(page.id, page.width, page.height, page.background, page.strokes);
    this.updateToolbar();
  }

  private async deleteCurrentPage(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    if (!this.currentPage) return;
    try {
      const result = this.showTrash
        ? await this.store.restorePage(this.currentPage.id)
        : await this.store.deletePage(this.currentPage.id);
      if (result.status === "failed") {
        this.setState({ kind: "error", message: result.message ?? "Could not update page" });
        return;
      }
      this.coordinator.notifyLocalWrite();
      this.currentPage = null;
      await this.reload();
    } catch (error) {
      this.setState({ kind: "error", message: error instanceof Error ? error.message : "Could not update page" });
    }
  }

  private updateToolbar(): void {
    const readOnly = this.showTrash || this.selectedTool === "hand";
    byId<HTMLButtonElement>("undo-button").disabled = readOnly || !this.canvas?.hasUndo;
    byId<HTMLButtonElement>("redo-button").disabled = readOnly || !this.canvas?.hasRedo;
    const pages = this.pages.filter((page) => !page.deletedAt);
    const index = pages.findIndex((page) => page.id === this.currentPage?.id);
    byId("page-position").textContent = `${index + 1} / ${pages.length}`;
    byId<HTMLButtonElement>("previous-page").disabled = this.showTrash || index <= 0;
    byId<HTMLButtonElement>("next-page").disabled = this.showTrash || index < 0 || index >= pages.length - 1;
    byId<HTMLButtonElement>("add-page").disabled = this.showTrash || !this.currentNotebook;
    byId<HTMLButtonElement>("duplicate-page").disabled = this.showTrash || !this.currentPage;
  }

  private async turnPage(direction: number): Promise<void> {
    if (this.showTrash || this.canvas?.isInputActive) return;
    const pages = this.pages.filter((page) => !page.deletedAt);
    const index = pages.findIndex((page) => page.id === this.currentPage?.id);
    const next = pages[index + direction];
    if (index >= 0 && next) await this.selectPage(next.id);
  }

  private async selectNotebook(id: string): Promise<void> {
    if (this.canvasInputActive()) return;
    const navigation = ++this.navigationGeneration;
    if (!(await this.flushPendingSave())) return;
    if (navigation !== this.navigationGeneration) return;
    const store = this.store;
    this.editGeneration += 1;
    const editGeneration = this.editGeneration;
    const canApply = (): boolean => navigation === this.navigationGeneration && store === this.store && editGeneration === this.editGeneration && this.unsavedPageID === null && this.saveTimer === null && this.saveInFlight === null && !this.canvasInputActive();
    const notebook = await store.getNotebook(id);
    if (!canApply()) return;
    const pages = notebook ? await store.listPages(notebook.id, this.showTrash) : [];
    if (!canApply()) return;
    const last = this.readSelection();
    const page = this.showTrash
      ? this.allPages.find((page) => page.notebookId === id && this.isPageInTrash(page)) ?? null
      : pages.find((page) => !page.deletedAt && last.notebookID === id && last.pageID === page.id) ?? pages.find((page) => !page.deletedAt) ?? null;
    this.currentNotebook = notebook;
    this.pages = pages;
    this.currentPage = page;
    this.view = "editor";
    this.renderLists();
    this.renderEditor();
    this.rememberSelection();
    await this.closeDrawers(false);
    if (navigation !== this.navigationGeneration) return;
  }

  private async selectPage(id: string): Promise<void> {
    if (this.canvasInputActive()) return;
    const navigation = ++this.navigationGeneration;
    if (!(await this.flushPendingSave())) return;
    if (navigation !== this.navigationGeneration) return;
    const store = this.store;
    this.editGeneration += 1;
    const editGeneration = this.editGeneration;
    const canApply = (): boolean => navigation === this.navigationGeneration && store === this.store && editGeneration === this.editGeneration && this.unsavedPageID === null && this.saveTimer === null && this.saveInFlight === null && !this.canvasInputActive();
    const page = await store.getPage(id);
    if (!canApply()) return;
    let notebook = this.currentNotebook;
    let pages = this.pages;
    if (page && page.notebookId !== notebook?.id) {
      notebook = await store.getNotebook(page.notebookId);
      if (!canApply()) return;
      pages = notebook ? await store.listPages(notebook.id, this.showTrash) : [];
      if (!canApply()) return;
    }
    this.currentPage = page;
    this.currentNotebook = notebook;
    this.pages = pages;
    this.view = "editor";
    this.renderLists();
    this.renderEditor();
    this.rememberSelection();
    await this.closeDrawers(false);
    if (navigation !== this.navigationGeneration) return;
  }

  private async createNotebook(title: string): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    if (!title || this.showTrash) return;
    const notebook = createNotebook(title);
    try {
      const result = await this.store.saveNotebook(notebook);
      if (result.status === "failed") {
        byId("notebook-error").textContent = result.message ?? "Could not save notebook";
        this.setState({ kind: "error", message: result.message ?? "Could not save notebook" });
        return;
      }
      this.coordinator.notifyLocalWrite();
      const page = createPage(notebook.id, "First page");
      page.background = byId<HTMLSelectElement>("new-paper").value as PageBackground;
      const pageResult = await this.store.savePage(page);
      if (pageResult.status === "failed") {
        byId("notebook-error").textContent = pageResult.message ?? "Notebook saved, but its first page could not be saved.";
        this.setState({ kind: "error", message: pageResult.message ?? "Notebook saved, but its first page could not be saved." });
        await this.reload();
        return;
      }
      this.coordinator.notifyLocalWrite();
      this.currentNotebook = { ...notebook, revision: result.revision ?? notebook.revision };
      this.view = "editor";
      await this.reload(page.id);
      this.closeDialog("notebook-dialog");
      await this.closeDrawers();
    } catch (error) {
      byId("notebook-error").textContent = error instanceof Error ? error.message : "Could not save notebook";
      this.setState({ kind: "error", message: error instanceof Error ? error.message : "Could not save notebook" });
    }
  }

  private async createNewPage(duplicate = false): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    if (!this.currentNotebook || this.showTrash) return;
    const source = this.currentPage;
    const page = createPage(this.currentNotebook.id, duplicate && source ? `${source.title} (copy)` : `Page ${this.pages.length + 1}`);
    if (source) {
      page.background = source.background;
      page.width = source.width;
      page.height = source.height;
      if (duplicate) {
        page.text = source.text;
        page.strokes = clonePage(source).strokes;
      }
    }
    try {
      const result = await this.store.savePage(page);
      if (result.status === "failed") return this.setState({ kind: "error", message: result.message ?? "Could not save page" });
      this.coordinator.notifyLocalWrite();
      await this.reload(page.id);
      await this.closeDrawers();
    } catch (error) {
      this.setState({ kind: "error", message: error instanceof Error ? error.message : "Could not save page" });
    }
  }

  private handleCanvasChange(strokes: InkStroke[]): void {
    if (!this.currentPage || this.showTrash) return;
    this.currentPage.strokes = strokes;
    this.editGeneration += 1;
    this.scheduleSave(180);
    this.updateToolbar();
  }

  private scheduleSave(delay = 500): void {
    this.unsavedPageID = this.currentPage?.id ?? null;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.setState({ kind: "saving" });
    this.saveTimer = window.setTimeout(() => { this.saveTimer = null; void this.saveCurrentPage(); }, delay);
  }

  private async saveCurrentPage(): Promise<boolean> {
    // A timer and a navigation can reach this method together. Serialize the
    // writes, then capture the newest page state after the older write settles.
    while (this.saveInFlight) {
      const inFlight = this.saveInFlight;
      if (!(await inFlight)) return false;
    }
    // The awaited write already persisted this page when no edit arrived
    // while it was in flight. Only write again for a still-dirty page.
    const currentPage = this.currentPage;
    if (!currentPage || this.unsavedPageID !== currentPage.id) return true;
    const page = clonePage(currentPage);
    const store = this.store;
    const generation = this.editGeneration;
    const operation = (async (): Promise<boolean> => {
      try {
        const savedAt = now();
        const result = await store.savePage({ ...page, updatedAt: savedAt });
        if (result.status === "failed") {
          if (store === this.store && page.id === this.currentPage?.id) this.setState({ kind: "error", message: result.message ?? "Could not save page" });
          return false;
        }
        if (store !== this.store || page.id !== this.currentPage?.id || generation !== this.editGeneration) return true;
        this.unsavedPageID = null;
        if (this.pendingRemoteRefresh) this.scheduleRemoteRefresh();
        const savedPage = { ...page, revision: result.revision ?? page.revision, updatedAt: savedAt };
        const listedIndex = this.pages.findIndex((item) => item.id === page.id);
        if (listedIndex >= 0) this.pages[listedIndex] = savedPage;
        const allIndex = this.allPages.findIndex((item) => item.id === page.id);
        if (allIndex >= 0) this.allPages[allIndex] = savedPage;
        this.currentPage.revision = savedPage.revision;
        this.currentPage.updatedAt = savedAt;
        byId("page-revision").textContent = `revision ${this.currentPage.revision}`;
        this.renderLists();
        this.coordinator.notifyLocalWrite();
        this.setState(this.auth.session ? { kind: "saved" } : { kind: "offline" });
        return true;
      } catch (error) {
        if (store === this.store && page.id === this.currentPage?.id) this.setState({ kind: "error", message: error instanceof Error ? error.message : "Could not save page" });
        return false;
      }
    })();
    this.saveInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.saveInFlight === operation) this.saveInFlight = null;
    }
  }

  private async flushPendingSave(): Promise<boolean> {
    const timer = this.saveTimer;
    if (timer !== null || (this.currentPage && this.unsavedPageID === this.currentPage.id)) {
      if (timer !== null) window.clearTimeout(timer);
      this.saveTimer = null;
      if (!(await this.saveCurrentPage())) return false;
    }
    const inFlight = this.saveInFlight;
    if (inFlight && !(await inFlight)) return false;
    return true;
  }

  private selectTool(kind: CanvasTool["kind"], color?: number): void {
    this.selectedTool = kind;
    for (const name of ["pen", "highlighter", "line", "eraser", "hand"]) {
      byId(`${name}-tool`).classList.toggle("active", kind === name);
      byId(`${name}-tool`).setAttribute("aria-pressed", String(kind === name));
    }
    byId("ink-options").classList.toggle("hidden", kind === "hand");
    byId("pen-style").classList.toggle("hidden", kind !== "pen");
    byId("tool-name").textContent = ({ pen: "Pen", highlighter: "Highlighter", line: "Straight line", eraser: "Stroke eraser", hand: "Read & pan" })[kind];
    if (kind === "hand") this.canvas?.setTool({ kind });
    else {
      const settings = this.toolSettings[kind];
      if ("color" in settings && color !== undefined) settings.color = color;
      const range = byId<HTMLInputElement>("width-range");
      range.max = kind === "highlighter" ? "36" : "12";
      range.value = String(settings.width);
      byId("width-value").textContent = `${settings.width}px`;
      const widths = kind === "highlighter" ? [10, 18, 28] : [1.5, 3, 6];
      document.querySelectorAll<HTMLButtonElement>("[data-width]").forEach((button, index) => {
        button.dataset.width = String(widths[index]);
        button.title = `${widths[index]}px`;
        button.setAttribute("aria-label", `Stroke width ${widths[index]} pixels`);
        button.setAttribute("aria-pressed", String(settings.width === widths[index]));
      });
      document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((button) => {
        const active = "color" in settings && Number(button.dataset.color) === settings.color;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
      this.canvas?.setTool(kind === "eraser" ? { kind, width: settings.width } : {
        kind, color: this.toolSettings[kind].color, width: settings.width,
        pressureSensitive: byId<HTMLSelectElement>("pen-style").value === "fountain",
      });
    }
    try {
      localStorage.setItem("notepad.writing-tools", JSON.stringify({
        settings: this.toolSettings, kind, penStyle: byId<HTMLSelectElement>("pen-style").value,
      }));
    } catch { /* Tool preferences are optional; note durability uses SQLite. */ }
    this.updateToolbar();
  }

  private restoreToolSettings(): void {
    try {
      const saved = JSON.parse(localStorage.getItem("notepad.writing-tools") ?? "null");
      if (!saved || typeof saved !== "object") return;
      for (const kind of ["pen", "highlighter", "line", "eraser"] as const) {
        const value = saved.settings?.[kind];
        if (!value || typeof value !== "object") continue;
        const target = this.toolSettings[kind];
        const max = kind === "highlighter" ? 36 : 12;
        if (Number.isFinite(value.width) && value.width >= 1 && value.width <= max) target.width = value.width;
        if ("color" in target && Number.isInteger(value.color) && value.color >= 0 && value.color <= 0xffffffff) target.color = value.color;
      }
      if (["pen", "highlighter", "line", "eraser", "hand"].includes(saved.kind)) this.selectedTool = saved.kind;
      if (saved.penStyle === "ball" || saved.penStyle === "fountain") byId<HTMLSelectElement>("pen-style").value = saved.penStyle;
    } catch { /* Ignore unavailable storage or damaged preferences. */ }
  }

  private setState(state: SyncState): void {
    if (!document.getElementById("sync-button")) return;
    const offlineAccountLabel = "Sign in required";
    const label = state.kind === "error" ? state.message : state.kind === "conflict" ? `${state.count} conflict${state.count === 1 ? "" : "s"}` : state.kind === "needs-login" ? offlineAccountLabel : state.kind === "offline" ? "Saved locally" : state.kind === "saving" ? "Saving…" : state.kind === "syncing" ? "Syncing…" : state.kind === "saved" ? "Saved locally" : "Ready";
    byId("sync-label").textContent = label;
    byId("sync-button").classList.toggle("is-busy", state.kind === "saving" || state.kind === "syncing");
    byId("sync-button").setAttribute("aria-label", label);
    byId("sync-icon").textContent = state.kind === "error" ? "!" : state.kind === "conflict" ? "!" : state.kind === "syncing" ? "↻" : state.kind === "needs-login" ? "·" : "✓";
  }

  private pauseCoordinatorForStoreSwitch(): void {
    this.coordinator.stop();
    this.pendingRemoteRefresh = null;
    if (this.remoteRefreshTimer !== null) {
      window.clearTimeout(this.remoteRefreshTimer);
      this.remoteRefreshTimer = null;
    }
  }

  private resumeCoordinatorAfterStoreSwitch(): void {
    this.coordinator.start();
    this.coordinator.notifyAuthChanged();
  }

  private handleCoordinatorStatus(status: SyncCoordinatorStatus): void {
    if (!document.getElementById("sync-button")) return;
    if (status.state === "error") {
      this.setState({ kind: "error", message: status.error ?? "Sync unavailable. Notes remain local." });
      return;
    }
    if (status.state === "syncing") {
      this.setState({ kind: "syncing" });
      return;
    }
    if (status.state === "offline") {
      this.setState({ kind: "offline" });
      return;
    }
    if (status.state === "needs-login") {
      this.setState({ kind: "needs-login" });
      this.requireLogin();
      return;
    }
    if (status.state === "scheduled") {
      this.setState(this.auth.session ? { kind: "saved" } : { kind: "needs-login" });
      if (!this.auth.session) return;
      const label = status.pending > 0 ? `Saved locally · ${status.pending} queued` : "Saved locally · sync queued";
      byId("sync-label").textContent = label;
      byId("sync-button").setAttribute("aria-label", label);
      return;
    }
    if (status.conflicts > 0) {
      this.setState({ kind: "conflict", count: status.conflicts });
      return;
    }
    if (!this.saveTimer && !this.saveInFlight && this.unsavedPageID === null) {
      this.setState(this.auth.session ? { kind: "saved" } : { kind: "needs-login" });
      if (this.auth.session && status.lastSuccessAt && status.pending === 0) {
        const time = new Date(status.lastSuccessAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        const label = `Synced · ${time}`;
        byId("sync-label").textContent = label;
        byId("sync-button").setAttribute("aria-label", label);
      }
    }
  }

  private async beforeCoordinatorSync(): Promise<boolean> {
    const saved = await this.flushPendingSave();
    if (saved) this.coordinatorGeneration = this.editGeneration;
    return saved;
  }

  private async afterCoordinatorSync(context: SyncCompleteContext): Promise<void> {
    const expectedGeneration = this.coordinatorGeneration;
    if (this.canvasInputActive()) {
      this.queueRemoteRefresh(context);
      return;
    }
    await this.afterCoordinatorSyncAtGeneration(context, expectedGeneration);
  }

  private async afterCoordinatorSyncAtGeneration(context: SyncCompleteContext, expectedGeneration: number): Promise<void> {
    if (context.store !== this.store) return;
    if (this.canvasInputActive() || expectedGeneration !== this.editGeneration || this.unsavedPageID !== null || this.saveTimer !== null || this.saveInFlight !== null) {
      if (context.report.pulled > 0 || context.report.conflicts > 0) this.queueRemoteRefresh(context);
      return;
    }
    if (context.store !== this.store || expectedGeneration !== this.editGeneration || this.unsavedPageID !== null || this.saveTimer !== null || this.saveInFlight !== null || this.canvasInputActive()) {
      if (context.report.pulled > 0 || context.report.conflicts > 0) this.queueRemoteRefresh(context);
      return;
    }
    if (context.report.pulled > 0 || context.report.conflicts > 0) {
      const generation = this.editGeneration;
      const reloaded = await this.reload(this.currentPage?.id, { store: context.store, generation });
      if (!reloaded) {
        if (context.report.pulled > 0 || context.report.conflicts > 0) this.queueRemoteRefresh(context);
        return;
      }
    }
    if (context.report.conflicts > 0) this.setState({ kind: "conflict", count: context.report.conflicts });
    else this.setState({ kind: "saved" });
  }

  private queueRemoteRefresh(context: SyncCompleteContext): void {
    if (context.store !== this.store || (context.report.pulled === 0 && context.report.conflicts === 0)) return;
    this.pendingRemoteRefresh = { store: context.store, conflicts: context.report.conflicts };
    this.scheduleRemoteRefresh();
  }

  private scheduleRemoteRefresh(): void {
    if (this.remoteRefreshTimer !== null) return;
    this.remoteRefreshTimer = window.setTimeout(() => {
      this.remoteRefreshTimer = null;
      void this.flushRemoteRefresh();
    }, 250);
  }

  private async flushRemoteRefresh(): Promise<void> {
    const pending = this.pendingRemoteRefresh;
    if (!pending) return;
    if (pending.store !== this.store) {
      this.pendingRemoteRefresh = null;
      return;
    }
    if (this.unsavedPageID !== null) return;
    if (this.canvasInputActive() || this.saveTimer !== null || this.saveInFlight !== null) {
      this.scheduleRemoteRefresh();
      return;
    }
    const generation = this.editGeneration;
    const reloaded = await this.reload(this.currentPage?.id, { store: pending.store, generation });
    if (!reloaded) {
      if (pending.store === this.store) this.scheduleRemoteRefresh();
      return;
    }
    if (this.pendingRemoteRefresh === pending) this.pendingRemoteRefresh = null;
    if (pending.conflicts > 0) this.setState({ kind: "conflict", count: pending.conflicts });
    else this.setState({ kind: "saved" });
  }

  private canvasInputActive(): boolean {
    const canvas = this.canvas as (PaperCanvas & { readonly isInputActive?: boolean }) | null;
    return canvas?.isInputActive === true;
  }

  private async sync(): Promise<void> {
    this.coordinator.request("manual");
  }

  private openAuthDialog(): void {
    if (this.auth.session) { this.openSettings(); return; }
    this.requireLogin();
  }

  private setAuthMode(mode: "login" | "register"): void {
    byId("auth-dialog-title").textContent = mode === "login" ? "Sign in to NotePad" : "Create an account";
    byId("auth-submit").textContent = mode === "login" ? "Sign in" : "Create account";
    byId("auth-form").dataset.mode = mode;
    byId("login-mode").classList.toggle("active", mode === "login");
    byId("register-mode").classList.toggle("active", mode === "register");
  }

  private async submitAuth(): Promise<void> {
    const button = byId<HTMLButtonElement>("auth-submit");
    if (button.disabled) return;
    button.disabled = true;
    try {
      if (!(await this.flushPendingSave())) throw new Error("Could not save your open note. Free device storage and try again.");
      const identifier = byId<HTMLInputElement>("auth-identifier").value.trim();
      const password = byId<HTMLInputElement>("auth-password").value;
      if (!identifier || password.length < 12) throw new Error("Use an identifier and a password of at least 12 characters.");
      const previous = getEndpoint();
      if (!setEndpoint(byId<HTMLInputElement>("auth-endpoint").value)) {
        setEndpoint(previous);
        throw new Error("Enter a valid HTTPS server URL.");
      }
      const mode = byId("auth-form").dataset.mode;
      const response = mode === "register" ? await this.authClient.register(identifier, password) : await this.authClient.login(identifier, password);
      const nextStore = this.store?.accountKey === workspaceAccountKey(getEndpoint(), response.user.id)
        ? this.store : await SQLiteNoteStore.open(workspaceAccountKey(getEndpoint(), response.user.id));
      if (this.store && this.store !== nextStore) await this.store.close();
      this.auth.set(response);
      this.store = nextStore;
      this.currentNotebook = null;
      this.currentPage = null;
      this.notebooks = [];
      this.pages = [];
      this.allPages = [];
      this.view = "library";
      this.showTrash = false;
      this.search = "";
      this.canvas?.destroy();
      this.renderShell();
      await this.reload();
      this.loginRequired = false;
      this.root.classList.remove("login-required");
      this.resumeCoordinatorAfterStoreSwitch();
    } catch (error) {
      byId("auth-error").textContent = error instanceof Error ? error.message : "Sign-in failed.";
      if (!byId<HTMLDialogElement>("auth-dialog").open) this.requireLogin();
    } finally {
      byId<HTMLButtonElement>("auth-submit").disabled = false;
    }
  }

  private async logout(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    const session = this.auth.session;
    const endpoint = this.auth.boundEndpoint ?? getEndpoint();
    this.rememberSelection();
    this.requireLogin();
    // The account database stays available for unsent changes on the next login.
    if (session) { try { await this.authClient.logout(session.sessionToken, endpoint); } catch { /* Local sign-out still succeeds offline. */ } }
  }

  private async archiveCurrentNotebook(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    if (!this.currentNotebook) return;
    try {
      const result = this.currentNotebook.deletedAt ? await this.store.restoreNotebook(this.currentNotebook.id) : await this.store.archiveNotebook(this.currentNotebook.id);
      if (result.status === "failed") {
        this.setState({ kind: "error", message: result.message ?? "Could not update notebook" });
        return;
      }
      this.coordinator.notifyLocalWrite();
      await this.reload();
    } catch (error) {
      this.setState({ kind: "error", message: error instanceof Error ? error.message : "Could not update notebook" });
    }
  }

  private async saveSettings(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    const previous = getEndpoint();
    const raw = byId<HTMLInputElement>("endpoint-input").value.trim();
    const next = setEndpoint(raw);
    if (!next) {
      setEndpoint(previous);
      byId("settings-message").textContent = "Use an HTTPS URL. HTTP is allowed only for localhost development.";
      return;
    }
    if (previous !== next) {
      this.rememberSelection();
      this.requireLogin();
      return;
    }
    this.closeDialog("settings-dialog");
    this.setState(this.auth.session ? { kind: "saved" } : { kind: "needs-login" });
  }

  private async exportArchive(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    const archive = await this.store.exportArchive();
    download(new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" }), `notepad-${dateStamp()}.notepad.json`);
  }

  private async shareArchive(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    const archive = await this.store.exportArchive();
    const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
    const file = new File([blob], `notepad-${dateStamp()}.notepad.json`, { type: blob.type });
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      try { await navigator.share({ title: "NotePad archive", files: [file] }); return; } catch { /* user cancelled: keep the download fallback */ }
    }
    download(blob, file.name);
  }

  private async importArchive(event: Event): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      byId("settings-message").textContent = "That backup is larger than 50 MB. Export smaller notebooks or use the server sync.";
      return;
    }
    try {
      const archive = JSON.parse(await file.text()) as Archive;
      const result = await this.store.importArchive(archive);
      this.coordinator.notifyLocalWrite();
      await this.reload();
      byId("settings-message").textContent = `Imported ${result.pages} pages in ${result.notebooks} notebooks.`;
    } catch (error) {
      byId("settings-message").textContent = error instanceof Error ? error.message : "Could not import this archive.";
    }
  }

  private handleShortcut(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
    if (document.querySelector("dialog[open]") || this.canvas?.isInputActive) return;
    if (this.view === "library") {
      if (event.key === "/" || ((event.ctrlKey || event.metaKey) && event.key === "f")) {
        event.preventDefault();
        byId<HTMLInputElement>("library-search").focus();
      }
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !this.showTrash) {
      const shortcut = ({ p: "pen", h: "highlighter", e: "eraser", l: "line", v: "hand" } as const)[event.key.toLowerCase() as "p" | "h" | "e" | "l" | "v"];
      if (shortcut) { event.preventDefault(); this.selectTool(shortcut); return; }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); void this.turnPage(event.key === "ArrowLeft" ? -1 : 1); return; }
    }
    if (event.key === "/") {
      event.preventDefault();
      if (!byId("sidebar").classList.contains("is-open")) this.toggleDrawer("sidebar");
      else byId<HTMLInputElement>("search-input").focus();
      return;
    }
    if (event.key === "Escape" && (byId("sidebar").classList.contains("is-open") || byId("inspector").classList.contains("is-open"))) {
      this.closeDrawers();
      return;
    }
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLocaleLowerCase() === "s") { event.preventDefault(); void this.flushPendingSave(); }
    if (!this.showTrash && modifier && event.key.toLocaleLowerCase() === "z") { event.preventDefault(); event.shiftKey ? this.canvas?.redo() : this.canvas?.undo(); this.updateToolbar(); }
    if (!this.showTrash && modifier && event.key.toLocaleLowerCase() === "y") { event.preventDefault(); this.canvas?.redo(); this.updateToolbar(); }
  }

  private openDialog(id: string): void { byId<HTMLDialogElement>(id).showModal(); }
  private closeDialog(id: string): void { byId<HTMLDialogElement>(id).close(); }

  private setOfflineCacheStatus(status: OfflineCacheStatus, message: string): void {
    this.offlineCacheStatus = status;
    this.offlineCacheMessage = message;
    const target = document.getElementById("offline-cache-status");
    if (target) {
      target.textContent = message;
      target.dataset.state = status;
    }
  }

  private readonly handleServiceWorkerMessage = (event: MessageEvent): void => {
    const data = event.data;
    if (!data || typeof data !== "object" || data.type !== "notepad-cache-error") return;
    const message = typeof data.message === "string" && data.message.trim() ? data.message : "The offline cache could not be prepared.";
    this.setOfflineCacheStatus("error", `Offline cache error: ${message}`);
  };

  private async registerServiceWorker(): Promise<void> {
    if (!("serviceWorker" in navigator)) {
      this.setOfflineCacheStatus("unsupported", "Offline cache is unavailable in this browser.");
      return;
    }
    if (import.meta.env.DEV) {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.filter((registration) => registration.scope.includes(BASE)).map((registration) => registration.unregister()));
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.startsWith("notepad-static-") || key.startsWith("notepad-shell-")).map((key) => caches.delete(key)));
        this.setOfflineCacheStatus("development", "Offline cache is disabled in development.");
      } catch {
        this.setOfflineCacheStatus("error", "Could not clear the development service worker.");
      }
      return;
    }
    this.setOfflineCacheStatus("preparing", "Preparing offline cache…");
    navigator.serviceWorker.addEventListener("message", this.handleServiceWorkerMessage);
    try {
      const registration = await navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE });
      const worker = registration.installing ?? registration.waiting;
      if (worker) await waitForServiceWorker(worker);
      await navigator.serviceWorker.ready;
      if (!registration.active || registration.active.state !== "activated") throw new Error("The service worker did not activate.");
      this.setOfflineCacheStatus("ready", navigator.serviceWorker.controller ? "Offline cache ready." : "Offline cache ready; available after reload.");
    } catch (error) {
      this.setOfflineCacheStatus("error", `Offline cache error: ${error instanceof Error ? error.message : "installation failed"}`);
    }
  }
}

function toolIcon(name: "hand" | "pen" | "highlighter" | "eraser" | "line"): string {
  const paths = {
    hand: '<path d="M8 13V6a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v8c0 5-3 7-6 7h-1c-2 0-3-1-5-3l-4-5a2 2 0 0 1 3-2l1 1Z"/>',
    pen: '<path d="m4 20 2-7L17 2l5 5L11 18l-7 2Zm2-7 5 5M14 5l5 5M4 20l4-4"/>',
    highlighter: '<path d="m5 12 9-10 7 7-9 10-7-7Zm2 2-4 5 2 2 5-4M2 23h17"/>',
    eraser: '<path d="m3 14 10-11a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3L11 21H8l-5-4a2 2 0 0 1 0-3Zm4-4 9 8M11 21h10"/>',
    line: '<path d="M5 19 19 5M3 16v5h5M16 3h5v5"/>',
  };
  return `<svg viewBox="0 0 24 26" width="23" height="25" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

function shellMarkup(auth: AuthSession): string {
  return `<div class="app-shell">
    <button class="drawer-backdrop" id="drawer-backdrop" aria-label="Close open panel" hidden></button>
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-head"><a class="brand" href="${BASE}" aria-label="NotePad home"><span class="brand-mark">N</span><span><strong>NotePad</strong><small>quiet paper</small></span></a><button class="icon-button" id="close-sidebar" aria-label="Close notebook menu">×</button></div>
      <button class="new-button" id="new-notebook"><span>＋</span> New notebook</button>
      <label class="search-field"><span>⌕</span><input id="search-input" type="search" placeholder="Search notes" aria-label="Search notes" autocomplete="off" /></label>
      <div class="list-section"><div class="list-heading"><span>NOTEBOOKS</span><span class="rule"></span></div><nav id="notebook-list" aria-label="Notebooks"></nav></div>
      <div class="list-section pages-section"><div class="list-heading"><span>PAGES</span><button id="new-page" class="small-action" aria-label="New page">＋</button></div><nav id="page-list" aria-label="Pages"></nav></div>
      <div class="sidebar-bottom"><button class="utility-row" id="trash-toggle" aria-pressed="false"><span>♢</span><span id="trash-label">Trash</span></button><button class="utility-row" id="settings-button"><span>⌘</span> Settings</button></div>
    </aside>
    <main class="library" id="library" aria-label="Notebook library">
      <header class="library-header"><a class="library-brand" href="${BASE}">NotePad</a><div><button id="library-trash" class="library-icon" aria-label="Open trash">♢</button><button id="library-settings" class="library-icon" aria-label="Library settings">⚙</button><button id="library-account" class="library-icon" aria-label="Library account">○</button></div></header>
      <section class="library-body"><div class="library-heading"><div><h1 id="library-title" tabindex="-1">Documents</h1><span id="library-count">0 notebooks</span></div><button class="library-new" id="library-new">＋ New…</button></div>
        <div class="library-controls"><label class="library-search"><span aria-hidden="true">⌕</span><input type="search" id="library-search" aria-label="Search library" placeholder="Search notebooks and typed notes" /></label><label class="library-sort">Sort by <select id="library-sort" aria-label="Sort notebooks"><option value="modified">Last edited</option><option value="name">Name</option></select></label><button class="library-icon" id="library-layout" aria-label="List view" aria-pressed="false">☷</button></div>
        <div class="library-books" id="library-books"></div><p class="library-empty" id="library-empty" role="status" hidden></p>
      </section>
      <nav class="library-tabs" aria-label="Library sections"><button id="library-documents" aria-current="page"><span aria-hidden="true">▱</span>Documents</button><button id="library-tab-search" aria-current="false"><span aria-hidden="true">⌕</span>Search</button><button id="library-favorites" aria-current="false"><span aria-hidden="true">☆</span>Favorites</button></nav>
    </main>
    <main class="workspace" id="editor-workspace" hidden>
      <header class="topbar"><div class="topbar-leading"><button class="back-library" id="back-library" aria-label="Back to Documents">‹ <span>Documents</span></button><button class="drawer-trigger" id="mobile-menu" aria-controls="sidebar" aria-expanded="false"><span class="drawer-trigger-icon">☰</span><span>Pages</span></button><div class="crumbs"><span class="eyebrow">NOTEBOOK</span><button class="notebook-title-button" id="rename-notebook" aria-label="Rename notebook"><strong id="notebook-name">My notebook</strong><span aria-hidden="true">✎</span></button></div></div><div class="top-actions"><button class="text-toggle" id="text-toggle" aria-label="Text and page details" aria-controls="inspector" aria-expanded="false"><span aria-hidden="true">T</span><span>Text</span></button><button class="sync-status" id="sync-button" aria-label="Sign in required"><span id="sync-icon">·</span><span id="sync-label">Sign in required</span></button><button class="avatar-button" id="auth-button" aria-label="Account">○</button></div></header>
      <section class="editor-layout">
        <div class="editor-stage" id="editor-content">
      <div class="editor-toolbar" role="toolbar" aria-label="Writing tools">
        <div class="tool-group primary-tools">
          <button class="tool-button" id="hand-tool" aria-label="Read and pan" title="Read & pan (V)">${toolIcon("hand")}</button>
          <span class="toolbar-divider"></span>
          <button class="tool-button active" id="pen-tool" aria-label="Pen tool" title="Pen (P)">${toolIcon("pen")}</button>
          <button class="tool-button" id="highlighter-tool" aria-label="Highlighter tool" title="Highlighter (H)">${toolIcon("highlighter")}</button>
          <button class="tool-button" id="eraser-tool" aria-label="Whole stroke eraser" title="Stroke eraser (E)">${toolIcon("eraser")}</button>
          <button class="tool-button" id="line-tool" aria-label="Straight line tool" title="Straight line (L)">${toolIcon("line")}</button>
          <span class="toolbar-divider"></span>
          <button class="quiet-button" id="undo-button" aria-label="Undo" title="Undo (Ctrl/⌘ Z)" disabled>↶</button>
          <button class="quiet-button" id="redo-button" aria-label="Redo" title="Redo (Ctrl/⌘ Shift Z)" disabled>↷</button>
        </div>
        <div class="tool-group ink-options" id="ink-options">
          <select id="pen-style" aria-label="Pen style"><option value="fountain">Fountain pen</option><option value="ball">Ball pen</option></select>
          <div class="color-palette" aria-label="Ink colors">${[0xff252429, 0xffb94e3e, 0xff365d68, 0xfff2ca52].map((color, index) => `<button class="color-dot" data-color="${color}" style="--dot:${argbToCSS(color)}" aria-label="${["Graphite", "Terracotta", "Deep teal", "Yellow"][index]}"></button>`).join("")}</div>
          <span id="color-preview" class="color-preview"></span>
          <div class="width-presets" aria-label="Stroke widths">${[1.5, 3, 6].map((width) => `<button class="width-preset" data-width="${width}" aria-label="${width} pixels"><span style="width:${width + 2}px;height:${width + 2}px"></span></button>`).join("")}</div>
          <label class="width-control"><span id="width-value">3px</span><input id="width-range" type="range" min="1" max="12" step="0.5" value="3" aria-label="Stroke width" /></label>
        </div>
      </div>
          <div class="page-bar"><button class="page-title-button" id="rename-page" aria-label="Rename page"><span class="page-title-kicker">PAGE</span><strong id="page-title-label">First page</strong><span aria-hidden="true">✎</span></button><div class="page-navigation"><button class="quiet-button" id="previous-page" aria-label="Previous page">‹</button><span id="page-position" aria-live="polite">1 / 1</span><button class="quiet-button" id="next-page" aria-label="Next page">›</button><button class="quiet-button add-page" id="add-page" aria-label="Add page" title="Add page with the same paper">＋</button></div></div>
          <div class="paper-viewport" id="paper-viewport"><div class="paper" id="paper"><canvas id="ink-canvas" aria-label="Note page drawing surface"></canvas></div></div>
          <div class="print-note" aria-hidden="true"><h1 id="print-title"></h1><p id="print-text"></p></div>
           <div class="stage-foot" title="Two fingers to move or zoom · Hand tool for one-finger pan"><span id="tool-name" aria-live="polite">Pen</span><small class="gesture-hint">2 fingers: move / zoom · Hand: 1-finger pan</small><div class="view-controls"><button class="quiet-button" id="zoom-out" aria-label="Zoom out">−</button><span class="zoom-label" id="zoom-label">100%</span><button class="quiet-button" id="zoom-in" aria-label="Zoom in">＋</button><button class="quiet-button" id="fit-button" aria-label="Fit page width">Fit width</button><button class="quiet-button" id="fit-whole-page" aria-label="Fit whole page">Full page</button></div><span id="page-revision">revision 0</span></div>
        </div>
        <div class="empty-editor hidden" id="editor-empty"><div class="empty-orbit">✦</div><h1>Choose a page</h1><p>Your paper is waiting in the left rail.</p></div>
      <aside class="inspector" id="inspector" aria-label="Text and page details" aria-hidden="true"><div class="inspector-head"><div><span class="eyebrow">TEXT & DETAILS</span><strong class="inspector-title">Page tools</strong></div><button class="icon-button" id="close-inspector" aria-label="Close text panel">×</button></div><label class="title-field"><span>Page title</span><input id="page-title" type="text" placeholder="Untitled page" /></label><label class="text-field"><span>Typed note</span><textarea id="page-text" rows="8" placeholder="Type in Thai or English…" dir="auto"></textarea></label><label class="select-field"><span>Paper</span><select id="background-select"><option value="blank">Blank</option><option value="ruled">Ruled lines</option><option value="grid">Grid</option></select></label><div class="inspector-actions"><button class="outline-button" id="duplicate-page">Duplicate page</button><button class="outline-button" id="delete-page">Move page to trash</button><button class="outline-button" id="archive-notebook" title="Archive or restore notebook" aria-label="Archive or restore notebook">Archive notebook</button><button class="outline-button" id="print-button">Print / PDF</button><button class="outline-button" id="share-button">Share archive</button><button class="outline-button" id="export-button">Export backup</button></div><p class="inspector-note">Changes save locally after each edit. Sync uses the configured server only when you sign in.</p></aside>
      </section>
    </main>
    <dialog class="dialog new-document-dialog" id="new-document-dialog" aria-label="New document"><div class="dialog-form"><div class="dialog-head"><h2>New…</h2><button class="icon-button" id="cancel-new-document" aria-label="Close new document">×</button></div><button id="new-document-notebook" class="new-document-option"><span aria-hidden="true">▱</span><span><strong>Notebook</strong><small>Choose your paper and start writing</small></span><span aria-hidden="true">›</span></button><button id="new-document-import" class="new-document-option"><span aria-hidden="true">↥</span><span><strong>Import backup</strong><small>Open a NotePad archive</small></span><span aria-hidden="true">›</span></button></div></dialog>
    ${dialogMarkup(auth)}
  </div>`;
}

function authMarkup(): string {
  return `<dialog class="dialog" id="auth-dialog"><form class="dialog-form" id="auth-form" data-mode="login"><div class="dialog-head"><div><span class="eyebrow">ACCOUNT</span><h2 id="auth-dialog-title">Sign in to NotePad</h2></div></div><div class="mode-switch"><button type="button" id="login-mode" class="active">Sign in</button><button type="button" id="register-mode">Create account</button></div><label>Identifier<input id="auth-identifier" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="you@example.com or username" required /></label><label>Password<input id="auth-password" type="password" autocomplete="current-password" minlength="12" placeholder="12 characters minimum" required /></label><p class="form-hint">Sign in with the same account on each device to keep your notebooks together.</p><details><summary>Sync server</summary><label>Server URL<input id="auth-endpoint" type="url" required placeholder="https://notes.example.com" /></label></details><p class="form-error" id="auth-error" role="alert"></p><button class="primary-button" id="auth-submit" type="submit">Sign in</button></form></dialog>`;
}

function dialogMarkup(auth: AuthSession): string {
  return `${authMarkup()}
  <dialog class="dialog" id="settings-dialog"><form class="dialog-form" id="settings-form"><div class="dialog-head"><div><span class="eyebrow">SETTINGS</span><h2>Keep your paper close</h2></div><button type="button" class="icon-button" id="cancel-settings" aria-label="Close">×</button></div><label>Sync server URL<input id="endpoint-input" type="url" inputmode="url" placeholder="https://notes.example.com" /></label><p class="form-hint">Use the same HTTPS server on every device. Changing servers requires signing in again.</p><p class="form-message offline-cache-status" id="offline-cache-status" role="status">Preparing offline cache…</p><div class="settings-actions"><button class="outline-button" type="button" id="browse-import">Import backup</button><button class="outline-button" type="button" id="settings-export">Export backup</button><button class="outline-button" type="button" id="settings-share">Share backup</button></div><input id="import-input" type="file" accept="application/json,.json,.notepad" hidden /><p class="form-message" id="settings-message"></p>${thisAccountMarkup(auth)}<button class="primary-button" type="submit">Save settings</button></form></dialog>
  <dialog class="dialog" id="notebook-dialog"><form class="dialog-form" id="notebook-form"><div class="dialog-head"><div><span class="eyebrow">NOTEBOOK</span><h2>Rename notebook</h2></div><button type="button" class="icon-button" id="cancel-notebook" aria-label="Close">×</button></div><label>Name<input id="notebook-title" type="text" maxlength="500" autocomplete="off" required /></label><div id="new-notebook-options" hidden><label>Paper<select id="new-paper"><option value="blank">Blank</option><option value="ruled" selected>Ruled lines</option><option value="grid">Grid</option></select></label><div class="paper-choices" role="group" aria-label="Paper preview"><button type="button" class="paper-sample paper-blank" data-paper="blank" aria-pressed="false">Blank</button><button type="button" class="paper-sample paper-ruled" data-paper="ruled" aria-pressed="true">Ruled</button><button type="button" class="paper-sample paper-grid" data-paper="grid" aria-pressed="false">Grid</button></div></div><p class="form-error" id="notebook-error" role="alert"></p><button class="primary-button" type="submit">Save name</button></form></dialog>
`;
}

function thisAccountMarkup(auth: AuthSession): string {
  const user = auth.user;
  return `<div class="account-line"><span>Account</span><strong id="account-name">${escapeHTML(auth.workspaceIdentifier ?? "Sign in required")}</strong><button type="button" class="outline-button compact" id="logout-button"${user ? "" : " hidden"}>Sign out</button></div><div id="workspace-recovery"></div>`;
}

function loadingMarkup(): string { return `<div class="loading-screen"><span class="brand-mark">N</span><p>Opening your paper…</p></div>`; }
function errorMarkup(message: string): string { return `<div class="loading-screen error-screen"><span class="brand-mark">!</span><h1>Paper could not open</h1><p>${escapeHTML(message)}</p><button class="primary-button" onclick="location.reload()">Try again</button></div>`; }
function byId<T extends HTMLElement = HTMLElement>(id: string): T { const element = document.getElementById(id); if (!element) throw new Error(`Missing UI element #${id}`); return element as T; }
function onClick(id: string, handler: () => void): void { byId(id).addEventListener("click", handler); }
function escapeHTML(value: string): string { return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[char] ?? char); }
function escapeAttr(value: string): string { return escapeHTML(value); }
function preview(value: string): string { return value.replace(/\s+/g, " ").trim().slice(0, 54); }
function pageNotebookLabel(page: NotePage, notebooks: Notebook[]): string {
  const notebook = notebooks.find((item) => item.id === page.notebookId);
  return notebook ? escapeHTML(notebook.title) : "Notebook";
}
function dateStamp(): string { return new Date().toISOString().slice(0, 10); }
function download(blob: Blob, filename: string): void { const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
function argbToCSS(color: number): string { const value = color >>> 0; return `rgba(${(value >>> 16) & 0xff},${(value >>> 8) & 0xff},${value & 0xff},${((value >>> 24) & 0xff) / 255})`; }

function waitForServiceWorker(worker: ServiceWorker): Promise<void> {
  if (worker.state === "activated") return Promise.resolve();
  if (worker.state === "redundant") return Promise.reject(new Error("installation failed"));
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error("installation timed out")), 20_000);
    const onStateChange = (): void => {
      if (worker.state === "activated") finish();
      else if (worker.state === "redundant") finish(new Error("installation failed"));
    };
    const finish = (error?: Error): void => {
      window.clearTimeout(timeout);
      worker.removeEventListener("statechange", onStateChange);
      if (error) reject(error);
      else resolve();
    };
    worker.addEventListener("statechange", onStateChange);
    onStateChange();
  });
}

const appRoot = document.getElementById("app");
if (appRoot) new NotePadApp(appRoot);
