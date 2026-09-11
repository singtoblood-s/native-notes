// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthResponse, SyncOperation } from "../src/models";
import { NoteStore } from "../src/storage";
import { SyncClient } from "../src/sync";
import { SyncCoordinator } from "../src/coordinator";

const session: AuthResponse = {
  user: { id: "55555555-5555-4555-8555-555555555555", identifier: "tester@example.test" },
  sessionToken: "opaque-test-token",
  expiresAt: "2099-01-01T00:00:00Z",
};

function fakeStore(accountKey = "https://sync.example.test:55555555-5555-4555-8555-555555555555"): NoteStore {
  return {
    accountKey,
    persistence: "indexeddb",
    pendingOperations: vi.fn(async () => []),
    listConflicts: vi.fn(async () => []),
  } as unknown as NoteStore;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, "onLine", { configurable: true, value });
}

afterEach(() => {
  vi.useRealTimers();
  setOnline(true);
  localStorage.clear();
});

describe("automatic sync coordinator", () => {
  it("pulls and pushes on startup for an account workspace", async () => {
    vi.useFakeTimers();
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const store = fakeStore();
    const sync = vi.fn(async () => ({ pushed: 0, pulled: 1, conflicts: 0 }));
    const before = vi.fn(async () => true);
    const after = vi.fn();
    const coordinator = new SyncCoordinator({
      getStore: () => store,
      getSession: () => session,
      client: { sync } as unknown as SyncClient,
      intervalMs: 5_000,
      onBeforeSync: before,
      onAfterSync: after,
    });

    coordinator.start();
    await settle();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(coordinator.status.state).toBe("idle");
    expect(coordinator.status.lastAttemptAt).not.toBeNull();
    expect(coordinator.status.lastSuccessAt).not.toBeNull();
    expect(before).toHaveBeenCalledWith({ store, session, reason: "startup" });
    expect(after).toHaveBeenCalledWith({ store, session, reason: "startup", report: { pushed: 0, pulled: 1, conflicts: 0 } });
    coordinator.stop();
  });

  it("debounces local writes and does not start a second request immediately", async () => {
    vi.useFakeTimers();
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const store = fakeStore();
    const sync = vi.fn(async () => ({ pushed: 1, pulled: 0, conflicts: 0 }));
    const coordinator = new SyncCoordinator({
      getStore: () => store,
      getSession: () => session,
      client: { sync } as unknown as SyncClient,
      debounceMs: 750,
      intervalMs: 60_000,
    });

    coordinator.start();
    await settle();
    coordinator.notifyLocalWrite();
    vi.advanceTimersByTime(749);
    await settle();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(coordinator.status.state).toBe("scheduled");
    vi.advanceTimersByTime(1);
    await settle();
    expect(sync).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });

  it("keeps a write queued while a previous sync is in flight", async () => {
    vi.useFakeTimers();
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const store = fakeStore();
    let release!: () => void;
    const first = new Promise<{ pushed: number; pulled: number; conflicts: number }>((resolve) => { release = () => resolve({ pushed: 0, pulled: 0, conflicts: 0 }); });
    const sync = vi.fn().mockImplementationOnce(() => first).mockResolvedValue({ pushed: 1, pulled: 0, conflicts: 0 });
    const coordinator = new SyncCoordinator({ getStore: () => store, getSession: () => session, client: { sync } as unknown as SyncClient, debounceMs: 750, intervalMs: 60_000 });

    coordinator.start();
    await settle();
    expect(sync).toHaveBeenCalledTimes(1);
    coordinator.notifyLocalWrite();
    release();
    await settle();
    expect(sync).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(750);
    await settle();
    expect(sync).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });

  it("resumes polling after a save returns false and pulls every five seconds without edits", async () => {
    vi.useFakeTimers();
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const store = fakeStore();
    const sync = vi.fn(async () => ({ pushed: 0, pulled: 1, conflicts: 0 }));
    const before = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const coordinator = new SyncCoordinator({ getStore: () => store, getSession: () => session, client: { sync } as unknown as SyncClient, onBeforeSync: before });
    coordinator.start();
    await settle();
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sync).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });

  it("reports a failed editor flush without an unhandled retry loop", async () => {
    vi.useFakeTimers();
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const store = fakeStore();
    const sync = vi.fn(async () => ({ pushed: 0, pulled: 0, conflicts: 0 }));
    const coordinator = new SyncCoordinator({
      getStore: () => store,
      getSession: () => session,
      client: { sync } as unknown as SyncClient,
      onBeforeSync: async () => { throw new Error("Local save failed"); },
    });

    coordinator.start();
    await settle();
    expect(sync).not.toHaveBeenCalled();
    expect(coordinator.status.state).toBe("error");
    expect(coordinator.status.error).toBe("Local save failed");
    vi.advanceTimersByTime(10_000);
    await settle();
    expect(sync).not.toHaveBeenCalled();
    coordinator.stop();
  });

  it("waits for online recovery and never syncs a guest workspace", async () => {
    vi.useFakeTimers();
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const store = fakeStore("guest");
    const sync = vi.fn(async () => ({ pushed: 0, pulled: 0, conflicts: 0 }));
    const coordinator = new SyncCoordinator({ getStore: () => store, getSession: () => session, client: { sync } as unknown as SyncClient });

    setOnline(false);
    coordinator.start();
    await settle();
    expect(sync).not.toHaveBeenCalled();
    expect(coordinator.status.state).toBe("offline");

    setOnline(true);
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(sync).not.toHaveBeenCalled();
    expect(coordinator.status.state).toBe("needs-login");
    coordinator.stop();
  });

  it("does not start a request when the account changes during the pending check", async () => {
    vi.useFakeTimers();
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const store = fakeStore();
    let releasePending!: () => void;
    const pending = new Promise<SyncOperation[]>((resolve) => { releasePending = () => resolve([]); });
    const pendingOperations = vi.fn(() => pending);
    store.pendingOperations = pendingOperations;
    const sync = vi.fn(async () => ({ pushed: 0, pulled: 0, conflicts: 0 }));
    let currentSession = session;
    const coordinator = new SyncCoordinator({
      getStore: () => store,
      getSession: () => currentSession,
      client: { sync } as unknown as SyncClient,
    });

    coordinator.start();
    await settle();
    expect(pendingOperations).toHaveBeenCalledTimes(1);
    currentSession = { ...session, user: { ...session.user, id: "66666666-6666-4666-8666-666666666666" } };
    coordinator.notifyAuthChanged();
    releasePending();
    await settle();

    expect(sync).not.toHaveBeenCalled();
    coordinator.stop();
  });

  it("does not start a request when the endpoint changes during the pending check", async () => {
    vi.useFakeTimers();
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const store = fakeStore();
    let releasePending!: () => void;
    store.pendingOperations = vi.fn(() => new Promise<SyncOperation[]>((resolve) => { releasePending = () => resolve([]); }));
    const sync = vi.fn(async () => ({ pushed: 0, pulled: 0, conflicts: 0 }));
    const coordinator = new SyncCoordinator({ getStore: () => store, getSession: () => session, client: { sync } as unknown as SyncClient });

    coordinator.start();
    await settle();
    localStorage.setItem("notepad.endpoint", "https://other.example.test");
    releasePending();
    await settle();

    expect(sync).not.toHaveBeenCalled();
    coordinator.stop();
  });
});
