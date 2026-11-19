type CacheStatus = "preparing" | "ready" | "error";

/** Follow the worker through activating, including installs that outlive the first page visit. */
export function observeOfflineWorker(container: ServiceWorkerContainer, registration: ServiceWorkerRegistration,
  report: (status: CacheStatus, message: string) => void): void {
  let worker: ServiceWorker | null = null;
  let failure = "";

  function showState(): void {
    if (worker?.state === "activated") {
      report("ready", container.controller ? "Offline cache ready." : "Offline cache ready; available after reload.");
    } else if (worker?.state === "redundant" || failure) {
      const previous = registration.active?.state === "activated" && registration.active !== worker;
      const fallback = previous ? " The previous version is still available offline." : "";
      report("error", `Offline cache error: ${failure || "Installation failed. Reopen while online to retry."}${fallback}`);
    } else {
      report("preparing", "Preparing offline cache…");
    }
  }

  function follow(next: ServiceWorker | null): void {
    if (!next) return;
    if (worker !== next) {
      worker?.removeEventListener("statechange", showState);
      worker = next;
      failure = "";
      worker.addEventListener("statechange", showState);
    }
    showState();
  }

  const latest = () => registration.installing ?? registration.waiting ?? registration.active;
  registration.addEventListener("updatefound", () => follow(latest()));
  container.addEventListener("controllerchange", () => follow(latest() ?? container.controller));
  container.addEventListener("message", event => {
    if (event.source !== worker || event.data?.type !== "notepad-cache-error") return;
    failure = typeof event.data.message === "string" ? event.data.message : "Could not prepare offline files.";
    showState();
  });
  follow(latest());
  // ready guarantees an active slot, which can still be in the activating state.
  void container.ready.then(ready => { if (!worker) follow(ready.installing ?? ready.waiting ?? ready.active); });
}
