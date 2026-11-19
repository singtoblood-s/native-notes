import { describe, expect, it, vi } from "vitest";
import { observeOfflineWorker } from "../src/offline-worker";

class WorkerStub extends EventTarget {
  constructor(public state: ServiceWorkerState) { super(); }

  transition(state: ServiceWorkerState): void {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

function registrationWith(active: WorkerStub | null, installing: WorkerStub | null) {
  const registration = Object.assign(new EventTarget(), { active, installing, waiting: null });
  const container = Object.assign(new EventTarget(), { controller: active, ready: Promise.resolve(registration) });
  const report = vi.fn();
  observeOfflineWorker(container as unknown as ServiceWorkerContainer,
    registration as unknown as ServiceWorkerRegistration, report);
  return { registration, container, report };
}

describe("offline status", () => {
  it("continues observing an activating active slot after ready resolves", async () => {
    const active = new WorkerStub("activating");
    const { container, report } = registrationWith(active, null);
    await container.ready;
    expect(report).toHaveBeenLastCalledWith("preparing", expect.any(String));
    active.transition("activated");
    expect(report).toHaveBeenLastCalledWith("ready", expect.any(String));
    expect(report.mock.calls.some(([status]) => status === "error")).toBe(false);
  });

  it("waits for a slow successful first installation and tracks its controller", async () => {
    vi.useFakeTimers();
    try {
      const installing = new WorkerStub("installing");
      const { container, registration, report } = registrationWith(null, installing);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(report).toHaveBeenLastCalledWith("preparing", expect.any(String));
      registration.active = installing;
      registration.installing = null;
      installing.transition("activated");
      expect(report).toHaveBeenLastCalledWith("ready", expect.stringContaining("reload"));
      container.controller = installing;
      container.dispatchEvent(new Event("controllerchange"));
      expect(report).toHaveBeenLastCalledWith("ready", "Offline cache ready.");
    } finally { vi.useRealTimers(); }
  });

  it("reports an interrupted update and observes a later retry", () => {
    const active = new WorkerStub("activated");
    const { registration, report } = registrationWith(active, null);
    expect(report).toHaveBeenLastCalledWith("ready", expect.any(String));
    const next = new WorkerStub("installing");
    registration.installing = next;
    registration.dispatchEvent(new Event("updatefound"));
    expect(report).toHaveBeenLastCalledWith("preparing", expect.any(String));
    registration.installing = null;
    next.transition("redundant");
    expect(report).toHaveBeenLastCalledWith("error", expect.stringContaining("previous version"));
    const retry = new WorkerStub("installing");
    registration.installing = retry;
    registration.dispatchEvent(new Event("updatefound"));
    registration.active = retry;
    registration.installing = null;
    retry.transition("activated");
    expect(report).toHaveBeenLastCalledWith("ready", expect.any(String));
  });
});
