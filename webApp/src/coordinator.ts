import { AuthResponse, now } from "./models";
import { getEndpoint } from "./auth";
import { NoteStore } from "./storage";
import { SyncClient, SyncHttpError, SyncReport } from "./sync";

const DEFAULT_DEBOUNCE_MS = 750;
const DEFAULT_INTERVAL_MS = 5_000;
const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export type SyncCoordinatorState = "idle" | "scheduled" | "syncing" | "offline" | "needs-login" | "error";

export interface SyncCoordinatorStatus {
  state: SyncCoordinatorState;
  reason: string | null;
  pending: number;
  pendingMayContinue: boolean;
  conflicts: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
}

export interface SyncCoordinatorOptions {
  getStore: () => NoteStore | null | undefined;
  getSession: () => AuthResponse | null;
  client?: SyncClient;
  debounceMs?: number;
  intervalMs?: number;
  onStatus?: (status: SyncCoordinatorStatus) => void;
  /** Flush the editor before a network run; return false to skip that run. */
  onBeforeSync?: (context: SyncStartContext) => Promise<boolean> | boolean;
  /** Let the UI reload remote rows after a completed run when its editor is safe. */
  onAfterSync?: (context: SyncCompleteContext) => Promise<void> | void;
}

export interface SyncStartContext {
  store: NoteStore;
  session: AuthResponse;
  reason: string;
}

export interface SyncCompleteContext extends SyncStartContext {
  report: SyncReport;
}

/**
 * Keeps sync event driven without making the editor wait for the network.
 * Saves remain the source of truth; this class only asks SyncClient to drain
 * the durable outbox and pull remote changes when the page is usable.
 */
export class SyncCoordinator {
  private readonly getStore: SyncCoordinatorOptions["getStore"];
  private readonly getSession: SyncCoordinatorOptions["getSession"];
  private readonly client: SyncClient;
  private readonly debounceMs: number;
  private readonly intervalMs: number;
  private readonly onStatus?: (status: SyncCoordinatorStatus) => void;
  private readonly onBeforeSync?: SyncCoordinatorOptions["onBeforeSync"];
  private readonly onAfterSync?: SyncCoordinatorOptions["onAfterSync"];
  private readonly listeners = new Set<(status: SyncCoordinatorStatus) => void>();
  private statusValue: SyncCoordinatorStatus = emptyStatus();
  private started = false;
  private timer: number | null = null;
  private active: Promise<void> | null = null;
  private requested = false;
  private nextReason = "startup";
  private retryCount = 0;
  private generation = 0;

  private readonly handleOnline = (): void => {
    this.retryCount = 0;
    this.schedule(0, "online");
  };

  private readonly handleOffline = (): void => {
    this.cancelTimer();
    this.publish({ state: "offline", error: null });
  };

  private readonly handleVisibility = (): void => {
    if (this.isVisible()) this.schedule(0, "foreground");
    else this.cancelTimer();
  };

  constructor(options: SyncCoordinatorOptions) {
    this.getStore = options.getStore;
    this.getSession = options.getSession;
    this.client = options.client ?? new SyncClient();
    this.debounceMs = boundedDelay(options.debounceMs ?? DEFAULT_DEBOUNCE_MS, 0, 60_000);
    this.intervalMs = boundedDelay(options.intervalMs ?? DEFAULT_INTERVAL_MS, 5_000, 24 * 60 * 60_000);
    this.onStatus = options.onStatus;
    this.onBeforeSync = options.onBeforeSync;
    this.onAfterSync = options.onAfterSync;
  }

  get status(): SyncCoordinatorStatus { return { ...this.statusValue }; }

  subscribe(listener: (status: SyncCoordinatorStatus) => void): () => void {
    listener(this.status);
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);
    document.addEventListener("visibilitychange", this.handleVisibility);
    if (!this.isOnline()) {
      this.publish({ state: "offline", error: null });
      return;
    }
    this.schedule(0, "startup");
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.generation += 1;
    this.requested = false;
    this.cancelTimer();
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);
    document.removeEventListener("visibilitychange", this.handleVisibility);
  }

  /** Call after login, logout, endpoint changes, or a guest/account switch. */
  notifyAuthChanged(): void {
    // Invalidate completions from the previous account before scheduling the
    // new one. The old request may still finish while the UI switches stores.
    this.generation += 1;
    this.retryCount = 0;
    this.cancelTimer();
    this.requested = false;
    this.publish({ ...emptyStatus(), state: this.isOnline() ? "idle" : "offline", reason: "auth" });
    if (!this.started) return;
    this.schedule(0, "auth");
  }

  /** Call after a durable local save. The save itself remains synchronous to the UI. */
  notifyLocalWrite(): void {
    if (!this.started) return;
    this.schedule(this.debounceMs, "local-write");
  }

  /** Request an immediate attempt, for the toolbar or a pull-to-refresh action. */
  request(reason = "manual"): void {
    if (!this.started) return;
    this.schedule(0, reason);
  }

  private schedule(delay: number, reason: string): void {
    if (!this.started) return;
    this.requested = true;
    this.nextReason = reason;
    if (!this.isOnline() || !this.isVisible()) {
      if (!this.isOnline()) this.publish({ state: "offline", reason, error: null });
      else if (reason === "local-write") this.publish({ state: "scheduled", reason, error: null });
      return;
    }
    if (delay <= 0) {
      this.cancelTimer();
      void this.drain();
      return;
    }
    // A local edit should shorten an already scheduled periodic wake-up.
    this.cancelTimer();
    if (reason === "local-write") this.publish({ state: "scheduled", reason, error: null });
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delay);
  }

  private async drain(): Promise<void> {
    if (!this.started || this.active || !this.requested) return;
    const generation = this.generation;
    const run = this.performDrain(generation);
    this.active = run;
    try {
      await run;
    } finally {
      if (this.active === run) this.active = null;
      // A local write or account switch can queue a run while this one is in
      // flight. Re-check after clearing active so it cannot be lost.
      if (this.started && this.requested && this.timer === null) void this.drain();
    }
  }

  private async performDrain(generation: number): Promise<void> {
    this.requested = false;
    const reason = this.nextReason;
    const store = this.getStore();
    const session = this.getSession();
    if (!store) {
      this.publishIfCurrent(generation, { state: "idle", error: null });
      return;
    }
    if (!(await this.refreshPending(store, generation))) return;
    if (!this.started || generation !== this.generation) return;
    if (!this.isOnline()) {
      this.publishIfCurrent(generation, { state: "offline", error: null });
      return;
    }
    if (!session || store.accountKey === "guest" || !getEndpoint()) {
      this.publishIfCurrent(generation, { state: "needs-login", error: null });
      return;
    }
    if (!this.isRunCurrent(generation, store, session)) return;
    let maySync: boolean;
    try {
      maySync = await this.onBeforeSync?.({ store, session, reason }) ?? true;
    } catch (error) {
      // A failed editor flush is a local error. Keep the outbox untouched and
      // wait for the next save/manual/foreground trigger instead of retrying
      // in a tight loop.
      this.publishIfCurrent(generation, { state: "error", error: safeError(error) });
      return;
    }
    if (!maySync) {
      this.publishIfCurrent(generation, { state: "idle", reason, error: null });
      // A failed local save must not permanently cancel remote polling.
      if (this.started && generation === this.generation && !this.requested) this.schedule(this.intervalMs, "periodic");
      return;
    }
    if (!this.isRunCurrent(generation, store, session)) return;
    const startedAt = now();
    this.publishIfCurrent(generation, { state: "syncing", reason, lastAttemptAt: startedAt, error: null });
    await this.run(store, session, generation, reason);
  }

  private async run(store: NoteStore, session: AuthResponse, generation: number, reason: string): Promise<void> {
    try {
      const report = await this.client.sync(store, session);
      if (!this.isRunCurrent(generation, store, session)) return;
      if (this.generation === generation) await this.onAfterSync?.({ store, session, reason, report });
      if (!(await this.refreshPending(store, generation, report.conflicts))) return;
      this.retryCount = 0;
      this.publishIfCurrent(generation, { state: "idle", lastSuccessAt: now(), error: null });
      // Keep a local-write/auth request that arrived while the network was in
      // flight. Replacing its short debounce with the periodic timer would
      // make a just-saved note wait a minute before its first upload.
      if (this.started && this.generation === generation && !this.requested) this.schedule(this.intervalMs, "periodic");
    } catch (error) {
      await this.refreshPending(store, generation);
      const status = error instanceof SyncHttpError && error.status === 401 ? "needs-login" : this.isOnline() ? "error" : "offline";
      const message = status === "offline" || status === "needs-login" ? null : safeError(error);
      this.publishIfCurrent(generation, { state: status, error: message });
      if (status === "error" && this.started && this.generation === generation && !this.requested) {
        const delay = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** Math.min(this.retryCount, 8));
        this.retryCount += 1;
        this.schedule(delay, "retry");
      }
    }
  }

  private async refreshPending(store: NoteStore, generation: number, conflictCount?: number): Promise<boolean> {
    try {
      const operations = await store.pendingOperations(100);
      const conflicts = conflictCount ?? (await store.listConflicts()).length;
      this.publishIfCurrent(generation, { pending: operations.length, pendingMayContinue: operations.length >= 100, conflicts });
      return true;
    } catch (error) {
      this.publishIfCurrent(generation, { state: "error", error: safeError(error) });
      return false;
    }
  }

  private publishIfCurrent(generation: number, patch: Partial<SyncCoordinatorStatus>): void {
    if (generation !== this.generation) return;
    this.publish(patch);
  }

  private isRunCurrent(generation: number, store: NoteStore, session: AuthResponse): boolean {
    if (!this.started || generation !== this.generation) return false;
    const endpoint = getEndpoint();
    return Boolean(endpoint && store.accountKey === `${endpoint}:${session.user.id.toLowerCase()}`);
  }

  private publish(patch: Partial<SyncCoordinatorStatus>): void {
    this.statusValue = { ...this.statusValue, ...patch };
    const status = this.status;
    this.onStatus?.(status);
    this.listeners.forEach((listener) => listener(status));
  }

  private isVisible(): boolean {
    return typeof document === "undefined" || document.visibilityState !== "hidden";
  }

  private isOnline(): boolean {
    return typeof navigator === "undefined" || navigator.onLine !== false;
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function emptyStatus(): SyncCoordinatorStatus {
  return { state: "idle", reason: null, pending: 0, pendingMayContinue: false, conflicts: 0, lastAttemptAt: null, lastSuccessAt: null, error: null };
}

function boundedDelay(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.round(value))) : minimum;
}

function safeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Sync failed. Notes remain saved locally.";
}
