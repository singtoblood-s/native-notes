import "./styles.css";
import { AuthClient, AuthSession, getEndpoint, setEndpoint, workspaceAccountKey } from "./auth";
import { PaperCanvas, CanvasTool } from "./canvas";
import {
  AuthResponse,
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
  private editGeneration = 0;
  private search = "";
  private showTrash = false;
  private pendingGuestArchive: Archive | null = null;
  private useGuestWorkspace = false;
  private offlineCacheStatus: OfflineCacheStatus = "preparing";
  private offlineCacheMessage = "Preparing offline cache…";
  private coordinatorGeneration = -1;
  private pendingRemoteRefresh: { store: NoteStore; conflicts: number } | null = null;
  private remoteRefreshTimer: number | null = null;
  private readonly handlePageHide = (): void => { void this.flushPendingSave(); };

  constructor(root: HTMLElement) {
    this.root = root;
    void this.start();
  }

  private async start(): Promise<void> {
    this.root.innerHTML = loadingMarkup();
    try {
      this.store = await SQLiteNoteStore.open(this.accountKey());
      const startupSession = this.auth.session;
      // Guest and expired-account workspaces can safely create their local
      // starter before rendering. An authenticated workspace must render its
      // cached rows first and let the coordinator pull before deciding that it
      // is genuinely empty; this keeps a dead server from blocking the editor.
      if (!startupSession) await this.ensureInitialData();
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
    return this.useGuestWorkspace ? "guest" : this.auth.workspaceKey;
  }

  private async ensureInitialData(): Promise<boolean> {
    // A deleted notebook is still real user data. Only create the first
    // starter notebook when this workspace has never had one.
    if ((await this.store.listNotebooks(true)).length !== 0) return false;
    await this.store.ensureStarterData();
    this.coordinator.notifyLocalWrite();
    return true;
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
    byId<HTMLInputElement>("endpoint-input").value = getEndpoint();
    this.renderWorkspaceRecovery();
    this.setOfflineCacheStatus(this.offlineCacheStatus, this.offlineCacheMessage);
    this.syncDrawerState();
  }

  private bindEvents(): void {
    onClick("new-notebook", () => this.createNotebook());
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
    onClick("print-button", () => window.print());
    onClick("export-button", () => this.exportArchive());
    onClick("share-button", () => this.shareArchive());
    onClick("settings-button", () => this.openSettings());
    onClick("auth-button", () => this.openAuthDialog());
    onClick("logout-button", () => this.logout());
    onClick("archive-notebook", () => this.archiveCurrentNotebook());
    onClick("delete-page", () => this.deleteCurrentPage());
    onClick("cancel-auth", () => this.closeDialog("auth-dialog"));
    onClick("cancel-settings", () => this.closeDialog("settings-dialog"));
    onClick("cancel-notebook", () => this.closeDialog("notebook-dialog"));
    onClick("cancel-migration", () => this.closeDialog("migration-dialog"));
    onClick("keep-guest", () => this.finishMigration(false));
    onClick("move-guest", () => this.finishMigration(true));
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
      byId("width-value").textContent = `${width}px`;
      const tool: CanvasTool = byId("eraser-tool").classList.contains("active") ? { kind: "eraser", width } : { kind: "pen", color: this.selectedColor(), width };
      this.canvas?.setTool(tool);
    });
    document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((button) => button.addEventListener("click", () => {
      const value = Number(button.dataset.color);
      document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
      byId("color-preview").style.backgroundColor = argbToCSS(value);
      this.selectTool("pen", value);
    }));
    byId<HTMLFormElement>("auth-form").addEventListener("submit", (event) => { event.preventDefault(); void this.submitAuth(); });
    byId<HTMLButtonElement>("register-mode").addEventListener("click", () => this.setAuthMode("register"));
    byId<HTMLButtonElement>("login-mode").addEventListener("click", () => this.setAuthMode("login"));
    byId<HTMLFormElement>("settings-form").addEventListener("submit", (event) => { event.preventDefault(); void this.saveSettings(); });
    byId<HTMLFormElement>("notebook-form").addEventListener("submit", (event) => { event.preventDefault(); void this.submitNotebookRename(); });
    document.addEventListener("keydown", (event) => this.handleShortcut(event));
    window.addEventListener("online", () => this.setState(this.auth.session ? { kind: "saved" } : { kind: "needs-login" }));
    window.addEventListener("offline", () => this.setState({ kind: "offline" }));
    window.addEventListener("pagehide", this.handlePageHide, { capture: true });
  }

  private async reload(selectID?: string, guard?: { store: NoteStore; generation: number }): Promise<boolean> {
    const searchAtStart = this.search;
    const trashAtStart = this.showTrash;
    const store = this.store;
    const accountAtStart = this.accountKey();
    const isSafe = (): boolean => store === this.store && accountAtStart === this.accountKey() && (!guard || (guard.store === this.store && guard.generation === this.editGeneration && !this.canvasInputActive() && searchAtStart === this.search && trashAtStart === this.showTrash));
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
    if (!(await this.flushPendingSave())) return;
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
    byId("mobile-menu").setAttribute("aria-expanded", String(sidebarOpen));
    byId("text-toggle").setAttribute("aria-expanded", String(inspectorOpen));
    document.body.classList.toggle("drawer-open", sidebarOpen || inspectorOpen);
  }

  private async closeDrawers(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    byId("sidebar").classList.remove("is-open");
    byId("inspector").classList.remove("is-open");
    this.syncDrawerState();
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

  private openNotebookRename(): void {
    if (!this.currentNotebook) return;
    const input = byId<HTMLInputElement>("notebook-title");
    input.value = this.currentNotebook.title;
    byId("notebook-error").textContent = "";
    this.openDialog("notebook-dialog");
    window.setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  private async submitNotebookRename(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    const notebook = this.currentNotebook;
    if (!notebook) return;
    const title = byId<HTMLInputElement>("notebook-title").value.trim();
    if (!title || title.length > 500) {
      byId("notebook-error").textContent = "Use a notebook name from 1 to 500 characters.";
      return;
    }
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

  private renderLists(): void {
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
    byId<HTMLButtonElement>("undo-button").disabled = this.showTrash || !this.canvas?.hasUndo;
    byId<HTMLButtonElement>("redo-button").disabled = this.showTrash || !this.canvas?.hasRedo;
  }

  private async selectNotebook(id: string): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    this.editGeneration += 1;
    this.currentNotebook = await this.store.getNotebook(id);
    this.pages = this.currentNotebook ? await this.store.listPages(this.currentNotebook.id, this.showTrash) : [];
    this.currentPage = this.showTrash
      ? this.allPages.find((page) => page.notebookId === id && this.isPageInTrash(page)) ?? null
      : this.pages.find((page) => !page.deletedAt) ?? null;
    this.renderLists();
    this.renderEditor();
    this.rememberSelection();
    await this.closeDrawers();
  }

  private async selectPage(id: string): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    this.editGeneration += 1;
    this.currentPage = await this.store.getPage(id);
    if (this.currentPage && this.currentPage.notebookId !== this.currentNotebook?.id) {
      this.currentNotebook = await this.store.getNotebook(this.currentPage.notebookId);
      this.pages = this.currentNotebook ? await this.store.listPages(this.currentNotebook.id, this.showTrash) : [];
    }
    this.renderLists();
    this.renderEditor();
    this.rememberSelection();
    await this.closeDrawers();
  }

  private async createNotebook(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    const title = window.prompt("Notebook name", "My notebook")?.trim();
    if (!title) return;
    const notebook = createNotebook(title);
    try {
      const result = await this.store.saveNotebook(notebook);
      if (result.status === "failed") {
        this.setState({ kind: "error", message: result.message ?? "Could not save notebook" });
        return;
      }
      this.coordinator.notifyLocalWrite();
      const page = createPage(notebook.id, "First page");
      const pageResult = await this.store.savePage(page);
      if (pageResult.status === "failed") {
        this.setState({ kind: "error", message: pageResult.message ?? "Notebook saved, but its first page could not be saved." });
        await this.reload();
        return;
      }
      this.coordinator.notifyLocalWrite();
      this.currentNotebook = { ...notebook, revision: result.revision ?? notebook.revision };
      await this.reload(page.id);
    } catch (error) {
      this.setState({ kind: "error", message: error instanceof Error ? error.message : "Could not save notebook" });
    }
  }

  private async createNewPage(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    if (!this.currentNotebook || this.showTrash) return;
    const page = createPage(this.currentNotebook.id, `Page ${this.pages.length + 1}`);
    try {
      const result = await this.store.savePage(page);
      if (result.status === "failed") return this.setState({ kind: "error", message: result.message ?? "Could not save page" });
      this.coordinator.notifyLocalWrite();
      await this.reload(page.id);
      const title = byId<HTMLInputElement>("page-title");
      title.focus();
      title.select();
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
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.setState({ kind: "saving" });
    this.saveTimer = window.setTimeout(() => { this.saveTimer = null; void this.saveCurrentPage(); }, delay);
  }

  private async saveCurrentPage(): Promise<boolean> {
    // A timer and a navigation can reach this method together. Serialize the
    // writes, then capture the newest page state after the older write settles.
    if (this.saveInFlight) await this.saveInFlight;
    if (!this.currentPage) return true;
    const page = clonePage(this.currentPage);
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
        const savedPage = { ...page, revision: result.revision ?? page.revision, updatedAt: savedAt };
        const listedIndex = this.pages.findIndex((item) => item.id === page.id);
        if (listedIndex >= 0) this.pages[listedIndex] = clonePage(savedPage);
        const allIndex = this.allPages.findIndex((item) => item.id === page.id);
        if (allIndex >= 0) this.allPages[allIndex] = clonePage(savedPage);
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
    if (timer !== null) {
      window.clearTimeout(timer);
      this.saveTimer = null;
      if (!(await this.saveCurrentPage())) return false;
    }
    const inFlight = this.saveInFlight;
    if (inFlight && !(await inFlight)) return false;
    return true;
  }

  private selectTool(kind: "pen" | "eraser", color = this.selectedColor()): void {
    byId("pen-tool").classList.toggle("active", kind === "pen");
    byId("eraser-tool").classList.toggle("active", kind === "eraser");
    const width = Number(byId<HTMLInputElement>("width-range").value);
    this.canvas?.setTool(kind === "pen" ? { kind, color, width } : { kind, width });
  }

  private selectedColor(): number {
    const preview = byId("color-preview").style.backgroundColor;
    const found = [...document.querySelectorAll<HTMLButtonElement>("[data-color]")].find((button) => button.classList.contains("active"));
    return found ? Number(found.dataset.color) : preview ? cssToARGB(preview) : 0xff252429;
  }

  private setState(state: SyncState): void {
    const offlineAccountLabel = this.auth.workspaceKey !== "guest" && this.auth.workspaceIdentifier ? `Offline · ${this.auth.workspaceIdentifier} · sign in to sync` : "Guest · local only";
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
    if (!this.saveTimer && !this.saveInFlight) {
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
    if (this.canvasInputActive() || expectedGeneration !== this.editGeneration || this.saveTimer !== null || this.saveInFlight !== null) {
      if (context.report.pulled > 0 || context.report.conflicts > 0) this.queueRemoteRefresh(context);
      return;
    }
    let createdStarter = false;
    // A migration dialog represents an explicit user choice. Do not add a
    // second starter notebook while that choice is still pending.
    if (!this.pendingGuestArchive) createdStarter = await this.ensureInitialData();
    if (context.store !== this.store || expectedGeneration !== this.editGeneration || this.saveTimer !== null || this.saveInFlight !== null || this.canvasInputActive()) {
      if (context.report.pulled > 0 || context.report.conflicts > 0) this.queueRemoteRefresh(context);
      return;
    }
    if (context.report.pulled > 0 || context.report.conflicts > 0 || createdStarter) {
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
    this.setAuthMode("login");
    this.openDialog("auth-dialog");
  }

  private setAuthMode(mode: "login" | "register"): void {
    byId("auth-dialog-title").textContent = mode === "login" ? "Sign in to sync" : "Create an account";
    byId("auth-submit").textContent = mode === "login" ? "Sign in" : "Create account";
    byId("auth-form").dataset.mode = mode;
    byId("login-mode").classList.toggle("active", mode === "login");
    byId("register-mode").classList.toggle("active", mode === "register");
  }

  private async submitAuth(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    const identifier = byId<HTMLInputElement>("auth-identifier").value.trim();
    const password = byId<HTMLInputElement>("auth-password").value;
    if (!identifier || password.length < 12) { byId("auth-error").textContent = "Use an identifier and a password of at least 12 characters."; return; }
    if (!getEndpoint()) { byId("auth-error").textContent = "Add the HTTPS server URL in Settings first."; return; }
    const wasGuest = this.accountKey() === "guest";
    const guestArchive = wasGuest ? await this.store.exportArchive() : null;
    const mode = byId("auth-form").dataset.mode === "register" ? "register" : "login";
    try {
      const response: AuthResponse = mode === "register" ? await this.authClient.register(identifier, password) : await this.authClient.login(identifier, password);
      this.rememberSelection();
      this.pauseCoordinatorForStoreSwitch();
      this.auth.set(response);
      this.useGuestWorkspace = false;
      byId("account-name").textContent = response.user.identifier;
      byId<HTMLButtonElement>("logout-button").hidden = false;
      await this.store.close();
      this.currentNotebook = null;
      this.currentPage = null;
      this.pages = [];
      this.allPages = [];
      this.store = await SQLiteNoteStore.open(this.accountKey());
      this.pendingGuestArchive = guestArchive && guestArchive.pages.length > 0 ? guestArchive : null;
      this.closeDialog("auth-dialog");
      await this.reload();
      this.resumeCoordinatorAfterStoreSwitch();
      if (this.pendingGuestArchive) this.openDialog("migration-dialog");
    } catch (error) {
      byId("auth-error").textContent = error instanceof Error ? error.message : "Sign-in failed.";
    }
  }

  private async finishMigration(move: boolean): Promise<void> {
    if (move && this.pendingGuestArchive) {
      try {
        await this.store.importArchive(this.pendingGuestArchive);
      } catch (error) {
        this.setState({ kind: "error", message: error instanceof Error ? error.message : "Could not move the guest notebook." });
        return;
      }
    }
    this.pendingGuestArchive = null;
    this.closeDialog("migration-dialog");
    await this.reload();
    if (move) this.coordinator.notifyLocalWrite();
    this.coordinator.request("migration");
  }

  private async logout(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    this.pauseCoordinatorForStoreSwitch();
    const session = this.auth.session;
    if (session) { try { await this.authClient.logout(session.sessionToken, this.auth.boundEndpoint ?? getEndpoint()); } catch { /* local logout still succeeds offline */ } }
    this.rememberSelection();
    await this.store.close();
    this.auth.clear();
    this.useGuestWorkspace = true;
    this.store = await SQLiteNoteStore.open("guest");
    await this.ensureInitialData();
    await this.reload();
    this.resumeCoordinatorAfterStoreSwitch();
    this.closeDialog("settings-dialog");
    byId("account-name").textContent = "Guest · this device";
    byId<HTMLButtonElement>("logout-button").hidden = true;
    this.setState({ kind: "needs-login" });
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
    if (raw && !next) {
      setEndpoint(previous);
      byId("settings-message").textContent = "Use an HTTPS URL. HTTP is allowed only for localhost development.";
      return;
    }
    if (previous !== next && this.auth.boundEndpoint) {
      // The token is bound to the endpoint used during login. Close it before
      // clearing the token or identity so a changed server can never open or
      // receive the old account session.
      this.rememberSelection();
      this.pauseCoordinatorForStoreSwitch();
      await this.store.close();
      this.auth.clear();
      this.useGuestWorkspace = true;
      this.currentNotebook = null;
      this.currentPage = null;
      this.pages = [];
      this.allPages = [];
      this.store = await SQLiteNoteStore.open(this.accountKey());
      await this.ensureInitialData();
      await this.reload();
      this.pendingRemoteRefresh = null;
      this.resumeCoordinatorAfterStoreSwitch();
      byId("account-name").textContent = "Guest · this device";
      byId<HTMLButtonElement>("logout-button").hidden = true;
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
    <main class="workspace">
      <header class="topbar"><div class="topbar-leading"><button class="drawer-trigger" id="mobile-menu" aria-controls="sidebar" aria-expanded="false"><span class="drawer-trigger-icon">☰</span><span>Notebooks</span></button><div class="crumbs"><span class="eyebrow">NOTEBOOK</span><button class="notebook-title-button" id="rename-notebook" aria-label="Rename notebook"><strong id="notebook-name">My notebook</strong><span aria-hidden="true">✎</span></button></div></div><div class="top-actions"><button class="text-toggle" id="text-toggle" aria-label="Text and page details" aria-controls="inspector" aria-expanded="false"><span aria-hidden="true">T</span><span>Text</span></button><button class="sync-status" id="sync-button" aria-label="Guest local mode"><span id="sync-icon">·</span><span id="sync-label">Guest · local only</span></button><button class="avatar-button" id="auth-button" aria-label="Account">○</button></div></header>
      <section class="editor-layout">
        <div class="editor-stage" id="editor-content">
      <div class="editor-toolbar"><div class="tool-group"><button class="tool-button active" id="pen-tool" aria-label="Pen tool" title="Pen">✎</button><button class="tool-button" id="eraser-tool" aria-label="Whole stroke eraser" title="Whole stroke eraser">⌫</button><span class="toolbar-divider"></span><div class="color-palette" aria-label="Pen colors"><button class="color-dot active" data-color="4280624169" style="--dot:#252429" aria-label="Graphite"></button><button class="color-dot" data-color="4290334270" style="--dot:#b94e3e" aria-label="Terracotta"></button><button class="color-dot" data-color="4281752936" style="--dot:#365d68" aria-label="Deep teal"></button><button class="color-dot" data-color="4289955637" style="--dot:#b38735" aria-label="Ochre"></button></div><span id="color-preview" class="color-preview" style="background:#252429"></span><label class="width-control"><span id="width-value">3px</span><input id="width-range" type="range" min="1" max="12" step="0.5" value="3" aria-label="Pen width" /></label></div><div class="tool-group tool-group-right"><button class="quiet-button" id="undo-button" aria-label="Undo" title="Undo (⌘Z)" disabled>↶</button><button class="quiet-button" id="redo-button" aria-label="Redo (⇧⌘Z)" disabled>↷</button><span class="toolbar-divider"></span><button class="quiet-button" id="zoom-out" aria-label="Zoom out">−</button><span class="zoom-label" id="zoom-label">100%</span><button class="quiet-button" id="zoom-in" aria-label="Zoom in">＋</button><button class="quiet-button" id="fit-button" aria-label="Fit page">Fit</button></div></div>
          <div class="page-bar"><button class="page-title-button" id="rename-page" aria-label="Rename page"><span class="page-title-kicker">PAGE</span><strong id="page-title-label">First page</strong><span aria-hidden="true">✎</span></button><span class="page-bar-hint">Tap Text to type · use a stylus to write</span></div>
          <div class="paper-viewport" id="paper-viewport"><div class="paper" id="paper"><canvas id="ink-canvas" aria-label="Note page drawing surface"></canvas></div></div>
          <div class="print-note" aria-hidden="true"><h1 id="print-title"></h1><p id="print-text"></p></div>
          <div class="stage-foot"><span><kbd>⌘</kbd><kbd>S</kbd> save</span><span>Apple Pencil / stylus draws · finger moves paper</span><span id="page-revision">revision 0</span></div>
        </div>
        <div class="empty-editor hidden" id="editor-empty"><div class="empty-orbit">✦</div><h1>Choose a page</h1><p>Your paper is waiting in the left rail.</p></div>
      <aside class="inspector" id="inspector" aria-label="Text and page details" aria-hidden="true"><div class="inspector-head"><div><span class="eyebrow">TEXT & DETAILS</span><strong class="inspector-title">Page tools</strong></div><button class="icon-button" id="close-inspector" aria-label="Close text panel">×</button></div><label class="title-field"><span>Page title</span><input id="page-title" type="text" placeholder="Untitled page" /></label><label class="text-field"><span>Typed note</span><textarea id="page-text" rows="8" placeholder="Type in Thai or English…" dir="auto"></textarea></label><label class="select-field"><span>Paper</span><select id="background-select"><option value="blank">Blank</option><option value="ruled">Ruled lines</option><option value="grid">Grid</option></select></label><div class="inspector-actions"><button class="outline-button" id="delete-page">Move page to trash</button><button class="outline-button" id="archive-notebook" title="Archive or restore notebook" aria-label="Archive or restore notebook">Archive notebook</button><button class="outline-button" id="print-button">Print / PDF</button><button class="outline-button" id="share-button">Share archive</button><button class="outline-button" id="export-button">Export backup</button></div><p class="inspector-note">Changes save locally after each edit. Sync uses the configured server only when you sign in.</p></aside>
      </section>
    </main>
    ${dialogMarkup(auth)}
  </div>`;
}

function dialogMarkup(auth: AuthSession): string {
  return `<dialog class="dialog" id="auth-dialog"><form class="dialog-form" id="auth-form" data-mode="login"><div class="dialog-head"><div><span class="eyebrow">ACCOUNT</span><h2 id="auth-dialog-title">Sign in to sync</h2></div><button type="button" class="icon-button" id="cancel-auth" aria-label="Close">×</button></div><div class="mode-switch"><button type="button" id="login-mode" class="active">Sign in</button><button type="button" id="register-mode">Create account</button></div><label>Identifier<input id="auth-identifier" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="you@example.com or username" required /></label><label>Password<input id="auth-password" type="password" autocomplete="current-password" minlength="12" placeholder="12 characters minimum" required /></label><p class="form-hint">Your guest notebook stays on this device. After sign-in, you choose whether to move it into the account.</p><p class="form-error" id="auth-error" role="alert"></p><button class="primary-button" id="auth-submit" type="submit">Sign in</button></form></dialog>
  <dialog class="dialog" id="settings-dialog"><form class="dialog-form" id="settings-form"><div class="dialog-head"><div><span class="eyebrow">SETTINGS</span><h2>Keep your paper close</h2></div><button type="button" class="icon-button" id="cancel-settings" aria-label="Close">×</button></div><label>Sync server URL<input id="endpoint-input" type="url" inputmode="url" placeholder="https://notes.example.com" /></label><p class="form-hint">Leave this empty for private guest mode. Use an HTTPS URL for login and sync. A temporary tunnel is only available while its server is running.</p><p class="form-message offline-cache-status" id="offline-cache-status" role="status">Preparing offline cache…</p><div class="settings-actions"><button class="outline-button" type="button" id="browse-import">Import backup</button><button class="outline-button" type="button" id="settings-export">Export backup</button><button class="outline-button" type="button" id="settings-share">Share backup</button></div><input id="import-input" type="file" accept="application/json,.json,.notepad" hidden /><p class="form-message" id="settings-message"></p>${thisAccountMarkup(auth)}<button class="primary-button" type="submit">Save settings</button></form></dialog>
  <dialog class="dialog" id="notebook-dialog"><form class="dialog-form" id="notebook-form"><div class="dialog-head"><div><span class="eyebrow">NOTEBOOK</span><h2>Rename notebook</h2></div><button type="button" class="icon-button" id="cancel-notebook" aria-label="Close">×</button></div><label>Name<input id="notebook-title" type="text" maxlength="500" autocomplete="off" required /></label><p class="form-error" id="notebook-error" role="alert"></p><button class="primary-button" type="submit">Save name</button></form></dialog>
  <dialog class="dialog" id="migration-dialog"><div class="dialog-form"><div class="dialog-head"><div><span class="eyebrow">GUEST NOTEBOOK</span><h2>Move your local paper?</h2></div><button type="button" class="icon-button" id="cancel-migration" aria-label="Close">×</button></div><p class="migration-copy">You have notes in guest mode. Move a copy into the signed-in account, or keep the guest notebook on this device for later.</p><div class="migration-actions"><button class="outline-button" id="keep-guest">Keep guest notes</button><button class="primary-button" id="move-guest">Move a copy into account</button></div></div></dialog>`;
}

function thisAccountMarkup(auth: AuthSession): string {
  const user = auth.user;
  return `<div class="account-line"><span>Account</span><strong id="account-name">${escapeHTML(auth.workspaceIdentifier ?? "Guest · this device")}</strong><button type="button" class="outline-button compact" id="logout-button"${user ? "" : " hidden"}>Sign out</button></div><div id="workspace-recovery"></div>`;
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
function cssToARGB(css: string): number { const match = css.match(/[\d.]+/g)?.map(Number); if (!match || match.length < 3) return 0xff252429; return (((Math.round((match[3] ?? 1) * 255) & 0xff) << 24) | ((match[0]! & 0xff) << 16) | ((match[1]! & 0xff) << 8) | (match[2]! & 0xff)) >>> 0; }

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
