import "./styles.css";
import { AuthClient, AuthSession, getEndpoint, setEndpoint } from "./auth";
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
  now,
} from "./models";
import { Archive, NoteStore, SQLiteNoteStore } from "./storage";
import { SyncClient } from "./sync";

const BASE = import.meta.env.BASE_URL;
type OfflineCacheStatus = "preparing" | "ready" | "error" | "unsupported" | "development";

class NotePadApp {
  private readonly root: HTMLElement;
  private readonly auth = new AuthSession();
  private readonly authClient = new AuthClient();
  private readonly syncClient = new SyncClient();
  private store!: NoteStore;
  private notebooks: Notebook[] = [];
  private pages: NotePage[] = [];
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

  constructor(root: HTMLElement) {
    this.root = root;
    void this.start();
  }

  private async start(): Promise<void> {
    this.root.innerHTML = loadingMarkup();
    try {
      this.store = await SQLiteNoteStore.open(this.accountKey());
      await this.store.ensureStarterData();
      this.renderShell();
      await this.reload();
      await this.registerServiceWorker();
      this.setState(this.auth.session ? { kind: "saved" } : { kind: "needs-login" });
    } catch (error) {
      this.root.innerHTML = errorMarkup(error instanceof Error ? error.message : "Could not open the local notebook.");
    }
  }

  private accountKey(): string {
    return this.useGuestWorkspace ? "guest" : this.auth.workspaceKey;
  }

  private renderShell(): void {
    this.root.innerHTML = shellMarkup();
    const canvas = byId<HTMLCanvasElement>("ink-canvas");
    this.canvas = new PaperCanvas(canvas, byId("paper"), byId("paper-viewport"), {
      onChange: (strokes) => this.handleCanvasChange(strokes),
      onZoom: (scale) => {
        byId("zoom-label").textContent = `${Math.round(scale * 100)}%`;
      },
    });
    this.bindEvents();
    byId<HTMLInputElement>("endpoint-input").value = getEndpoint();
    this.setOfflineCacheStatus(this.offlineCacheStatus, this.offlineCacheMessage);
  }

  private bindEvents(): void {
    onClick("new-notebook", () => this.createNotebook());
    onClick("new-page", () => this.createNewPage());
    onClick("trash-toggle", () => { void this.toggleTrash(); });
    onClick("mobile-menu", () => byId("sidebar").classList.toggle("is-open"));
    onClick("close-sidebar", () => byId("sidebar").classList.remove("is-open"));
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
    onClick("settings-button", () => this.openDialog("settings-dialog"));
    onClick("auth-button", () => this.openAuthDialog());
    onClick("logout-button", () => this.logout());
    onClick("archive-notebook", () => this.archiveCurrentNotebook());
    onClick("delete-page", () => this.deleteCurrentPage());
    onClick("cancel-auth", () => this.closeDialog("auth-dialog"));
    onClick("cancel-settings", () => this.closeDialog("settings-dialog"));
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
    document.addEventListener("keydown", (event) => this.handleShortcut(event));
    window.addEventListener("online", () => this.setState(this.auth.session ? { kind: "saved" } : { kind: "needs-login" }));
    window.addEventListener("offline", () => this.setState({ kind: "offline" }));
  }

  private async reload(selectID?: string): Promise<void> {
    this.notebooks = await this.store.listNotebooks(this.showTrash);
    if (this.notebooks.length === 0 && !this.showTrash) {
      const starter = await this.store.ensureStarterData();
      this.notebooks = [starter.notebook];
    }
    const notebookID = this.currentNotebook && this.notebooks.some((item) => item.id === this.currentNotebook?.id)
      ? this.currentNotebook.id : this.notebooks[0]?.id;
    this.currentNotebook = notebookID ? await this.store.getNotebook(notebookID) : null;
    this.pages = this.currentNotebook ? await this.store.listPages(this.currentNotebook.id, this.showTrash) : [];
    if (selectID) this.currentPage = await this.store.getPage(selectID);
    if (!this.currentPage || !this.pages.some((item) => item.id === this.currentPage?.id)) this.currentPage = this.pages[0] ?? null;
    this.renderLists();
    this.renderEditor();
  }

  private async toggleTrash(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    this.showTrash = !this.showTrash;
    await this.reload();
  }

  private renderLists(): void {
    const notebookList = byId("notebook-list");
    const notebooks = this.notebooks.filter((notebook) => this.showTrash ? Boolean(notebook.deletedAt) : !notebook.deletedAt)
      .filter((notebook) => !this.search || notebook.title.toLocaleLowerCase().includes(this.search));
    notebookList.innerHTML = notebooks.length ? notebooks.map((notebook) => `
      <button class="nav-row ${notebook.id === this.currentNotebook?.id ? "selected" : ""}" data-notebook="${escapeAttr(notebook.id)}" aria-current="${notebook.id === this.currentNotebook?.id ? "page" : "false"}">
        <span class="nav-glyph">${notebook.deletedAt ? "◌" : "▱"}</span><span class="nav-copy"><strong>${escapeHTML(notebook.title)}</strong><small>${notebook.id === this.currentNotebook?.id ? `${this.pagesForNotebook(notebook.id)} pages` : "Notebook"}</small></span>
      </button>`).join("") : `<p class="empty-copy">${this.showTrash ? "Trash is empty." : "Create a notebook to begin."}</p>`;
    notebookList.querySelectorAll<HTMLButtonElement>("[data-notebook]").forEach((button) => button.addEventListener("click", () => void this.selectNotebook(button.dataset.notebook!)));

    const pageList = byId("page-list");
    const pages = this.pages.filter((page) => this.showTrash ? Boolean(page.deletedAt) : !page.deletedAt)
      .filter((page) => !this.search || `${page.title} ${page.text}`.toLocaleLowerCase().includes(this.search));
    pageList.innerHTML = pages.length ? pages.map((page) => `
      <button class="page-row ${page.id === this.currentPage?.id ? "selected" : ""}" data-page="${escapeAttr(page.id)}" aria-current="${page.id === this.currentPage?.id ? "page" : "false"}">
        <span class="page-index">${this.pages.indexOf(page) + 1}</span><span class="page-copy"><strong>${escapeHTML(page.title || "Untitled page")}</strong><small>${page.text.trim() ? escapeHTML(preview(page.text)) : `${page.strokes.length} strokes`}</small></span>
      </button>`).join("") : `<p class="empty-copy">${this.showTrash ? "No deleted pages." : "No pages yet."}</p>`;
    pageList.querySelectorAll<HTMLButtonElement>("[data-page]").forEach((button) => button.addEventListener("click", () => void this.selectPage(button.dataset.page!)));
    byId("trash-toggle").classList.toggle("active", this.showTrash);
    byId("trash-toggle").setAttribute("aria-pressed", String(this.showTrash));
    byId("trash-label").textContent = this.showTrash ? "Back to notebook" : "Trash";
    byId("new-page").toggleAttribute("disabled", this.showTrash || !this.currentNotebook);
    byId("new-notebook").toggleAttribute("disabled", this.showTrash);
  }

  private pagesForNotebook(notebookID: string): number {
    return this.pages.filter((page) => page.notebookId === notebookID && (this.showTrash ? Boolean(page.deletedAt) : !page.deletedAt)).length;
  }

  private renderEditor(): void {
    const page = this.currentPage;
    const hasPage = Boolean(page);
    byId("editor-empty").classList.toggle("hidden", hasPage);
    byId("editor-content").classList.toggle("hidden", !hasPage);
    const pageAction = byId<HTMLButtonElement>("delete-page");
    pageAction.disabled = !hasPage;
    if (!page) return;
    byId<HTMLInputElement>("page-title").value = page.title;
    byId<HTMLTextAreaElement>("page-text").value = page.text;
    byId<HTMLSelectElement>("background-select").value = page.background;
    byId("notebook-name").textContent = this.currentNotebook?.title ?? "No notebook";
    byId("page-revision").textContent = `revision ${page.revision}`;
    pageAction.disabled = false;
    pageAction.textContent = this.showTrash ? "Restore page" : "Move page to trash";
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
    const result = this.showTrash
      ? await this.store.restorePage(this.currentPage.id)
      : await this.store.deletePage(this.currentPage.id);
    if (result.status === "failed") {
      this.setState({ kind: "error", message: result.message ?? "Could not update page" });
      return;
    }
    this.currentPage = null;
    await this.reload();
  }

  private updateToolbar(): void {
    byId<HTMLButtonElement>("undo-button").disabled = !this.canvas?.hasUndo;
    byId<HTMLButtonElement>("redo-button").disabled = !this.canvas?.hasRedo;
  }

  private async selectNotebook(id: string): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    this.editGeneration += 1;
    this.currentNotebook = await this.store.getNotebook(id);
    this.pages = this.currentNotebook ? await this.store.listPages(this.currentNotebook.id, this.showTrash) : [];
    this.currentPage = this.pages[0] ?? null;
    this.renderLists();
    this.renderEditor();
    byId("sidebar").classList.remove("is-open");
  }

  private async selectPage(id: string): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    this.editGeneration += 1;
    this.currentPage = await this.store.getPage(id);
    this.renderLists();
    this.renderEditor();
    byId("sidebar").classList.remove("is-open");
  }

  private async createNotebook(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    const title = window.prompt("Notebook name", "My notebook")?.trim();
    if (!title) return;
    const notebook = createNotebook(title);
    const result = await this.store.saveNotebook(notebook);
    if (result.status === "failed") return this.setState({ kind: "error", message: result.message ?? "Could not save notebook" });
    const page = createPage(notebook.id, "First page");
    await this.store.savePage(page);
    this.currentNotebook = notebook;
    await this.reload(page.id);
  }

  private async createNewPage(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    if (!this.currentNotebook || this.showTrash) return;
    const page = createPage(this.currentNotebook.id, `Page ${this.pages.length + 1}`);
    const result = await this.store.savePage(page);
    if (result.status === "failed") return this.setState({ kind: "error", message: result.message ?? "Could not save page" });
    await this.reload(page.id);
    const title = byId<HTMLInputElement>("page-title");
    title.focus();
    title.select();
  }

  private handleCanvasChange(strokes: InkStroke[]): void {
    if (!this.currentPage) return;
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
        this.currentPage.revision = savedPage.revision;
        this.currentPage.updatedAt = savedAt;
        byId("page-revision").textContent = `revision ${this.currentPage.revision}`;
        this.renderLists();
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
    const label = state.kind === "error" ? state.message : state.kind === "conflict" ? `${state.count} conflict${state.count === 1 ? "" : "s"}` : state.kind === "needs-login" ? "Guest · local only" : state.kind === "offline" ? "Saved locally" : state.kind === "saving" ? "Saving…" : state.kind === "syncing" ? "Syncing…" : state.kind === "saved" ? "Saved locally" : "Ready";
    byId("sync-label").textContent = label;
    byId("sync-button").classList.toggle("is-busy", state.kind === "saving" || state.kind === "syncing");
    byId("sync-button").setAttribute("aria-label", label);
    byId("sync-icon").textContent = state.kind === "error" ? "!" : state.kind === "conflict" ? "!" : state.kind === "syncing" ? "↻" : state.kind === "needs-login" ? "·" : "✓";
  }

  private async sync(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    const store = this.store;
    const generation = this.editGeneration;
    this.setState({ kind: "syncing" });
    try {
      const report = await this.syncClient.sync(store, this.auth.session);
      if (store !== this.store || generation !== this.editGeneration) return;
      await this.reload(this.currentPage?.id);
      this.setState(report.conflicts ? { kind: "conflict", count: report.conflicts } : { kind: "saved" });
    } catch (error) {
      this.setState({ kind: "error", message: error instanceof Error ? error.message : "Sync unavailable. Notes remain local." });
    }
  }

  private openAuthDialog(): void {
    if (this.auth.session) { this.openDialog("settings-dialog"); return; }
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
      this.auth.set(response);
      this.useGuestWorkspace = false;
      byId("account-name").textContent = response.user.identifier;
      byId<HTMLButtonElement>("logout-button").hidden = false;
      await this.store.close();
      this.store = await SQLiteNoteStore.open(this.accountKey());
      await this.store.ensureStarterData();
      this.pendingGuestArchive = guestArchive && guestArchive.pages.length > 0 ? guestArchive : null;
      this.closeDialog("auth-dialog");
      await this.reload();
      if (this.pendingGuestArchive) this.openDialog("migration-dialog");
      else void this.sync();
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
    void this.sync();
  }

  private async logout(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    const session = this.auth.session;
    if (session) { try { await this.authClient.logout(session.sessionToken, this.auth.boundEndpoint ?? getEndpoint()); } catch { /* local logout still succeeds offline */ } }
    await this.store.close();
    this.auth.clear();
    this.useGuestWorkspace = true;
    this.store = await SQLiteNoteStore.open("guest");
    await this.store.ensureStarterData();
    await this.reload();
    this.closeDialog("settings-dialog");
    byId("account-name").textContent = "Guest · this device";
    byId<HTMLButtonElement>("logout-button").hidden = true;
    this.setState({ kind: "needs-login" });
  }

  private async archiveCurrentNotebook(): Promise<void> {
    if (!(await this.flushPendingSave())) return;
    if (!this.currentNotebook) return;
    if (this.currentNotebook.deletedAt) await this.store.restoreNotebook(this.currentNotebook.id);
    else await this.store.archiveNotebook(this.currentNotebook.id);
    await this.reload();
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
      await this.store.close();
      this.auth.clear();
      this.useGuestWorkspace = true;
      this.store = await SQLiteNoteStore.open(this.accountKey());
      await this.store.ensureStarterData();
      await this.reload();
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
      await this.reload();
      byId("settings-message").textContent = `Imported ${result.pages} pages in ${result.notebooks} notebooks.`;
    } catch (error) {
      byId("settings-message").textContent = error instanceof Error ? error.message : "Could not import this archive.";
    }
  }

  private handleShortcut(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLocaleLowerCase() === "s") { event.preventDefault(); void this.flushPendingSave(); }
    if (modifier && event.key.toLocaleLowerCase() === "z") { event.preventDefault(); event.shiftKey ? this.canvas?.redo() : this.canvas?.undo(); this.updateToolbar(); }
    if (modifier && event.key.toLocaleLowerCase() === "y") { event.preventDefault(); this.canvas?.redo(); this.updateToolbar(); }
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

function shellMarkup(): string {
  return `<div class="app-shell">
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-head"><a class="brand" href="${BASE}" aria-label="NotePad home"><span class="brand-mark">N</span><span><strong>NotePad</strong><small>quiet paper</small></span></a><button class="icon-button mobile-only" id="close-sidebar" aria-label="Close notebook menu">×</button></div>
      <button class="new-button" id="new-notebook"><span>＋</span> New notebook</button>
      <label class="search-field"><span>⌕</span><input id="search-input" type="search" placeholder="Search notes" aria-label="Search notes" autocomplete="off" /></label>
      <div class="list-section"><div class="list-heading"><span>NOTEBOOKS</span><span class="rule"></span></div><nav id="notebook-list" aria-label="Notebooks"></nav></div>
      <div class="list-section pages-section"><div class="list-heading"><span>PAGES</span><button id="new-page" class="small-action" aria-label="New page">＋</button></div><nav id="page-list" aria-label="Pages"></nav></div>
      <div class="sidebar-bottom"><button class="utility-row" id="trash-toggle" aria-pressed="false"><span>♢</span><span id="trash-label">Trash</span></button><button class="utility-row" id="settings-button"><span>⌘</span> Settings</button></div>
    </aside>
    <main class="workspace">
      <header class="topbar"><button class="icon-button mobile-only" id="mobile-menu" aria-label="Open notebook menu">☰</button><div class="crumbs"><span class="eyebrow">NOTEBOOK</span><strong id="notebook-name">My notebook</strong></div><div class="top-actions"><button class="sync-status" id="sync-button" aria-label="Guest local mode"><span id="sync-icon">·</span><span id="sync-label">Guest · local only</span></button><button class="avatar-button" id="auth-button" aria-label="Account">○</button></div></header>
      <section class="editor-layout">
        <div class="editor-stage" id="editor-content">
      <div class="editor-toolbar"><div class="tool-group"><button class="tool-button active" id="pen-tool" aria-label="Pen tool" title="Pen">✎</button><button class="tool-button" id="eraser-tool" aria-label="Whole stroke eraser" title="Whole stroke eraser">⌫</button><span class="toolbar-divider"></span><div class="color-palette" aria-label="Pen colors"><button class="color-dot active" data-color="4280624169" style="--dot:#252429" aria-label="Graphite"></button><button class="color-dot" data-color="4290334270" style="--dot:#b94e3e" aria-label="Terracotta"></button><button class="color-dot" data-color="4281752936" style="--dot:#365d68" aria-label="Deep teal"></button><button class="color-dot" data-color="4289955637" style="--dot:#b38735" aria-label="Ochre"></button></div><span id="color-preview" class="color-preview" style="background:#252429"></span><label class="width-control"><span id="width-value">3px</span><input id="width-range" type="range" min="1" max="12" step="0.5" value="3" aria-label="Pen width" /></label></div><div class="tool-group tool-group-right"><button class="quiet-button" id="undo-button" aria-label="Undo" title="Undo (⌘Z)" disabled>↶</button><button class="quiet-button" id="redo-button" aria-label="Redo (⇧⌘Z)" disabled>↷</button><span class="toolbar-divider"></span><button class="quiet-button" id="zoom-out" aria-label="Zoom out">−</button><span class="zoom-label" id="zoom-label">100%</span><button class="quiet-button" id="zoom-in" aria-label="Zoom in">＋</button><button class="quiet-button" id="fit-button" aria-label="Fit page">Fit</button></div></div>
          <div class="paper-viewport" id="paper-viewport"><div class="paper" id="paper"><canvas id="ink-canvas" aria-label="Note page drawing surface"></canvas></div></div>
          <div class="print-note" aria-hidden="true"><h1 id="print-title"></h1><p id="print-text"></p></div>
          <div class="stage-foot"><span><kbd>⌘</kbd><kbd>S</kbd> save</span><span>Apple Pencil / stylus draws · finger moves paper</span><span id="page-revision">revision 0</span></div>
        </div>
        <div class="empty-editor hidden" id="editor-empty"><div class="empty-orbit">✦</div><h1>Choose a page</h1><p>Your paper is waiting in the left rail.</p></div>
      <aside class="inspector" aria-label="Page details"><div class="inspector-head"><span class="eyebrow">PAGE DETAILS</span><button class="quiet-button" id="archive-notebook" title="Archive or restore notebook" aria-label="Archive or restore notebook">◌</button></div><label class="title-field"><span>Title</span><input id="page-title" type="text" placeholder="Untitled page" /></label><label class="text-field"><span>Typed note</span><textarea id="page-text" rows="8" placeholder="Type in Thai or English…" dir="auto"></textarea></label><label class="select-field"><span>Paper</span><select id="background-select"><option value="blank">Blank</option><option value="ruled">Ruled lines</option><option value="grid">Grid</option></select></label><div class="inspector-actions"><button class="outline-button" id="delete-page">Move page to trash</button><button class="outline-button" id="print-button">Print / PDF</button><button class="outline-button" id="share-button">Share archive</button><button class="outline-button" id="export-button">Export backup</button></div><p class="inspector-note">Changes save locally after each edit. Sync uses the configured server only when you sign in.</p></aside>
      </section>
    </main>
    ${dialogMarkup()}
  </div>`;
}

function dialogMarkup(): string {
  return `<dialog class="dialog" id="auth-dialog"><form class="dialog-form" id="auth-form" data-mode="login"><div class="dialog-head"><div><span class="eyebrow">ACCOUNT</span><h2 id="auth-dialog-title">Sign in to sync</h2></div><button type="button" class="icon-button" id="cancel-auth" aria-label="Close">×</button></div><div class="mode-switch"><button type="button" id="login-mode" class="active">Sign in</button><button type="button" id="register-mode">Create account</button></div><label>Identifier<input id="auth-identifier" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="you@example.com or username" required /></label><label>Password<input id="auth-password" type="password" autocomplete="current-password" minlength="12" placeholder="12 characters minimum" required /></label><p class="form-hint">Your guest notebook stays on this device. After sign-in, you choose whether to move it into the account.</p><p class="form-error" id="auth-error" role="alert"></p><button class="primary-button" id="auth-submit" type="submit">Sign in</button></form></dialog>
  <dialog class="dialog" id="settings-dialog"><form class="dialog-form" id="settings-form"><div class="dialog-head"><div><span class="eyebrow">SETTINGS</span><h2>Keep your paper close</h2></div><button type="button" class="icon-button" id="cancel-settings" aria-label="Close">×</button></div><label>Sync server URL<input id="endpoint-input" type="url" inputmode="url" placeholder="https://notes.example.com" /></label><p class="form-hint">Leave this empty for private guest mode. Use an HTTPS URL for login and sync. A temporary tunnel is only available while its server is running.</p><p class="form-message offline-cache-status" id="offline-cache-status" role="status">Preparing offline cache…</p><div class="settings-actions"><button class="outline-button" type="button" id="browse-import">Import backup</button><button class="outline-button" type="button" id="settings-export">Export backup</button><button class="outline-button" type="button" id="settings-share">Share backup</button></div><input id="import-input" type="file" accept="application/json,.json,.notepad" hidden /><p class="form-message" id="settings-message"></p>${thisAccountMarkup()}<button class="primary-button" type="submit">Save settings</button></form></dialog>
  <dialog class="dialog" id="migration-dialog"><div class="dialog-form"><div class="dialog-head"><div><span class="eyebrow">GUEST NOTEBOOK</span><h2>Move your local paper?</h2></div><button type="button" class="icon-button" id="cancel-migration" aria-label="Close">×</button></div><p class="migration-copy">You have notes in guest mode. Move a copy into the signed-in account, or keep the guest notebook on this device for later.</p><div class="migration-actions"><button class="outline-button" id="keep-guest">Keep guest notes</button><button class="primary-button" id="move-guest">Move a copy into account</button></div></div></dialog>`;
}

function thisAccountMarkup(): string {
  const session = new AuthSession();
  const user = session.user;
  return `<div class="account-line"><span>Account</span><strong id="account-name">${escapeHTML(session.workspaceIdentifier ?? "Guest · this device")}</strong><button type="button" class="outline-button compact" id="logout-button"${user ? "" : " hidden"}>Sign out</button></div>`;
}

function loadingMarkup(): string { return `<div class="loading-screen"><span class="brand-mark">N</span><p>Opening your paper…</p></div>`; }
function errorMarkup(message: string): string { return `<div class="loading-screen error-screen"><span class="brand-mark">!</span><h1>Paper could not open</h1><p>${escapeHTML(message)}</p><button class="primary-button" onclick="location.reload()">Try again</button></div>`; }
function byId<T extends HTMLElement = HTMLElement>(id: string): T { const element = document.getElementById(id); if (!element) throw new Error(`Missing UI element #${id}`); return element as T; }
function onClick(id: string, handler: () => void): void { byId(id).addEventListener("click", handler); }
function escapeHTML(value: string): string { return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[char] ?? char); }
function escapeAttr(value: string): string { return escapeHTML(value); }
function preview(value: string): string { return value.replace(/\s+/g, " ").trim().slice(0, 54); }
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
