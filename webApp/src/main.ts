import "./styles.css";
import { AuthClient, AuthSession, getEndpoint, setEndpoint, workspaceAccountKey } from "./auth";
import { PaperCanvas, CanvasTool, renderPagePreview } from "./canvas";
import {
  InkStroke,
  NotePage,
  Notebook,
  PageImage,
  PageBackground,
  SyncState,
  clonePage,
  createPage,
  createNotebook,
  id,
  isUUID,
  now,
} from "./models";
import { Archive, NoteStore, SQLiteNoteStore } from "./storage";
import { SyncCoordinator, SyncCoordinatorStatus, SyncCompleteContext } from "./coordinator";
import { SyncClient } from "./sync";
import { removeGuestData } from "./remove-guest-data";

const BASE = import.meta.env.BASE_URL;
const APP_BUILD = "2026.09.11";
type OfflineCacheStatus = "preparing" | "ready" | "error" | "unsupported" | "development";
interface SavedSelection { notebookID?: string; pageID?: string; }

type PageViewMode = "continuous" | "horizontal" | "paged";
type ImageImportContext = { page: NotePage; store: NoteStore; navigation: number; generation: number };
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

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
  private showRecovery = false;
  private view: "library" | "editor" = "library";
  private libraryTab: "documents" | "favorites" | "search" = "documents";
  private viewMode: PageViewMode = "continuous";
  private selectedImageID: string | null = null;
  private imageDrag: { pointerID: number; pageID: string; imageID: string; startX: number; startY: number; originX: number; originY: number } | null = null;
  private imageResize: { pointerID: number; pageID: string; imageID: string; startX: number; startWidth: number; ratio: number } | null = null;
  private flowPreviewObserver: IntersectionObserver | null = null;
  private flowScrollFrame: number | null = null;
  private flowPointer: {
    pageID: string;
    pointerID: number;
    sourceLeft: number;
    sourceTop: number;
    sourceWidth: number;
    sourceHeight: number;
  } | null = null;
  private pendingFlowPointer: {
    pageID: string;
    pointerID: number;
    sourceLeft: number;
    sourceTop: number;
    sourceWidth: number;
    sourceHeight: number;
    start: PointerEvent;
    moves: PointerEvent[];
    end: PointerEvent | null;
    activation: Promise<void>;
  } | null = null;
  private readonly forwardedFlowEvents = new WeakSet<Event>();
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
    this.restoreViewMode();
    const canvas = byId<HTMLCanvasElement>("ink-canvas");
    this.canvas = new PaperCanvas(canvas, byId("paper"), byId("paper-viewport"), {
      onChange: (strokes) => this.handleCanvasChange(strokes),
      onZoom: (scale) => {
        byId("zoom-label").textContent = `${Math.round(scale * 100)}%`;
        this.updateActiveFlowHeight(scale);
      },
    });
    this.bindEvents();
    this.restoreToolSettings();
    this.selectTool(this.selectedTool);
    byId<HTMLInputElement>("endpoint-input").value = getEndpoint();
    this.renderWorkspaceRecovery();
    this.setOfflineCacheStatus(this.offlineCacheStatus, this.offlineCacheMessage);
    this.syncDrawerState();
    this.applyViewMode();
  }

  private viewModeStorageKey(): string { return `notepad.page-view:${this.accountKey()}`; }

  private restoreViewMode(): void {
    try {
      const saved = localStorage.getItem(this.viewModeStorageKey());
      if (saved === "continuous" || saved === "horizontal" || saved === "paged") this.viewMode = saved;
    } catch { /* Optional device preference. */ }
  }

  private setViewMode(mode: PageViewMode): void {
    if (mode !== "continuous" && mode !== "horizontal" && mode !== "paged") return;
    this.viewMode = mode;
    try { localStorage.setItem(this.viewModeStorageKey(), mode); } catch { /* Optional device preference. */ }
    this.applyViewMode();
    this.renderEditor();
  }

  private applyViewMode(): void {
    const selector = document.getElementById("page-view-mode") as HTMLSelectElement | null;
    if (selector) selector.value = this.viewMode;
    const viewport = document.getElementById("paper-scroll");
    const flow = document.getElementById("page-flow");
    if (!viewport || !flow) return;
    (this.canvas as PaperCanvas & { setNavigationMode?: (mode: PageViewMode, scrollViewport?: HTMLElement) => void } | null)?.setNavigationMode?.(this.viewMode, viewport);
    viewport.dataset.viewMode = this.viewMode;
    flow.dataset.viewMode = this.viewMode;
    viewport.classList.toggle("is-page-scroll", this.viewMode !== "paged");
    viewport.classList.toggle("is-horizontal-scroll", this.viewMode === "horizontal");
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
      this.showRecovery = false;
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
    onClick("recovery-toggle", () => { void this.toggleRecovery(); });
    onClick("mobile-menu", () => { void this.toggleDrawer("sidebar"); });
    onClick("close-sidebar", () => { void this.closeDrawers(); });
    onClick("drawer-backdrop", () => { void this.closeDrawers(); });
    onClick("text-toggle", () => { void this.toggleTextDrawer(); });
    onClick("close-inspector", () => { void this.closeDrawers(); });
    onClick("rename-notebook", () => this.openNotebookRename());
    onClick("rename-page", () => { void this.openTextDrawer(true); });
    onClick("notebook-menu", () => this.toggleQuickMenu("notebook-menu-popup"));
    onClick("page-menu", () => this.toggleQuickMenu("page-menu-popup"));
    onClick("insert-image", () => byId<HTMLInputElement>("image-input").click());
    onClick("paste-image", () => { void this.pasteImageFromClipboard(); });
    onClick("remove-image", () => { void this.removeSelectedImage(); });
    onClick("image-left", () => this.nudgeSelectedImage(-12, 0));
    onClick("image-right", () => this.nudgeSelectedImage(12, 0));
    onClick("image-up", () => this.nudgeSelectedImage(0, -12));
    onClick("image-down", () => this.nudgeSelectedImage(0, 12));
    byId<HTMLInputElement>("image-width").addEventListener("input", (event) => {
      this.resizeSelectedImage(Number((event.target as HTMLInputElement).value));
    });
    byId<HTMLSelectElement>("page-view-mode").addEventListener("change", (event) => {
      this.setViewMode((event.target as HTMLSelectElement).value as PageViewMode);
    });
    onClick("sync-button", () => this.sync());
    onClick("library-sync-button", () => this.sync());
    onClick("settings-sync-button", () => this.sync());
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
    onClick("keep-page", () => { void this.keepCurrentPage(); });
    onClick("cancel-settings", () => this.closeDialog("settings-dialog"));
    onClick("cancel-notebook", () => this.closeDialog("notebook-dialog"));
    document.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const action = target?.closest<HTMLElement>("[data-action]");
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        void this.handleMenuAction(action.dataset.action ?? "", action.dataset.entity ?? action.dataset.notebook ?? action.dataset.page ?? "");
        this.closeQuickMenus();
        return;
      }
      if (!target?.closest(".quick-menu, [data-menu-button]")) this.closeQuickMenus();
    });
    onClick("browse-import", () => byId<HTMLInputElement>("import-input").click());
    onClick("settings-export", () => this.exportArchive());
    onClick("settings-share", () => this.shareArchive());
    onClick("reload-app", () => { void this.reloadApp(); });
    byId<HTMLInputElement>("import-input").addEventListener("change", (event) => this.importArchive(event));
    byId<HTMLInputElement>("image-input").addEventListener("change", (event) => { void this.importImageFile(event); });
    document.addEventListener("paste", this.handlePasteImage);
    document.addEventListener("pointermove", this.handleImagePointerMove, { passive: false });
    document.addEventListener("pointerup", this.handleImagePointerUp, { passive: false });
    document.addEventListener("pointercancel", this.handleImagePointerUp, { passive: false });
    window.addEventListener("blur", this.handleImagePointerUp);
    document.addEventListener("pointermove", this.handleFlowPointerMove, { passive: false });
    document.addEventListener("pointerup", this.handleFlowPointerUp, { passive: false });
    document.addEventListener("pointercancel", this.handleFlowPointerUp, { passive: false });
    byId("paper-scroll").addEventListener("scroll", this.handleFlowScroll, { passive: true });
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
    const recoveryAtStart = this.showRecovery;
    const store = this.store;
    const accountAtStart = this.accountKey();
    const navigationAtStart = this.navigationGeneration;
    const editGenerationAtStart = this.editGeneration;
    const isSafe = (): boolean => store === this.store && accountAtStart === this.accountKey() && navigationAtStart === this.navigationGeneration && editGenerationAtStart === this.editGeneration && this.unsavedPageID === null && this.saveTimer === null && this.saveInFlight === null && !this.canvasInputActive() && searchAtStart === this.search && trashAtStart === this.showTrash && recoveryAtStart === this.showRecovery && (!guard || (guard.store === this.store && guard.generation === this.editGeneration));
    if (!isSafe()) return false;
    const includeDeleted = trashAtStart || recoveryAtStart;
    const notebooks = await store.listNotebooks(includeDeleted);
    if (!isSafe()) return false;
    const selection = this.readSelection();
    const preferredNotebookID = this.currentNotebook?.id ?? selection.notebookID;
    const notebookID = preferredNotebookID && notebooks.some((item) => item.id === preferredNotebookID)
      ? preferredNotebookID : notebooks[0]?.id;
    const currentNotebook = notebookID ? await store.getNotebook(notebookID) : null;
    if (!isSafe()) return false;
    const currentPages = currentNotebook ? await store.listPages(currentNotebook.id, includeDeleted) : [];
    if (!isSafe()) return false;
    const allPages = (await Promise.all(notebooks.map((notebook) => store.listPages(notebook.id, includeDeleted)))).flat();
    if (!isSafe()) return false;
    const preferredPageID = selectID ?? this.currentPage?.id ?? selection.pageID;
    let currentPage = preferredPageID ? await store.getPage(preferredPageID) : null;
    if (!isSafe()) return false;
    const visiblePages = searchAtStart || recoveryAtStart
      ? allPages.filter((page) => this.isPageVisible(page, notebooks))
      : trashAtStart ? allPages.filter((page) => this.isPageInTrash(page, notebooks)) : currentPages.filter((page) => this.isPageVisible(page, notebooks));
    if (!currentPage || !visiblePages.some((item) => item.id === currentPage?.id)) currentPage = visiblePages[0] ?? null;
    let finalNotebook = currentNotebook;
    let finalPages = currentPages;
    if (currentPage && currentPage.notebookId !== currentNotebook?.id) {
      finalNotebook = await store.getNotebook(currentPage.notebookId);
      if (!isSafe()) return false;
      finalPages = finalNotebook ? await store.listPages(finalNotebook.id, includeDeleted) : [];
    }
    if (!isSafe()) return false;
    this.notebooks = notebooks;
    this.currentNotebook = finalNotebook;
    this.pages = finalPages;
    this.allPages = allPages;
    this.currentPage = currentPage;
    this.renderLists();
    this.renderEditor();
    if (selectID) this.scrollActiveFlowPageIntoView();
    this.rememberSelection();
    return true;
  }

  private async toggleTrash(): Promise<void> {
    const navigation = ++this.navigationGeneration;
    if (!(await this.flushPendingSave())) return;
    if (navigation !== this.navigationGeneration) return;
    this.showTrash = !this.showTrash;
    this.showRecovery = false;
    await this.reload();
  }

  private async toggleRecovery(): Promise<void> {
    const navigation = ++this.navigationGeneration;
    if (!(await this.flushPendingSave())) return;
    if (navigation !== this.navigationGeneration) return;
    this.showRecovery = !this.showRecovery;
    this.showTrash = false;
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

  private async reloadApp(): Promise<void> {
    if (this.canvasInputActive()) {
      byId("settings-message").textContent = "Finish the current stroke before reloading.";
      return;
    }
    if (!(await this.flushPendingSave())) return;
    location.reload();
  }

  private toggleQuickMenu(id: string): void {
    const menu = byId(id);
    this.toggleQuickMenuElement(menu);
  }

  private toggleQuickMenuElement(menu: HTMLElement): void {
    const open = menu.hidden;
    this.closeQuickMenus();
    menu.hidden = !open;
    if (open) menu.querySelector<HTMLElement>("button")?.focus();
  }

  private closeQuickMenus(): void {
    document.querySelectorAll<HTMLElement>(".quick-menu").forEach((menu) => { menu.hidden = true; });
  }

  private async handleMenuAction(action: string, entityID: string): Promise<void> {
    if (!entityID) return;
    switch (action) {
      case "rename-notebook":
        await this.selectNotebookForAction(entityID);
        this.openNotebookRename();
        break;
      case "duplicate-notebook":
        await this.duplicateNotebook(entityID);
        break;
      case "trash-notebook":
        await this.setNotebookDeleted(entityID, false);
        break;
      case "restore-notebook":
        await this.setNotebookDeleted(entityID, true);
        break;
      case "rename-page":
        await this.selectPageForAction(entityID);
        await this.openTextDrawer(true);
        break;
      case "duplicate-page":
        await this.duplicatePage(entityID);
        break;
      case "trash-page":
        await this.setPageDeleted(entityID, false);
        break;
      case "restore-page":
        await this.setPageDeleted(entityID, true);
        break;
    }
  }

  private async selectNotebookForAction(id: string): Promise<void> {
    if (id === this.currentNotebook?.id) return;
    await this.selectNotebook(id);
  }

  private async selectPageForAction(id: string): Promise<void> {
    if (id === this.currentPage?.id) return;
    await this.selectPage(id);
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
    if ((!create && !this.currentNotebook) || this.showTrash || this.showRecovery) return;
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
    if (this.showTrash || this.showRecovery) {
      this.showTrash = false;
      this.showRecovery = false;
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
      if (page.deletedAt || page.conflictOf) continue;
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
      return `<article class="library-book"><button class="book-open" data-open-book="${book.id}" aria-label="Open notebook ${escapeAttr(book.title)}"><span class="book-cover cover-${shade}"><span class="cover-label"><small>NOTEBOOK</small><strong>${escapeHTML(book.title)}</strong><span>NotePad</span></span></span><span class="book-caption"><strong>${escapeHTML(book.title)}</strong><small>${pages.length} page${pages.length === 1 ? "" : "s"} · ${Number.isFinite(date.getTime()) ? escapeHTML(date.toLocaleDateString(undefined, { month: "short", day: "numeric" })) : ""}</small></span></button><button class="book-star" data-favorite="${book.id}" aria-label="Favorite ${escapeAttr(book.title)}" aria-pressed="${starred}">${starred ? "★" : "☆"}</button><button class="book-menu-button" data-menu-button aria-label="More actions for ${escapeAttr(book.title)}">⋯</button><div class="quick-menu book-quick-menu" hidden><button data-action="rename-notebook" data-entity="${escapeAttr(book.id)}">Rename</button><button data-action="duplicate-notebook" data-entity="${escapeAttr(book.id)}">Duplicate</button><button data-action="trash-notebook" data-entity="${escapeAttr(book.id)}">Move to trash</button></div></article>`;
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
    byId("library-books").querySelectorAll<HTMLButtonElement>("[data-menu-button]").forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = button.parentElement?.querySelector<HTMLElement>(".quick-menu");
      if (menu) this.toggleQuickMenuElement(menu);
    }));
  }

  private renderLists(): void {
    this.renderLibrary();
    const notebookList = byId("notebook-list");
    const notebooks = this.notebooks.filter((notebook) => this.showTrash || !notebook.deletedAt || (this.showRecovery && notebook.id === this.currentNotebook?.id))
      .filter((notebook) => !this.search || notebook.title.toLocaleLowerCase().includes(this.search));
    notebookList.innerHTML = notebooks.length ? notebooks.map((notebook) => {
      const deleted = Boolean(notebook.deletedAt);
      return `<div class="nav-row-wrap"><button class="nav-row ${notebook.id === this.currentNotebook?.id ? "selected" : ""}" data-notebook="${escapeAttr(notebook.id)}" aria-current="${notebook.id === this.currentNotebook?.id ? "page" : "false"}">
        <span class="nav-glyph">${deleted ? "◌" : "▱"}</span><span class="nav-copy"><strong>${escapeHTML(notebook.title)}</strong><small>${notebook.id === this.currentNotebook?.id ? `${this.pagesForNotebook(notebook.id)} pages` : "Notebook"}</small></span>
      </button><button class="nav-menu-button" data-menu-button aria-label="More actions for ${escapeAttr(notebook.title)}">⋯</button><div class="quick-menu" hidden>
        ${deleted ? `<button data-action="restore-notebook" data-entity="${escapeAttr(notebook.id)}">Restore notebook</button>` : `<button data-action="rename-notebook" data-entity="${escapeAttr(notebook.id)}">Rename</button><button data-action="duplicate-notebook" data-entity="${escapeAttr(notebook.id)}">Duplicate</button><button data-action="trash-notebook" data-entity="${escapeAttr(notebook.id)}">Move to trash</button>`}
      </div></div>`;
    }).join("") : `<p class="empty-copy">${this.showTrash ? "Trash is empty." : "Create a notebook to begin."}</p>`;
    notebookList.querySelectorAll<HTMLButtonElement>("[data-notebook]:not([data-action])").forEach((button) => button.addEventListener("click", () => void this.selectNotebook(button.dataset.notebook!)));
    notebookList.querySelectorAll<HTMLButtonElement>("[data-menu-button]").forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = button.parentElement?.querySelector<HTMLElement>(".quick-menu");
      if (menu) this.toggleQuickMenuElement(menu);
    }));

    const pageList = byId("page-list");
    const sourcePages = this.showTrash || this.showRecovery || this.search ? this.allPages : this.pages;
    const pages = sourcePages.filter((page) => this.isPageVisible(page))
      .filter((page) => !this.search || `${page.title} ${page.text}`.toLocaleLowerCase().includes(this.search));
    pageList.innerHTML = pages.length ? pages.map((page) => {
      const deleted = this.isPageInTrash(page);
      return `<div class="nav-row-wrap"><button class="page-row ${page.id === this.currentPage?.id ? "selected" : ""}" data-page="${escapeAttr(page.id)}" aria-current="${page.id === this.currentPage?.id ? "page" : "false"}">
        <span class="page-index">${pages.indexOf(page) + 1}</span><span class="page-copy"><strong>${escapeHTML(page.title || "Untitled page")}</strong><small>${pageNotebookLabel(page, this.notebooks)}${page.text.trim() ? ` · ${escapeHTML(preview(page.text))}` : ` · ${page.strokes.length} strokes`}</small></span>
      </button><button class="nav-menu-button" data-menu-button aria-label="More actions for ${escapeAttr(page.title || "Untitled page")}">⋯</button><div class="quick-menu" hidden>
        ${deleted ? `<button data-action="restore-page" data-entity="${escapeAttr(page.id)}">Restore page</button>` : `<button data-action="rename-page" data-entity="${escapeAttr(page.id)}">Rename</button><button data-action="duplicate-page" data-entity="${escapeAttr(page.id)}">Duplicate</button><button data-action="trash-page" data-entity="${escapeAttr(page.id)}">Move to trash</button>`}
      </div></div>`;
    }).join("") : `<p class="empty-copy">${this.showTrash ? "No deleted pages." : this.showRecovery ? "No recovered copies yet." : "No pages yet."}</p>`;
    pageList.querySelectorAll<HTMLButtonElement>("[data-page]:not([data-action])").forEach((button) => button.addEventListener("click", () => void this.selectPage(button.dataset.page!)));
    pageList.querySelectorAll<HTMLButtonElement>("[data-menu-button]").forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = button.parentElement?.querySelector<HTMLElement>(".quick-menu");
      if (menu) this.toggleQuickMenuElement(menu);
    }));
    byId("trash-toggle").classList.toggle("active", this.showTrash);
    byId("trash-toggle").setAttribute("aria-pressed", String(this.showTrash));
    byId("trash-label").textContent = this.showTrash ? "Back to notebook" : "Trash";
    const recoveryToggle = byId<HTMLButtonElement>("recovery-toggle");
    const recoveryCount = this.recoveryPageCount();
    recoveryToggle.classList.toggle("active", this.showRecovery);
    recoveryToggle.setAttribute("aria-pressed", String(this.showRecovery));
    recoveryToggle.setAttribute("aria-label", `${this.showRecovery ? "Show notebook pages" : "Show recovered copies"}${recoveryCount ? ` · ${recoveryCount}` : ""}`);
    byId("recovery-label").textContent = "Recovered copies";
    const recoveryCountElement = byId("recovery-count");
    recoveryCountElement.textContent = String(recoveryCount);
    recoveryCountElement.toggleAttribute("hidden", recoveryCount === 0);
    byId("new-page").toggleAttribute("disabled", this.showTrash || this.showRecovery || !this.currentNotebook);
    byId("new-notebook").toggleAttribute("disabled", this.showTrash || this.showRecovery);
  }

  private pagesForNotebook(notebookID: string): number {
    return this.pages.filter((page) => page.notebookId === notebookID && this.isPageVisible(page)).length;
  }

  private recoveryPageCount(): number {
    return this.allPages.filter((page) => this.isRecoveryPage(page)).length;
  }

  private isRecoveryPage(page: NotePage, notebooks = this.notebooks): boolean {
    if (page.deletedAt || !page.conflictOf) return false;
    return !notebooks.find((notebook) => notebook.id === page.notebookId)?.deletedAt;
  }

  private isPageVisible(page: NotePage, notebooks = this.notebooks): boolean {
    if (this.showTrash) return this.isPageInTrash(page, notebooks);
    if (page.deletedAt) return false;
    return this.showRecovery ? this.isRecoveryPage(page, notebooks) : !page.conflictOf;
  }

  private editorPages(): NotePage[] {
    return this.pages.filter((page) => this.isPageVisible(page));
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
    document.body.classList.toggle("recovery-mode", this.showRecovery);
    byId("editor-empty").classList.toggle("hidden", hasPage);
    byId("editor-content").classList.toggle("hidden", !hasPage);
    byId("editor-empty-title").textContent = this.showRecovery ? "No recovered copies" : "Choose a page";
    byId("editor-empty-copy").textContent = this.showRecovery ? "Recovered copies will appear here after a sync conflict." : "Your paper is waiting in the left rail.";
    byId("notebook-name").textContent = this.currentNotebook?.title ?? "No notebook";
    const notebookMenu = byId<HTMLElement>("notebook-menu-popup");
    notebookMenu.querySelectorAll<HTMLElement>("[data-notebook]").forEach((button) => { button.dataset.notebook = this.currentNotebook?.id ?? ""; });
    const notebookMenuTrash = notebookMenu.querySelector<HTMLElement>("[data-action='trash-notebook']");
    if (notebookMenuTrash) notebookMenuTrash.textContent = this.currentNotebook?.deletedAt ? "Restore notebook" : "Move notebook to trash";
    if (this.currentNotebook?.deletedAt) {
      notebookMenu.innerHTML = `<button data-action="restore-notebook" data-entity="${escapeAttr(this.currentNotebook.id)}">Restore notebook</button>`;
    } else if (this.currentNotebook) {
      notebookMenu.innerHTML = `<button data-action="rename-notebook" data-entity="${escapeAttr(this.currentNotebook.id)}">Rename notebook</button><button data-action="duplicate-notebook" data-entity="${escapeAttr(this.currentNotebook.id)}">Duplicate notebook</button><button data-action="trash-notebook" data-entity="${escapeAttr(this.currentNotebook.id)}">Move notebook to trash</button>`;
    }
    byId<HTMLButtonElement>("notebook-menu").disabled = !this.currentNotebook;
    const pageMenu = byId<HTMLElement>("page-menu-popup");
    if (page) {
      pageMenu.innerHTML = this.showTrash
        ? `<button data-action="restore-page" data-entity="${escapeAttr(page.id)}">Restore page</button>`
        : `<button data-action="rename-page" data-entity="${escapeAttr(page.id)}">Rename page</button><button data-action="duplicate-page" data-entity="${escapeAttr(page.id)}">Duplicate page</button><button data-action="trash-page" data-entity="${escapeAttr(page.id)}">Move page to trash</button>`;
    } else pageMenu.replaceChildren();
    byId<HTMLButtonElement>("page-menu").disabled = !page;
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
    const keepPage = byId<HTMLButtonElement>("keep-page");
    keepPage.hidden = !page?.conflictOf || this.showTrash;
    keepPage.disabled = !page?.conflictOf || this.showTrash;
    byId("recovery-page-badge").toggleAttribute("hidden", !page?.conflictOf);
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
    this.canvas?.setPage(page.id, page.width, page.height, page.background, page.strokes, getPageImages(page));
    this.renderImageLayer(page);
    this.renderImageInspector(page);
    this.applyViewMode();
    this.renderPageFlow();
    this.updateToolbar();
  }

  /** Keep every page slot in order while rendering neighbours as bounded previews. */
  private renderPageFlow(): void {
    const flow = document.getElementById("page-flow");
    const activeSlot = document.getElementById("active-page-slot");
    if (!flow || !activeSlot) return;
    this.flowPreviewObserver?.disconnect();
    this.flowPreviewObserver = null;
    const pages = this.editorPages();
    const current = this.currentPage;
    if (!current) {
      flow.replaceChildren(activeSlot);
      activeSlot.dataset.flowPage = "";
      return;
    }
    activeSlot.dataset.flowPage = current.id;
    activeSlot.className = "flow-page active";
    activeSlot.setAttribute("aria-label", current.title || "Current page");
    if (this.viewMode === "paged") {
      flow.replaceChildren(activeSlot);
      activeSlot.style.height = "";
      return;
    }
    const slots = pages.map((page) => {
      if (page.id === current.id) return activeSlot;
      const slot = document.createElement("article");
      slot.className = "flow-page flow-preview";
      slot.dataset.flowPage = page.id;
      slot.tabIndex = 0;
      slot.setAttribute("aria-label", `Open ${page.title || "Untitled page"}`);
      const header = document.createElement("header");
      header.innerHTML = `<span>${escapeHTML(page.title || "Untitled page")}</span><small>${page.text.trim() ? escapeHTML(previewText(page.text)) : `${page.strokes.length} strokes`}</small>`;
      const canvas = document.createElement("canvas");
      canvas.className = "flow-preview-canvas";
      canvas.width = 1;
      canvas.height = 1;
      canvas.style.aspectRatio = `${Math.max(1, page.width)} / ${Math.max(1, page.height)}`;
      canvas.style.height = `${Math.max(1, Math.round(Math.min(360, page.width) * page.height / Math.max(1, page.width)))}px`;
      canvas.setAttribute("aria-label", `${page.title || "Untitled page"} preview`);
      slot.append(header, canvas);
      const renderPreview = (): void => {
        if (canvas.width > 1) return;
        const width = Math.max(1, Math.round(Math.min(360, page.width)));
        canvas.width = width;
        canvas.height = Math.max(1, Math.round(width * page.height / Math.max(1, page.width)));
        canvas.style.height = "auto";
        if (typeof navigator === "undefined" || !/jsdom/i.test(navigator.userAgent)) {
          renderPagePreview(canvas, { width: page.width, height: page.height, background: page.background, strokes: page.strokes, images: getPageImages(page) }, 320);
        }
      };
      if (typeof IntersectionObserver === "undefined") renderPreview();
      else {
        this.flowPreviewObserver ??= new IntersectionObserver((entries) => {
          for (const entry of entries) if (entry.isIntersecting) (entry.target as HTMLCanvasElement).dispatchEvent(new Event("preview-visible"));
        }, { root: document.getElementById("paper-scroll"), rootMargin: "500px" });
        canvas.addEventListener("preview-visible", renderPreview, { once: true });
        this.flowPreviewObserver.observe(canvas);
      }
      // The page header remains a navigation target. Only the actual raster preview
      // can start a pen/mouse stroke, so a finger can still scroll the page stack.
      canvas.addEventListener("pointerdown", (event) => this.beginFlowPointer(page.id, event, canvas));
      slot.addEventListener("click", () => { void this.selectPage(page.id); });
      slot.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void this.selectPage(page.id); } });
      return slot;
    });
    const addPage = document.createElement("button");
    addPage.className = "flow-add-page";
    addPage.type = "button";
    addPage.textContent = "＋ Add page";
    addPage.setAttribute("aria-label", "Add page at end");
    addPage.disabled = this.showTrash || this.showRecovery;
    addPage.addEventListener("click", () => { void this.createNewPage(); });
    flow.replaceChildren(...slots, addPage);
    this.updateActiveFlowHeight();
  }

  private updateActiveFlowHeight(scale = this.canvas?.currentScale): void {
    if (this.viewMode === "paged" || !this.currentPage) return;
    const slot = document.getElementById("active-page-slot");
    const scroll = document.getElementById("paper-scroll");
    if (!slot || !scroll) return;
    const measuredWidth = slot.getBoundingClientRect().width || slot.clientWidth;
    const fallbackWidth = this.viewMode === "horizontal"
      ? Math.min(Math.max(240, window.innerWidth - 60), 900)
      : Math.max(240, scroll.clientWidth - 40);
    const fitWidth = Math.max(1, (measuredWidth || fallbackWidth) - (measuredWidth ? 0 : 0));
    const fitScale = clampNumber(fitWidth / Math.max(1, this.currentPage.width), .25, 1.4);
    const effectiveScale = Math.max(fitScale, Number.isFinite(scale) ? (scale as number) : fitScale);
    slot.style.height = `${Math.ceil(this.currentPage.height * effectiveScale + 56)}px`;
  }

  private readonly handleFlowScroll = (): void => {
    if (this.viewMode === "paged" || this.flowScrollFrame !== null) return;
    const requestFrame: (callback: FrameRequestCallback) => number = typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame.bind(window) : ((callback) => window.setTimeout(() => callback(performance.now()), 0));
    this.flowScrollFrame = requestFrame(() => {
      this.flowScrollFrame = null;
      const scroll = document.getElementById("paper-scroll");
      if (!scroll || this.canvasInputActive() || this.saveTimer !== null || this.saveInFlight !== null || this.unsavedPageID !== null) return;
      const rect = scroll.getBoundingClientRect();
      const center = this.viewMode === "horizontal" ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
      let nearest: { id: string; distance: number } | null = null;
      for (const slot of document.querySelectorAll<HTMLElement>("#page-flow > .flow-page[data-flow-page]")) {
        if (!slot.dataset.flowPage) continue;
        const slotRect = slot.getBoundingClientRect();
        const slotCenter = this.viewMode === "horizontal" ? slotRect.left + slotRect.width / 2 : slotRect.top + slotRect.height / 2;
        const distance = Math.abs(slotCenter - center);
        if (!nearest || distance < nearest.distance) nearest = { id: slot.dataset.flowPage, distance };
      }
      if (nearest && nearest.id !== this.currentPage?.id && nearest.distance < (this.viewMode === "horizontal" ? rect.width : rect.height) * .72) this.activateFlowPage(nearest.id);
    });
  };

  private activateFlowPage(pageID: string): void {
    if (pageID === this.currentPage?.id || this.canvasInputActive()) return;
    const page = this.pages.find((candidate) => candidate.id === pageID && this.isPageVisible(candidate));
    if (!page) return;
    if (this.saveTimer !== null || this.saveInFlight !== null || this.unsavedPageID !== null) {
      void this.selectPage(pageID);
      return;
    }
    this.navigationGeneration += 1;
    this.editGeneration += 1;
    this.currentPage = page;
    this.selectedImageID = null;
    this.renderLists();
    this.renderEditor();
    this.rememberSelection();
  }

  private beginFlowPointer(pageID: string, event: PointerEvent, preview: HTMLCanvasElement): void {
    // Touch belongs to the outer page scroller. Pen and primary mouse input are
    // the only pointer types that should be forwarded into the active canvas.
    if (event.pointerType === "touch") return;
    if (this.showTrash || pageID === this.currentPage?.id || this.selectedTool === "hand" || (event.pointerType !== "pen" && event.button !== 0)) {
      if (pageID !== this.currentPage?.id) this.activateFlowPage(pageID);
      return;
    }
    const page = this.pages.find((candidate) => candidate.id === pageID && this.isPageVisible(candidate));
    if (!page || this.canvasInputActive()) return;
    event.preventDefault();
    event.stopPropagation();
    const source = preview.getBoundingClientRect();
    const mapping = {
      pageID,
      pointerID: event.pointerId,
      sourceLeft: source.left,
      sourceTop: source.top,
      sourceWidth: Math.max(1, source.width),
      sourceHeight: Math.max(1, source.height),
    };
    if (this.saveTimer !== null || this.saveInFlight !== null || this.unsavedPageID !== null) {
      // Selection waits for the current page save. Keep every sample arriving
      // during that await and replay it against the same preview coordinates.
      const pending: typeof this.pendingFlowPointer = {
        ...mapping,
        start: event,
        moves: [],
        end: null,
        activation: Promise.resolve(),
      };
      this.pendingFlowPointer = pending;
      pending.activation = this.selectPage(pageID).then(() => this.replayPendingFlowPointer(pending));
      return;
    }
    this.activateFlowPage(pageID);
    this.startFlowPointer(mapping, event);
  }

  private startFlowPointer(mapping: Omit<NonNullable<NotePadApp["flowPointer"]>, never>, start: PointerEvent, moves: PointerEvent[] = [], end: PointerEvent | null = null): void {
    if (this.currentPage?.id !== mapping.pageID) return;
    this.flowPointer = mapping;
    this.dispatchMappedFlowPointer("pointerdown", start, mapping);
    for (const move of moves) this.dispatchMappedFlowPointer("pointermove", move, mapping);
    if (end) {
      this.flowPointer = null;
      this.dispatchMappedFlowPointer(end.type === "pointercancel" ? "pointercancel" : "pointerup", end, mapping);
    }
  }

  private async replayPendingFlowPointer(pending: NonNullable<NotePadApp["pendingFlowPointer"]>): Promise<void> {
    if (this.pendingFlowPointer !== pending) return;
    this.pendingFlowPointer = null;
    if (this.currentPage?.id !== pending.pageID) return;
    this.startFlowPointer(pending, pending.start, pending.moves, pending.end);
  }

  private dispatchMappedFlowPointer(type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", source: PointerEvent, mapping: NonNullable<NotePadApp["flowPointer"]>): void {
    const canvas = byId<HTMLCanvasElement>("ink-canvas");
    const target = canvas.getBoundingClientRect();
    const ratioX = clampNumber((source.clientX - mapping.sourceLeft) / mapping.sourceWidth, 0, 1);
    const ratioY = clampNumber((source.clientY - mapping.sourceTop) / mapping.sourceHeight, 0, 1);
    this.dispatchFlowPointer(type, source, target.left + ratioX * target.width, target.top + ratioY * target.height);
  }

  private dispatchFlowPointer(type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", source: PointerEvent, clientX: number, clientY: number): void {
    const canvas = document.getElementById("ink-canvas");
    if (!(canvas instanceof HTMLCanvasElement) || typeof PointerEvent === "undefined") return;
    const forwarded = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: source.pointerId,
      pointerType: source.pointerType,
      isPrimary: source.isPrimary,
      button: source.button,
      buttons: source.buttons,
      clientX,
      clientY,
      pressure: source.pressure,
      tiltX: source.tiltX,
      tiltY: source.tiltY,
    });
    // The document listeners also see bubbling synthetic events. Mark them so
    // they terminate at the active canvas instead of being forwarded forever.
    this.forwardedFlowEvents.add(forwarded);
    canvas.dispatchEvent(forwarded);
  }

  private readonly handleFlowPointerMove = (event: PointerEvent): void => {
    if (this.forwardedFlowEvents.has(event)) {
      this.forwardedFlowEvents.delete(event);
      return;
    }
    const canvas = document.getElementById("ink-canvas");
    if (event.target === canvas) return;
    if (this.pendingFlowPointer?.pointerID === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      this.pendingFlowPointer.moves.push(event);
      return;
    }
    if (!this.flowPointer || this.flowPointer.pointerID !== event.pointerId) return;
    event.preventDefault();
    this.dispatchMappedFlowPointer("pointermove", event, this.flowPointer);
  };

  private readonly handleFlowPointerUp = (event: PointerEvent): void => {
    if (this.forwardedFlowEvents.has(event)) {
      this.forwardedFlowEvents.delete(event);
      return;
    }
    const canvas = document.getElementById("ink-canvas");
    if (event.target === canvas) {
      // Pointer capture retargets the native terminal event to the canvas. It
      // has already committed there, so only release the forwarding marker.
      if (this.flowPointer?.pointerID === event.pointerId) this.flowPointer = null;
      return;
    }
    if (this.pendingFlowPointer?.pointerID === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      this.pendingFlowPointer.end = event;
      return;
    }
    if (!this.flowPointer || this.flowPointer.pointerID !== event.pointerId) return;
    event.preventDefault();
    const mapping = this.flowPointer;
    // Clear before dispatching: the synthetic event bubbles through this same
    // document listener and must not see an active forwarding session.
    this.flowPointer = null;
    this.dispatchMappedFlowPointer(event.type === "pointercancel" ? "pointercancel" : "pointerup", event, mapping);
  };

  private renderImageLayer(page: NotePage): void {
    const layer = byId("paper-image-layer");
    layer.replaceChildren();
    for (const image of getPageImages(page)) {
      const object = document.createElement("div");
      object.className = `paper-image-object${this.selectedImageID === image.id ? " selected" : ""}`;
      object.dataset.imageId = image.id;
      object.style.left = `${image.x}px`;
      object.style.top = `${image.y}px`;
      object.style.width = `${image.width}px`;
      object.style.height = `${image.height}px`;
      object.style.pointerEvents = this.selectedTool === "hand" && !this.showTrash ? "auto" : "none";
      object.setAttribute("role", "img");
      object.setAttribute("aria-label", "Inserted image");
      object.tabIndex = 0;
      if (this.selectedImageID === image.id && !this.showTrash) {
        const resize = document.createElement("button");
        resize.className = "image-resize-handle";
        resize.type = "button";
        resize.dataset.imageResize = image.id;
        resize.setAttribute("aria-label", "Resize image");
        object.append(resize);
      }
      object.addEventListener("pointerdown", (event) => {
        if (this.showTrash || this.selectedTool !== "hand") return;
        if (this.imageDrag || this.imageResize) return;
        const target = event.target as HTMLElement;
        if (target.closest("[data-image-resize]")) {
          event.preventDefault();
          event.stopPropagation();
          this.selectImage(image.id);
          this.imageResize = { pointerID: event.pointerId, pageID: page.id, imageID: image.id, startX: event.clientX, startWidth: image.width, ratio: image.height / Math.max(1, image.width) };
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.selectImage(image.id);
        this.imageDrag = { pointerID: event.pointerId, pageID: page.id, imageID: image.id, startX: event.clientX, startY: event.clientY, originX: image.x, originY: image.y };
      });
      object.addEventListener("keydown", (event) => {
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          this.selectedImageID = image.id;
          void this.removeSelectedImage();
        }
      });
      layer.append(object);
    }
    layer.toggleAttribute("hidden", getPageImages(page).length === 0);
  }

  private renderImageInspector(page: NotePage): void {
    const images = getPageImages(page);
    if (this.selectedImageID && !images.some((image) => image.id === this.selectedImageID)) this.selectedImageID = null;
    const list = byId("image-list");
    list.innerHTML = images.map((image, index) => `<div class="image-list-row ${image.id === this.selectedImageID ? "selected" : ""}"><button class="image-select" type="button" data-image-select="${escapeAttr(image.id)}"><span>${index + 1}</span><img src="${escapeAttr(image.src)}" alt="" /><strong>Image ${index + 1}</strong></button><button class="image-remove" type="button" data-image-remove="${escapeAttr(image.id)}" aria-label="Remove image ${index + 1}">×</button></div>`).join("");
    byId("image-empty").toggleAttribute("hidden", images.length > 0);
    list.querySelectorAll<HTMLButtonElement>("[data-image-select]").forEach((button) => button.addEventListener("click", () => this.selectImage(button.dataset.imageSelect!)));
    list.querySelectorAll<HTMLButtonElement>("[data-image-remove]").forEach((button) => button.addEventListener("click", () => { this.selectedImageID = button.dataset.imageRemove ?? null; void this.removeSelectedImage(); }));
    const selected = images.find((image) => image.id === this.selectedImageID);
    const controls = byId<HTMLElement>("image-controls");
    controls.hidden = !selected || this.showTrash;
    if (selected) {
      byId("selected-image-label").textContent = "Selected image";
      const width = byId<HTMLInputElement>("image-width");
      width.value = String(Math.round(selected.width));
      width.max = String(Math.max(48, Math.round(page.width)));
    }
    byId<HTMLButtonElement>("insert-image").disabled = !page || this.showTrash;
    byId<HTMLButtonElement>("paste-image").disabled = !page || this.showTrash;
  }

  private selectImage(imageID: string): void {
    this.selectedImageID = imageID;
    if (this.currentPage) {
      this.renderImageLayer(this.currentPage);
      this.renderImageInspector(this.currentPage);
    }
  }

  private resizeSelectedImage(width: number): void {
    const page = this.currentPage;
    if (!page || !Number.isFinite(width) || this.showTrash) return;
    const images = getPageImages(page);
    const image = images.find((candidate) => candidate.id === this.selectedImageID);
    if (!image) return;
    const ratio = image.height / Math.max(1, image.width);
    image.width = clampNumber(width, 48, page.width);
    image.height = Math.max(24, image.width * ratio);
    image.x = Math.min(Math.max(0, image.x), Math.max(0, page.width - image.width));
    image.y = Math.min(Math.max(0, image.y), Math.max(0, page.height - image.height));
    this.markImageChanged(page);
    this.updateImageElement(image);
    this.scheduleSave(180);
  }

  private nudgeSelectedImage(dx: number, dy: number): void {
    const page = this.currentPage;
    if (!page || !this.selectedImageID || this.showTrash) return;
    const image = getPageImages(page).find((candidate) => candidate.id === this.selectedImageID);
    if (!image) return;
    image.x = clampNumber(image.x + dx, 0, Math.max(0, page.width - image.width));
    image.y = clampNumber(image.y + dy, 0, Math.max(0, page.height - image.height));
    this.markImageChanged(page);
    this.updateImageElement(image);
    this.scheduleSave(180);
  }

  private updateImageElement(image: PageImage): void {
    const object = document.querySelector<HTMLElement>(`[data-image-id="${CSS.escape(image.id)}"]`);
    if (!object) return;
    object.style.left = `${image.x}px`;
    object.style.top = `${image.y}px`;
    object.style.width = `${image.width}px`;
    object.style.height = `${image.height}px`;
  }

  private async removeSelectedImage(): Promise<void> {
    const page = this.currentPage;
    if (!page || !this.selectedImageID || this.showTrash) return;
    const images = getPageImages(page);
    const next = images.filter((image) => image.id !== this.selectedImageID);
    if (next.length === images.length) return;
    setPageImages(page, next);
    this.selectedImageID = null;
    this.markImageChanged(page);
    this.renderImageLayer(page);
    this.renderImageInspector(page);
    this.scheduleSave(180);
  }

  private readonly handleImagePointerMove = (event: PointerEvent): void => {
    if (this.imageDrag && this.imageDrag.pointerID === event.pointerId) {
      const page = this.currentPage;
      if (!page || page.id !== this.imageDrag.pageID) return;
      const image = getPageImages(page).find((candidate) => candidate.id === this.imageDrag!.imageID);
      if (!image) return;
      event.preventDefault();
      const scale = Math.max(.1, this.canvas?.currentScale ?? 1);
      image.x = clampNumber(this.imageDrag.originX + (event.clientX - this.imageDrag.startX) / scale, 0, Math.max(0, page.width - image.width));
      image.y = clampNumber(this.imageDrag.originY + (event.clientY - this.imageDrag.startY) / scale, 0, Math.max(0, page.height - image.height));
      this.markImageChanged(page);
      this.updateImageElement(image);
      this.scheduleSave(180);
    } else if (this.imageResize && this.imageResize.pointerID === event.pointerId) {
      const page = this.currentPage;
      if (!page || page.id !== this.imageResize.pageID) return;
      const image = getPageImages(page).find((candidate) => candidate.id === this.imageResize!.imageID);
      if (!image) return;
      event.preventDefault();
      const scale = Math.max(.1, this.canvas?.currentScale ?? 1);
      const width = clampNumber(this.imageResize.startWidth + (event.clientX - this.imageResize.startX) / scale, 48, page.width);
      image.width = width;
      image.height = Math.max(24, width * this.imageResize.ratio);
      image.x = Math.min(image.x, Math.max(0, page.width - image.width));
      image.y = Math.min(image.y, Math.max(0, page.height - image.height));
      this.markImageChanged(page);
      this.updateImageElement(image);
      this.scheduleSave(180);
    }
  };

  private markImageChanged(page: NotePage): void {
    if (this.currentPage?.id !== page.id) return;
    this.editGeneration += 1;
    this.canvas?.setImages(getPageImages(page));
  }

  private readonly handleImagePointerUp = (event?: Event): void => {
    if (!(event instanceof PointerEvent)) {
      this.imageDrag = null;
      this.imageResize = null;
      return;
    }
    if (this.imageDrag?.pointerID === event.pointerId) this.imageDrag = null;
    if (this.imageResize?.pointerID === event.pointerId) this.imageResize = null;
  };

  private readonly handlePasteImage = (event: ClipboardEvent): void => {
    if (!this.canInsertImage() || isTextEntryTarget(event.target)) return;
    const item = [...(event.clipboardData?.items ?? [])].find((candidate) => candidate.type.startsWith("image/"));
    const file = item?.getAsFile();
    if (!file) return;
    const context = this.captureImageImportContext();
    if (!context) return;
    if (!SUPPORTED_IMAGE_TYPES.has(file.type.toLowerCase())) {
      event.preventDefault();
      this.setState({ kind: "error", message: "Unsupported image format. Use PNG, JPEG, WebP, or GIF." });
      return;
    }
    event.preventDefault();
    void this.addImageFile(file, context);
  };

  private async pasteImageFromClipboard(): Promise<void> {
    if (!this.canInsertImage()) return;
    const context = this.captureImageImportContext();
    if (!context) return;
    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.read !== "function") {
      this.setState({ kind: "error", message: "This browser cannot read clipboard images. Use keyboard paste or Insert image." });
      return;
    }
    try {
      const items = await clipboard.read();
      if (!this.imageImportContextIsCurrent(context)) return;
      const item = items.find((candidate) => candidate.types.some((type) => type.startsWith("image/")));
      const type = item?.types.find((candidate) => candidate.startsWith("image/"));
      if (!item || !type) {
        this.setState({ kind: "error", message: "No image is available in the clipboard. Copy a picture, then try again." });
        return;
      }
      if (!SUPPORTED_IMAGE_TYPES.has(type.toLowerCase())) {
        this.setState({ kind: "error", message: "That clipboard image format is unsupported. Use PNG, JPEG, WebP, or GIF." });
        return;
      }
      const blob = await item.getType(type);
      const extension = type.split("/")[1] || "png";
      if (!this.imageImportContextIsCurrent(context)) return;
      await this.addImageFile(new File([blob], `clipboard.${extension}`, { type }), context);
    } catch (error) {
      if (!this.imageImportContextIsCurrent(context)) return;
      this.setState({ kind: "error", message: error instanceof Error ? `Clipboard image unavailable: ${error.message}` : "Clipboard image unavailable. Use keyboard paste or Insert image." });
    }
  }

  private async importImageFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) await this.addImageFile(file);
  }

  private canInsertImage(): boolean {
    return Boolean(this.auth.session && !this.loginRequired && this.view === "editor" && this.currentPage && !this.showTrash && !this.showRecovery);
  }

  private captureImageImportContext(): ImageImportContext | null {
    if (!this.canInsertImage() || !this.currentPage) return null;
    return { page: this.currentPage, store: this.store, navigation: this.navigationGeneration, generation: this.editGeneration };
  }

  private imageImportContextIsCurrent(context: ImageImportContext): boolean {
    return this.canInsertImage() && context.store === this.store && context.page === this.currentPage && context.page.id === this.currentPage?.id && context.navigation === this.navigationGeneration && context.generation === this.editGeneration;
  }

  private async addImageFile(file: File, expected?: ImageImportContext): Promise<void> {
    const context = expected ?? this.captureImageImportContext();
    if (!context || !this.imageImportContextIsCurrent(context)) return;
    const { page, store, navigation, generation } = context;
    if (!SUPPORTED_IMAGE_TYPES.has(file.type.toLowerCase())) {
      this.setState({ kind: "error", message: "Unsupported image format. Use PNG, JPEG, WebP, or GIF." });
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      this.setState({ kind: "error", message: "That image is larger than 12 MB." });
      return;
    }
    try {
      if (!(await this.flushPendingSave())) return;
      if (!this.imageImportContextIsCurrent(context)) return;
      const image = await makePageImage(file, page, getPageImages(page).length);
      if (store !== this.store || navigation !== this.navigationGeneration || this.currentPage !== page || this.currentPage?.id !== page.id || this.editGeneration !== generation || !this.canInsertImage()) return;
      setPageImages(page, [...getPageImages(page), image]);
      this.selectedImageID = image.id;
      this.markImageChanged(page);
      this.renderImageLayer(page);
      this.renderImageInspector(page);
      this.scheduleSave(180);
    } catch (error) {
      this.setState({ kind: "error", message: error instanceof Error ? error.message : "Could not insert image" });
    }
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

  private async keepCurrentPage(): Promise<void> {
    const page = this.currentPage;
    if (this.showTrash || !page?.conflictOf) return;
    const store = this.store;
    const accountAtStart = this.accountKey();
    const navigation = this.navigationGeneration;
    const generation = this.editGeneration;
    const snapshot = clonePage(page);
    const isCurrent = (): boolean => store === this.store && accountAtStart === this.accountKey() && navigation === this.navigationGeneration && generation === this.editGeneration && this.currentPage?.id === snapshot.id;
    if (!(await this.flushPendingSave()) || !isCurrent()) return;
    try {
      const result = await store.savePage({ ...snapshot, conflictOf: undefined });
      if (!isCurrent()) return;
      if (result.status === "failed") {
        this.setState({ kind: "error", message: result.message ?? "Could not keep page" });
        return;
      }
      this.coordinator.notifyLocalWrite();
      this.showRecovery = false;
      await this.reload(page.id);
    } catch (error) {
      if (!isCurrent()) return;
      this.setState({ kind: "error", message: error instanceof Error ? error.message : "Could not keep page" });
    }
  }

  private updateToolbar(): void {
    const readOnly = this.showTrash || this.selectedTool === "hand";
    byId<HTMLButtonElement>("undo-button").disabled = readOnly || !this.canvas?.hasUndo;
    byId<HTMLButtonElement>("redo-button").disabled = readOnly || !this.canvas?.hasRedo;
    const pages = this.editorPages();
    const index = pages.findIndex((page) => page.id === this.currentPage?.id);
    byId("page-position").textContent = `${index >= 0 ? index + 1 : 0} / ${pages.length}`;
    byId<HTMLButtonElement>("previous-page").disabled = this.showTrash || index <= 0;
    byId<HTMLButtonElement>("next-page").disabled = this.showTrash || index < 0 || index >= pages.length - 1;
    byId<HTMLButtonElement>("add-page").disabled = this.showTrash || this.showRecovery || !this.currentNotebook;
    byId<HTMLButtonElement>("duplicate-page").disabled = this.showTrash || this.showRecovery || !this.currentPage;
  }

  private async turnPage(direction: number): Promise<void> {
    if (this.showTrash || this.canvas?.isInputActive) return;
    const pages = this.editorPages();
    const index = pages.findIndex((page) => page.id === this.currentPage?.id);
    const next = pages[index + direction];
    if (index >= 0 && next) await this.selectPage(next.id);
  }

  private async selectNotebook(id: string): Promise<void> {
    if (this.canvasInputActive()) return;
    const navigation = ++this.navigationGeneration;
    if (!(await this.flushPendingSave())) return;
    if (navigation !== this.navigationGeneration) return;
    if (this.view === "library") {
      this.showTrash = false;
      this.showRecovery = false;
    }
    const store = this.store;
    this.editGeneration += 1;
    const editGeneration = this.editGeneration;
    const canApply = (): boolean => navigation === this.navigationGeneration && store === this.store && editGeneration === this.editGeneration && this.unsavedPageID === null && this.saveTimer === null && this.saveInFlight === null && !this.canvasInputActive();
    const notebook = await store.getNotebook(id);
    if (!canApply()) return;
    const pages = notebook ? await store.listPages(notebook.id, this.showTrash || this.showRecovery) : [];
    if (!canApply()) return;
    const last = this.readSelection();
    const page = this.showTrash
      ? this.allPages.find((page) => page.notebookId === id && this.isPageInTrash(page)) ?? null
      : pages.find((page) => this.isPageVisible(page) && last.notebookID === id && last.pageID === page.id) ?? pages.find((page) => this.isPageVisible(page)) ?? null;
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
      pages = notebook ? await store.listPages(notebook.id, this.showTrash || this.showRecovery) : [];
      if (!canApply()) return;
    }
    this.currentPage = page;
    this.currentNotebook = notebook;
    this.pages = pages;
    this.view = "editor";
    this.renderLists();
    this.renderEditor();
    this.scrollActiveFlowPageIntoView();
    this.rememberSelection();
    await this.closeDrawers(false);
    if (navigation !== this.navigationGeneration) return;
  }

  /** Bring an explicitly selected page into view without changing automatic flow activation. */
  private scrollActiveFlowPageIntoView(): void {
    if (this.viewMode === "paged") return;
    const scroll = document.getElementById("paper-scroll");
    const flow = document.getElementById("page-flow");
    const slot = this.currentPage && flow ? [...flow.children].find((candidate) => (candidate as HTMLElement).dataset.flowPage === this.currentPage?.id) as HTMLElement | undefined : undefined;
    if (!scroll || !slot) return;
    const adjust = (): void => {
      if (!slot.isConnected || this.currentPage?.id !== slot.dataset.flowPage) return;
      const scrollRect = scroll.getBoundingClientRect();
      const slotRect = slot.getBoundingClientRect();
      if (this.viewMode === "horizontal") scroll.scrollLeft += slotRect.left - scrollRect.left - Math.max(0, (scrollRect.width - slotRect.width) / 2);
      else scroll.scrollTop += slotRect.top - scrollRect.top - Math.max(0, (scrollRect.height - slotRect.height) / 2);
    };
    adjust();
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(adjust);
  }

  private async createNotebook(title: string): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    if (!title || this.showTrash || this.showRecovery) return;
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
    if (!this.currentNotebook || this.showTrash || this.showRecovery) return;
    const source = this.currentPage;
    const page = createPage(this.currentNotebook.id, duplicate && source ? `${source.title} (copy)` : `Page ${this.pages.length + 1}`);
    if (source) {
      page.background = source.background;
      page.width = source.width;
      page.height = source.height;
      if (duplicate) {
        page.text = source.text;
        page.strokes = clonePage(source).strokes;
        setPageImages(page, cloneImages(getPageImages(source), true));
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
    if (this.currentPage) this.renderImageLayer(this.currentPage);
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
    const offlineAccountLabel = "Sign in required";
    const label = state.kind === "error" ? state.message : state.kind === "conflict" ? `${state.count} recovery cop${state.count === 1 ? "y" : "ies"}` : state.kind === "needs-login" ? offlineAccountLabel : state.kind === "offline" ? "Saved locally" : state.kind === "saving" ? "Saving…" : state.kind === "syncing" ? "Syncing…" : state.kind === "saved" ? "Saved locally" : "Ready";
    const icon = state.kind === "error" ? "!" : state.kind === "conflict" ? "↺" : state.kind === "syncing" ? "↻" : state.kind === "needs-login" ? "·" : "✓";
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-sync-button]")) {
      button.classList.toggle("is-busy", state.kind === "saving" || state.kind === "syncing");
      button.setAttribute("aria-label", label);
      button.dataset.state = state.kind;
      button.querySelector<HTMLElement>("[data-sync-icon]")?.replaceChildren(icon);
      button.querySelector<HTMLElement>("[data-sync-label]")?.replaceChildren(label);
    }
    const settingsLabel = document.getElementById("settings-sync-label");
    if (settingsLabel) {
      settingsLabel.replaceChildren(label);
      settingsLabel.title = label;
    }
    const retry = document.getElementById("settings-sync-button") as HTMLButtonElement | null;
    if (retry) {
      retry.disabled = state.kind === "syncing";
      retry.setAttribute("aria-label", `Sync now · ${label}`);
    }
  }

  private async duplicatePage(pageID: string): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    const source = this.allPages.find((page) => page.id === pageID) ?? await this.store.getPage(pageID);
    if (!source || source.deletedAt || this.showTrash || this.showRecovery) return;
    const copy = createPage(source.notebookId, `${source.title || "Untitled page"} (copy)`);
    copy.background = source.background;
    copy.width = source.width;
    copy.height = source.height;
    copy.text = source.text;
    copy.strokes = clonePage(source).strokes;
    setPageImages(copy, cloneImages(getPageImages(source), true));
    try {
      const result = await this.store.savePage(copy);
      if (result.status === "failed") {
        this.setState({ kind: "error", message: result.message ?? "Could not duplicate page" });
        return;
      }
      this.coordinator.notifyLocalWrite();
      this.view = "editor";
      await this.reload(copy.id);
      await this.closeDrawers();
    } catch (error) {
      this.setState({ kind: "error", message: error instanceof Error ? error.message : "Could not duplicate page" });
    }
  }

  private async duplicateNotebook(notebookID: string): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    if (this.showTrash || this.showRecovery) return;
    const source = this.notebooks.find((notebook) => notebook.id === notebookID) ?? await this.store.getNotebook(notebookID);
    if (!source || source.deletedAt) return;
    const copy = createNotebook(`${source.title || "Untitled notebook"} (copy)`);
    try {
      const notebookResult = await this.store.saveNotebook(copy);
      if (notebookResult.status === "failed") throw new Error(notebookResult.message ?? "Could not duplicate notebook");
      this.coordinator.notifyLocalWrite();
      const pages = await this.store.listPages(source.id);
      let firstPageID: string | undefined;
      for (const sourcePage of pages) {
        const page = createPage(copy.id, sourcePage.title);
        page.background = sourcePage.background;
        page.width = sourcePage.width;
        page.height = sourcePage.height;
        page.text = sourcePage.text;
        page.strokes = clonePage(sourcePage).strokes;
        setPageImages(page, cloneImages(getPageImages(sourcePage), true));
        const pageResult = await this.store.savePage(page);
        if (pageResult.status === "failed") throw new Error(pageResult.message ?? "Could not duplicate notebook page");
        this.coordinator.notifyLocalWrite();
        firstPageID ??= page.id;
      }
      this.view = "editor";
      await this.reload(firstPageID);
      await this.closeDrawers();
    } catch (error) {
      this.setState({ kind: "error", message: error instanceof Error ? error.message : "Could not duplicate notebook" });
    }
  }

  private async setNotebookDeleted(notebookID: string, restore: boolean): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    try {
      const result = restore ? await this.store.restoreNotebook(notebookID) : await this.store.archiveNotebook(notebookID);
      if (result.status === "failed") {
        this.setState({ kind: "error", message: result.message ?? "Could not update notebook" });
        return;
      }
      this.coordinator.notifyLocalWrite();
      if (notebookID === this.currentNotebook?.id && !restore) this.currentPage = null;
      await this.reload();
    } catch (error) {
      this.setState({ kind: "error", message: error instanceof Error ? error.message : "Could not update notebook" });
    }
  }

  private async setPageDeleted(pageID: string, restore: boolean): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    try {
      const result = restore ? await this.store.restorePage(pageID) : await this.store.deletePage(pageID);
      if (result.status === "failed") {
        this.setState({ kind: "error", message: result.message ?? "Could not update page" });
        return;
      }
      this.coordinator.notifyLocalWrite();
      if (pageID === this.currentPage?.id && !restore) this.currentPage = null;
      await this.reload();
    } catch (error) {
      this.setState({ kind: "error", message: error instanceof Error ? error.message : "Could not update page" });
    }
  }

  private setSyncLabels(label: string): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-sync-button]")) {
      button.setAttribute("aria-label", label);
      button.querySelector<HTMLElement>("[data-sync-label]")?.replaceChildren(label);
    }
    const settingsLabel = document.getElementById("settings-sync-label");
    if (settingsLabel) {
      settingsLabel.replaceChildren(label);
      settingsLabel.title = label;
    }
    document.getElementById("settings-sync-button")?.setAttribute("aria-label", `Sync now · ${label}`);
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
      this.setSyncLabels(label);
      return;
    }
    if (status.conflicts > 0) this.renderLists();
    if (!this.saveTimer && !this.saveInFlight && this.unsavedPageID === null) {
      this.setState(this.auth.session ? { kind: "saved" } : { kind: "needs-login" });
      if (this.pendingRemoteRefresh) {
        const label = status.pending > 0 ? `Refreshing notes · ${status.pending} queued` : "Refreshing notes…";
        this.setSyncLabels(label);
        return;
      }
      if (this.auth.session && status.lastSuccessAt && status.pending === 0) {
        const time = new Date(status.lastSuccessAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        const label = `Synced · ${time}`;
        this.setSyncLabels(label);
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
    this.setState({ kind: "saved" });
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
    this.setState({ kind: "saved" });
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
      this.showRecovery = false;
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
      <div class="sidebar-bottom"><button class="utility-row" id="recovery-toggle" aria-pressed="false"><span>↺</span><span id="recovery-label">Recovered copies</span><span class="utility-count" id="recovery-count" hidden>0</span></button><button class="utility-row" id="trash-toggle" aria-pressed="false"><span>♢</span><span id="trash-label">Trash</span></button><button class="utility-row" id="settings-button"><span>⌘</span> Settings</button></div>
    </aside>
    <main class="library" id="library" aria-label="Notebook library">
      <header class="library-header"><a class="library-brand" href="${BASE}">NotePad</a><div><button class="sync-status" id="library-sync-button" data-sync-button aria-label="Sign in required"><span id="library-sync-icon" data-sync-icon>·</span><span id="library-sync-label" data-sync-label>Sign in required</span></button><button id="library-trash" class="library-icon" aria-label="Open trash">♢</button><button id="library-settings" class="library-icon" aria-label="Library settings">⚙</button><button id="library-account" class="library-icon" aria-label="Library account">○</button></div></header>
      <section class="library-body"><div class="library-heading"><div><h1 id="library-title" tabindex="-1">Documents</h1><span id="library-count">0 notebooks</span></div><button class="library-new" id="library-new">＋ New…</button></div>
        <div class="library-controls"><label class="library-search"><span aria-hidden="true">⌕</span><input type="search" id="library-search" aria-label="Search library" placeholder="Search notebooks and typed notes" /></label><label class="library-sort">Sort by <select id="library-sort" aria-label="Sort notebooks"><option value="modified">Last edited</option><option value="name">Name</option></select></label><button class="library-icon" id="library-layout" aria-label="List view" aria-pressed="false">☷</button></div>
        <div class="library-books" id="library-books"></div><p class="library-empty" id="library-empty" role="status" hidden></p>
      </section>
      <nav class="library-tabs" aria-label="Library sections"><button id="library-documents" aria-current="page"><span aria-hidden="true">▱</span>Documents</button><button id="library-tab-search" aria-current="false"><span aria-hidden="true">⌕</span>Search</button><button id="library-favorites" aria-current="false"><span aria-hidden="true">☆</span>Favorites</button></nav>
    </main>
    <main class="workspace" id="editor-workspace" hidden>
      <header class="topbar"><div class="topbar-leading"><button class="back-library" id="back-library" aria-label="Back to Documents">‹ <span>Documents</span></button><button class="drawer-trigger" id="mobile-menu" aria-controls="sidebar" aria-expanded="false"><span class="drawer-trigger-icon">☰</span><span>Pages</span></button><div class="crumbs"><span class="eyebrow">NOTEBOOK</span><button class="notebook-title-button" id="rename-notebook" aria-label="Rename notebook"><strong id="notebook-name">My notebook</strong><span aria-hidden="true">✎</span></button><button class="menu-trigger" id="notebook-menu" data-menu-button aria-label="Notebook actions">⋯</button><div class="quick-menu top-quick-menu" id="notebook-menu-popup" hidden><button data-action="rename-notebook" data-notebook="">Rename notebook</button><button data-action="duplicate-notebook" data-notebook="">Duplicate notebook</button><button data-action="trash-notebook" data-notebook="">Move notebook to trash</button></div></div></div><div class="top-actions"><button class="text-toggle" id="text-toggle" aria-label="Text and page details" aria-controls="inspector" aria-expanded="false"><span aria-hidden="true">T</span><span>Text</span></button><button class="sync-status" id="sync-button" data-sync-button aria-label="Sign in required"><span id="sync-icon" data-sync-icon>·</span><span id="sync-label" data-sync-label>Sign in required</span></button><button class="avatar-button" id="auth-button" aria-label="Account">○</button></div></header>
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
           <div class="page-bar"><div class="page-heading"><button class="page-title-button" id="rename-page" aria-label="Rename page"><span class="page-title-kicker">PAGE</span><strong id="page-title-label">First page</strong><span aria-hidden="true">✎</span><span class="recovery-badge" id="recovery-page-badge" hidden>Recovered copy</span></button><button class="menu-trigger page-menu-trigger" id="page-menu" data-menu-button aria-label="Page actions">⋯</button><div class="quick-menu top-quick-menu" id="page-menu-popup" hidden><button data-action="rename-page" data-page="">Rename page</button><button data-action="duplicate-page" data-page="">Duplicate page</button><button data-action="trash-page" data-page="">Move page to trash</button></div></div><div class="page-navigation"><label class="view-mode-select"><span>View</span><select id="page-view-mode" aria-label="Page view mode"><option value="continuous">Continuous</option><option value="horizontal">Book scroll</option><option value="paged">Page turn</option></select></label><button class="quiet-button" id="previous-page" aria-label="Previous page">‹</button><span id="page-position" aria-live="polite">1 / 1</span><button class="quiet-button" id="next-page" aria-label="Next page">›</button><button class="quiet-button add-page" id="add-page" aria-label="Add page" title="Add page with the same paper">＋</button></div></div>
          <div class="paper-scroll" id="paper-scroll"><div class="page-flow" id="page-flow"><article class="flow-page active" id="active-page-slot" data-flow-page=""><div class="paper-viewport" id="paper-viewport"><div class="paper" id="paper"><canvas id="ink-canvas" aria-label="Note page drawing surface"></canvas><div class="paper-image-layer" id="paper-image-layer" aria-label="Page images"></div></div></div></article></div></div>
          <div class="print-note" aria-hidden="true"><h1 id="print-title"></h1><p id="print-text"></p></div>
           <div class="stage-foot" title="Two fingers to move or zoom · Hand tool for one-finger pan"><span id="tool-name" aria-live="polite">Pen</span><small class="gesture-hint">2 fingers: move / zoom · Hand: 1-finger pan</small><div class="view-controls"><button class="quiet-button" id="zoom-out" aria-label="Zoom out">−</button><span class="zoom-label" id="zoom-label">100%</span><button class="quiet-button" id="zoom-in" aria-label="Zoom in">＋</button><button class="quiet-button" id="fit-button" aria-label="Fit page width">Fit width</button><button class="quiet-button" id="fit-whole-page" aria-label="Fit whole page">Full page</button></div><span id="page-revision">revision 0</span></div>
        </div>
         <div class="empty-editor hidden" id="editor-empty"><div class="empty-orbit">✦</div><h1 id="editor-empty-title">Choose a page</h1><p id="editor-empty-copy">Your paper is waiting in the left rail.</p></div>
      <aside class="inspector" id="inspector" aria-label="Text and page details" aria-hidden="true"><div class="inspector-head"><div><span class="eyebrow">TEXT & DETAILS</span><strong class="inspector-title">Page tools</strong></div><button class="icon-button" id="close-inspector" aria-label="Close text panel">×</button></div><label class="title-field"><span>Page title</span><input id="page-title" type="text" placeholder="Untitled page" /></label><label class="text-field"><span>Typed note</span><textarea id="page-text" rows="8" placeholder="Type in Thai or English…" dir="auto"></textarea></label><label class="select-field"><span>Paper</span><select id="background-select"><option value="blank">Blank</option><option value="ruled">Ruled lines</option><option value="grid">Grid</option></select></label><section class="image-tools" aria-label="Page images"><div class="image-tools-head"><strong>Images</strong><span><button class="outline-button compact" id="insert-image" type="button">Insert image</button><button class="outline-button compact" id="paste-image" type="button">Paste image</button></span></div><input id="image-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden /><p class="image-empty" id="image-empty">Paste an image or choose a file.</p><div id="image-list"></div><div class="image-controls" id="image-controls" hidden><span id="selected-image-label">Selected image</span><label>Width <input id="image-width" type="range" min="48" max="960" step="1" value="320" /></label><div class="image-nudge"><button class="outline-button compact" id="image-left" type="button" aria-label="Move image left">←</button><button class="outline-button compact" id="image-right" type="button" aria-label="Move image right">→</button><button class="outline-button compact" id="image-up" type="button" aria-label="Move image up">↑</button><button class="outline-button compact" id="image-down" type="button" aria-label="Move image down">↓</button><button class="outline-button compact danger-button" id="remove-image" type="button">Remove</button></div></div></section><div class="inspector-actions"><button class="outline-button" id="duplicate-page">Duplicate page</button><button class="outline-button" id="delete-page">Move page to trash</button><button class="outline-button" id="keep-page" hidden>Keep as normal page</button><button class="outline-button" id="archive-notebook" title="Archive or restore notebook" aria-label="Archive or restore notebook">Archive notebook</button><button class="outline-button" id="print-button">Print / PDF</button><button class="outline-button" id="share-button">Share archive</button><button class="outline-button" id="export-button">Export backup</button></div><p class="inspector-note">Changes save locally after each edit. Sync uses the configured server only when you sign in.</p></aside>
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
  <dialog class="dialog" id="settings-dialog"><form class="dialog-form" id="settings-form"><div class="dialog-head"><div><span class="eyebrow">SETTINGS</span><h2>Keep your paper close</h2></div><button type="button" class="icon-button" id="cancel-settings" aria-label="Close">×</button></div><label>Sync server URL<input id="endpoint-input" type="url" inputmode="url" placeholder="https://notes.example.com" /></label><p class="form-hint">Use the same HTTPS server on every device. Changing servers requires signing in again.</p><div class="account-line"><span>Sync</span><strong id="settings-sync-label" aria-live="polite" title="Sign in required">Sign in required</strong><button class="outline-button compact" type="button" id="settings-sync-button">Sync now</button></div><p class="form-message offline-cache-status" id="offline-cache-status" role="status">Preparing offline cache…</p><div class="settings-actions"><button class="outline-button" type="button" id="browse-import">Import backup</button><button class="outline-button" type="button" id="settings-export">Export backup</button><button class="outline-button" type="button" id="settings-share">Share backup</button></div><input id="import-input" type="file" accept="application/json,.json,.notepad" hidden /><p class="form-message" id="settings-message"></p>${thisAccountMarkup(auth)}<div class="app-build"><span>Web app build ${APP_BUILD}</span><button class="outline-button compact" type="button" id="reload-app">Reload app</button></div><button class="primary-button" type="submit">Save settings</button></form></dialog>
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
function previewText(value: string): string { return value.replace(/\s+/g, " ").trim().slice(0, 80); }
function pageNotebookLabel(page: NotePage, notebooks: Notebook[]): string {
  const notebook = notebooks.find((item) => item.id === page.notebookId);
  return notebook ? escapeHTML(notebook.title) : "Notebook";
}
function dateStamp(): string { return new Date().toISOString().slice(0, 10); }
function download(blob: Blob, filename: string): void { const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
function argbToCSS(color: number): string { const value = color >>> 0; return `rgba(${(value >>> 16) & 0xff},${(value >>> 8) & 0xff},${value & 0xff},${((value >>> 24) & 0xff) / 255})`; }

function getPageImages(page: NotePage): PageImage[] {
  const images = page.images;
  return Array.isArray(images) ? images : [];
}

function setPageImages(page: NotePage, images: PageImage[]): void {
  page.images = images;
}

function cloneImages(images: PageImage[], freshIDs = false): PageImage[] {
  return images.map((image) => ({ ...image, id: freshIDs ? id() : image.id }));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

async function makePageImage(file: File, page: NotePage, index: number): Promise<PageImage> {
  const original = await readFileAsDataURL(file);
  let src = original;
  let sourceWidth = 1200;
  let sourceHeight = 900;
  const decoded = await decodeImage(file, original);
  try {
    sourceWidth = decoded.width;
    sourceHeight = decoded.height;
    if (!(sourceWidth > 0 && sourceHeight > 0)) throw new Error("Could not decode image dimensions.");
    const maxDimension = 1600;
    if (Math.max(sourceWidth, sourceHeight) > maxDimension || file.size > 1_500_000) {
      const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser cannot prepare images.");
      context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
      src = canvas.toDataURL("image/jpeg", .84);
      sourceWidth = canvas.width;
      sourceHeight = canvas.height;
    }
  } finally {
    decoded.close?.();
  }
  const maxWidth = Math.max(1, page.width - 64);
  const maxHeight = Math.max(1, page.height - 64);
  let width = Math.min(maxWidth, sourceWidth, 640);
  let height = Math.max(1, width * sourceHeight / Math.max(1, sourceWidth));
  if (height > maxHeight) {
    const fit = maxHeight / height;
    width *= fit;
    height = maxHeight;
  }
  const offset = Math.min(64 + index * 16, Math.max(0, page.width - width));
  return { id: id(), src, x: offset, y: Math.min(64 + index * 16, Math.max(0, page.height - height)), width, height };
}

async function readFileAsDataURL(file: File): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read image."));
    reader.onerror = () => reject(new Error("Could not read image."));
    reader.readAsDataURL(file);
  });
}

async function decodeImage(file: File, src: string): Promise<{ width: number; height: number; source: CanvasImageSource; close?: () => void }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() };
  }
  const image = new Image();
  image.src = src;
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("Could not decode image.")); });
  return { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height, source: image };
}

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
