const STORAGE_KEY = "notepad.floating-tools";
const SIZE = 56;
const GAP = 12;

/** Move the existing controls so their state, listeners and save behavior stay intact. */
export class FloatingTools {
  private floating = false;
  private position = { x: 1, y: .65 };
  private readonly workspace: HTMLElement;
  private readonly bubble: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly rows: { element: HTMLElement; home: Comment }[];

  constructor(signal: AbortSignal, private readonly closeMenus: () => void, private readonly canToggle: () => boolean) {
    this.workspace = document.getElementById("editor-workspace")!;
    this.workspace.querySelector(".top-actions")!.insertAdjacentHTML("afterbegin", '<button id="float-tools" class="outline-button" title="Hide bars in a draggable circle" aria-label="Collapse bars into floating tools">◉ <span>Focus</span></button>');
    this.toggle = document.getElementById("float-tools") as HTMLButtonElement;
    this.workspace.insertAdjacentHTML("beforeend", `
      <button id="floating-tools-button" class="floating-tools-button" hidden aria-controls="floating-tools-panel" aria-expanded="false" aria-describedby="floating-tools-help"><span class="floating-tool-icon" aria-hidden="true"></span><span class="floating-tool-status" aria-hidden="true"></span></button>
      <section id="floating-tools-panel" class="floating-tools-panel" aria-label="Floating tools" hidden>
        <div class="floating-tools-heading"><strong>Tools</strong><button id="reset-tools-position" class="outline-button">Reset position</button><button id="dock-tools" class="outline-button">Restore bars</button><button id="close-floating-tools" class="icon-button" aria-label="Close floating tools">×</button></div>
        <p id="floating-tools-help">Drag the circle to move it. Tap to open or close. Use arrow keys to move the focused circle; Esc closes tools.</p>
      </section>`);
    this.bubble = document.getElementById("floating-tools-button") as HTMLButtonElement;
    this.panel = document.getElementById("floating-tools-panel")!;
    this.rows = [".topbar", ".editor-toolbar", ".page-bar", ".stage-foot"].map(selector => {
      const element = this.workspace.querySelector<HTMLElement>(selector)!;
      const home = document.createComment("control position");
      element.before(home);
      return { element, home };
    });
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
      this.floating = saved?.floating === true;
      if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) {
        this.position = { x: Math.max(0, Math.min(1, saved.x)), y: Math.max(0, Math.min(1, saved.y)) };
      }
    } catch { /* Optional device preference. */ }
    this.toggle.addEventListener("click", () => this.setFloating(true), { signal });
    document.getElementById("dock-tools")!.addEventListener("click", () => this.setFloating(false), { signal });
    document.getElementById("close-floating-tools")!.addEventListener("click", () => this.close(), { signal });
    document.getElementById("reset-tools-position")!.addEventListener("click", () => {
      this.position = { x: 1, y: .65 }; this.place(); this.remember();
    }, { signal });
    let drag: { id: number; x: number; y: number; left: number; top: number; moved: boolean } | null = null;
    let suppressClick = false;
    this.bubble.addEventListener("pointerdown", event => {
      if (event.button !== 0 || drag || !this.canToggle()) return;
      const rect = this.bubble.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
      suppressClick = false;
      this.bubble.setPointerCapture(event.pointerId);
    }, { signal });
    this.bubble.addEventListener("pointermove", event => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      drag.moved = true;
      suppressClick = true;
      this.close(false);
      this.bubble.classList.add("is-dragging");
      this.moveTo(drag.left + dx, drag.top + dy);
    }, { signal });
    const endDrag = (event: PointerEvent): void => {
      if (!drag || drag.id !== event.pointerId) return;
      suppressClick = drag.moved || event.type === "pointercancel";
      drag = null;
      this.bubble.classList.remove("is-dragging");
      if (this.bubble.hasPointerCapture(event.pointerId)) this.bubble.releasePointerCapture(event.pointerId);
      this.remember();
    };
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) this.bubble.addEventListener(type, endDrag, { signal });
    this.bubble.addEventListener("click", event => {
      if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
      if (!this.canToggle()) return;
      if (!this.panel.hidden) this.close();
      else {
        this.closeMenus();
        this.panel.hidden = false;
        this.bubble.setAttribute("aria-expanded", "true");
        this.place();
        document.getElementById("close-floating-tools")!.focus({ preventScroll: true });
      }
    }, { signal });
    this.bubble.addEventListener("keydown", event => {
      const delta = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[event.key];
      if (!delta) return;
      event.preventDefault(); event.stopPropagation();
      const rect = this.bubble.getBoundingClientRect();
      const step = event.shiftKey ? 40 : 10;
      this.moveTo(rect.left + delta[0]! * step, rect.top + delta[1]! * step);
      this.remember();
    }, { signal });
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || this.panel.hidden || document.querySelector("dialog[open]") || document.body.classList.contains("drawer-open")) return;
      // Let a nested menu consume the first Escape.
      if (this.panel.querySelector(".quick-menu:not([hidden])")) return;
      event.preventDefault(); event.stopImmediatePropagation(); this.close();
    }, { signal, capture: true });
    document.addEventListener("pointerdown", event => {
      if (this.panel.hidden || this.panel.contains(event.target as Node) || this.bubble.contains(event.target as Node) || document.querySelector("dialog[open]") || document.body.classList.contains("drawer-open")) return;
      this.close(false);
    }, { signal, capture: true });
    this.panel.addEventListener("scroll", () => this.closeMenus(), { signal });
    window.addEventListener("resize", () => this.place(), { signal });
    window.visualViewport?.addEventListener("resize", () => this.place(), { signal });
    window.visualViewport?.addEventListener("scroll", () => this.place(), { signal });
    const observer = new MutationObserver(() => this.refresh());
    for (const id of ["tool-name", "sync-button"]) observer.observe(document.getElementById(id)!, { subtree: true, childList: true, attributes: true, characterData: true });
    observer.observe(this.workspace, { attributes: true, attributeFilter: ["hidden"] });
    observer.observe(document.getElementById("editor-content")!, { attributes: true, attributeFilter: ["class"] });
    signal.addEventListener("abort", () => observer.disconnect(), { once: true });
    this.apply();
    this.refresh();
  }

  close(focus = true): void {
    if (this.panel.hidden) return;
    this.closeMenus();
    this.panel.hidden = true;
    this.bubble.setAttribute("aria-expanded", "false");
    if (focus) this.bubble.focus({ preventScroll: true });
  }

  private setFloating(value: boolean): void {
    if (!this.canToggle()) return;
    this.close(false);
    this.closeMenus();
    this.floating = value;
    this.apply();
    this.remember();
    (value ? this.bubble : this.toggle).focus({ preventScroll: true });
  }

  private apply(): void {
    this.workspace.classList.toggle("floating-tools-mode", this.floating);
    for (const { element, home } of this.rows) {
      if (this.floating) this.panel.append(element);
      else home.after(element);
    }
    this.toggle.hidden = this.floating;
    this.bubble.hidden = !this.floating;
    this.place();
  }

  private bounds() {
    const viewport = window.visualViewport;
    return { left: (viewport?.offsetLeft ?? 0) + GAP, top: (viewport?.offsetTop ?? 0) + GAP,
      width: Math.max(0, (viewport?.width ?? window.innerWidth) - GAP * 2 - SIZE),
      height: Math.max(0, (viewport?.height ?? window.innerHeight) - GAP * 2 - SIZE) };
  }

  private moveTo(left: number, top: number): void {
    const bounds = this.bounds();
    this.position = { x: Math.max(0, Math.min(1, (left - bounds.left) / (bounds.width || 1))), y: Math.max(0, Math.min(1, (top - bounds.top) / (bounds.height || 1))) };
    this.place();
  }

  private place(): void {
    const bounds = this.bounds();
    const left = bounds.left + bounds.width * this.position.x;
    const top = bounds.top + bounds.height * this.position.y;
    this.bubble.style.left = `${left}px`;
    this.bubble.style.top = `${top}px`;
    if (this.panel.hidden) return;
    this.panel.style.maxHeight = `${Math.max(SIZE, bounds.height)}px`;
    this.panel.style.width = `${Math.min(560, bounds.width + SIZE)}px`;
    const width = this.panel.offsetWidth, height = this.panel.offsetHeight;
    const beside = left >= bounds.left + width + GAP ? left - width - GAP : left + SIZE + GAP;
    this.panel.style.left = `${Math.max(bounds.left, Math.min(beside, bounds.left + bounds.width + SIZE - width))}px`;
    const panelTop = Math.max(bounds.top, Math.min(top, bounds.top + bounds.height + SIZE - height));
    this.panel.style.top = `${panelTop}px`;
    // On narrow screens reserve one row for the circle; the panel never covers it.
    if (left < bounds.left + width + GAP && beside + width > bounds.left + bounds.width + SIZE) {
      const above = top - bounds.top, below = bounds.top + bounds.height - top;
      const available = Math.max(above, below) - GAP;
      this.panel.style.maxHeight = `${Math.max(0, available)}px`;
      this.panel.style.top = `${above > below ? top - GAP - Math.min(height, available) : top + SIZE + GAP}px`;
    }
  }

  private refresh(): void {
    if (!this.workspace.isConnected) return;
    if (this.workspace.hidden) this.close(false);
    this.panel.classList.toggle("floating-no-page", document.getElementById("editor-content")!.classList.contains("hidden"));
    const active = this.workspace.querySelector<HTMLElement>(".tool-button.active");
    this.bubble.querySelector(".floating-tool-icon")!.innerHTML = active?.querySelector("svg")?.outerHTML ?? "✎";
    const tool = document.getElementById("tool-name")!.textContent ?? "Tools";
    const sync = document.getElementById("sync-button")!;
    const label = `Tools · ${tool} · ${sync.getAttribute("aria-label") ?? ""}`;
    this.bubble.setAttribute("aria-label", label);
    this.bubble.title = `${label}. Drag to move; tap to open.`;
    this.bubble.dataset.state = sync.dataset.state;
    this.bubble.querySelector(".floating-tool-status")!.textContent = sync.querySelector("[data-sync-icon]")?.textContent ?? "";
    this.place();
  }

  private remember(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ floating: this.floating, ...this.position })); } catch { /* Notes do not depend on this preference. */ }
  }
}
