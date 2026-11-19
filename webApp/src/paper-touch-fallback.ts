interface Finger {
  startX: number;
  startY: number;
  x: number;
  y: number;
  target: EventTarget;
  pointerId: number;
  primary: boolean;
  ended?: boolean;
  nativeAfterCancel?: boolean;
}

// WebKit can deliver Touch Events while some corresponding Pointer Events are
// absent. Fill just the gaps, using the same controller as the pointer path.
// Touch identifiers and pointer IDs are independent namespaces.
export class PaperTouchFallback {
  private readonly touches = new Map<number, Finger>();
  private readonly pointers = new Map<number, Finger>();
  private readonly injected = new WeakSet<Event>();
  private nextId = -10;
  private readonly listeners = new AbortController();

  constructor(private readonly surface: HTMLElement) {
    const options = { capture: true, signal: this.listeners.signal };
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"] as const) {
      window.addEventListener(type, this.observePointer, options);
    }
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"] as const) {
      surface.addEventListener(type, this.handleTouch, { ...options, passive: true });
    }
    window.addEventListener("blur", this.reset, options);
  }

  destroy(): void { this.listeners.abort(); this.reset(); }

  private readonly reset = (): void => { this.touches.clear(); this.pointers.clear(); };

  private readonly observePointer = (event: PointerEvent): void => {
    if (event.pointerType !== "touch" || this.injected.has(event)) return;
    const id = event.pointerId;
    if (event.type === "pointerdown") {
      if (!(event.target instanceof Node) || !this.surface.contains(event.target)) return;
      const bound = new Set(this.pointers.values());
      const paired = [...this.touches.values()].find(t => !t.ended && t.pointerId < 0 && !bound.has(t) &&
        Math.hypot(t.startX - event.clientX, t.startY - event.clientY) < 3);
      const finger = paired ?? { startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
        target: event.target, primary: event.isPrimary, pointerId: id };
      this.pointers.set(id, finger);
    }
    const finger = this.pointers.get(id);
    if (!finger) return;
    // A gesture can lose the pointer stream while the native stream continues.
    // Keep its identity (including any palm rejection) until native end/cancel.
    if (event.type === "pointercancel" && !finger.ended && [...this.touches.values()].includes(finger)) {
      finger.nativeAfterCancel = true;
      event.stopImmediatePropagation();
      return;
    }
    if (event.type === "lostpointercapture") {
      if (finger.nativeAfterCancel) event.stopImmediatePropagation();
      return;
    }
    // In the rare case a real down follows an already handled native drag,
    // keep the original contact until it lifts.
    if (finger.pointerId !== id) event.stopImmediatePropagation();
    else {
      finger.x = event.clientX;
      finger.y = event.clientY;
    }
    if (event.type === "pointerup" || event.type === "pointercancel") {
      if (finger.pointerId === id) finger.ended = true;
      this.pointers.delete(id);
    }
  };

  private readonly handleTouch = (event: TouchEvent): void => {
    if (!event.changedTouches || typeof PointerEvent === "undefined") return;
    const type = event.type;
    if (type === "touchstart") {
      // A detached preview can lose its last up/cancel. The next native touch
      // list authoritatively closes contacts that have physically left the glass.
      const live = new Set(Array.from(event.touches, touch => touch.identifier));
      for (const [id, finger] of this.touches) if (!live.has(id)) this.finish(id, finger, "pointercancel");
    }
    for (const touch of Array.from(event.changedTouches)) {
      if ((touch as Touch & { touchType?: string }).touchType === "stylus") continue;
      const id = touch.identifier;
      if (type === "touchstart") {
        if (!(touch.target instanceof Node) || !this.surface.contains(touch.target)) continue;
        const stale = this.touches.get(id);
        if (stale) this.finish(id, stale, "pointercancel");
        const used = new Set(this.touches.values());
        const paired = [...this.pointers.values()].find(p => !p.ended && !used.has(p) &&
          Math.hypot(p.startX - touch.clientX, p.startY - touch.clientY) < 3);
        const finger: Finger = paired ?? { startX: touch.clientX, startY: touch.clientY,
          x: touch.clientX, y: touch.clientY, primary: this.touches.size === 0, target: touch.target, pointerId: this.nextId-- };
        this.touches.set(id, finger);
        if (!paired) this.emitTouch(finger, "pointerdown", touch);
        continue;
      }
      const finger = this.touches.get(id);
      if (!finger) continue;
      if (type === "touchmove" && !finger.ended) {
        if (Math.abs(touch.clientX - finger.x) < 1 && Math.abs(touch.clientY - finger.y) < 1) continue;
        finger.x = touch.clientX;
        finger.y = touch.clientY;
        this.emitTouch(finger, "pointermove", touch);
      } else if (type === "touchend" || type === "touchcancel") {
        finger.x = touch.clientX;
        finger.y = touch.clientY;
        this.finish(id, finger, type === "touchend" ? "pointerup" : "pointercancel");
      }
    }
  };

  private finish(id: number, finger: Finger, type: string): void {
    const owner = this.pointers.get(finger.pointerId);
    if (!finger.ended && (!owner || owner === finger)) this.emit(finger, type);
    finger.ended = true;
    if (owner === finger) this.pointers.delete(finger.pointerId);
    this.touches.delete(id);
  }

  private emitTouch(finger: Finger, type: string, touch: Touch): void {
    const safari = touch as Touch & { webkitRadiusX?: number; webkitRadiusY?: number };
    this.emit(finger, type, 2 * (touch.radiusX || safari.webkitRadiusX || 0.5),
      2 * (touch.radiusY || safari.webkitRadiusY || 0.5));
  }

  private emit(finger: Finger, type: string, width = 1, height = 1): void {
    const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch",
      pointerId: finger.pointerId, isPrimary: finger.primary, clientX: finger.x, clientY: finger.y,
      width, height, buttons: type === "pointerdown" || type === "pointermove" ? 1 : 0 });
    this.injected.add(event);
    const target = finger.target instanceof Node && this.surface.contains(finger.target) ? finger.target : this.surface;
    target.dispatchEvent(event);
  }
}
