import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const generatorPath = resolve(testDirectory, "../scripts/generate-sw.mjs");
const precache = [
  "./assets/index-test.js",
  "./assets/storage.worker-test.js",
  "./assets/sqlite3-test.wasm",
  "./index.html",
  "./manifest.webmanifest",
];

class TestHeaders {
  private readonly values: Map<string, string>;

  constructor(values: Record<string, string> = {}) {
    this.values = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  }

  has(name: string): boolean { return this.values.has(name.toLowerCase()); }
}

class TestRequest {
  readonly method = "GET";
  readonly headers: TestHeaders;
  readonly mode: RequestMode;

  constructor(readonly url: string, mode: RequestMode = "same-origin", headers: Record<string, string> = {}) {
    this.mode = mode;
    this.headers = new TestHeaders(headers);
  }
}

class TestResponse {
  readonly ok: boolean;

  constructor(readonly body: string, readonly status = 200) {
    this.ok = status >= 200 && status < 300;
  }

  clone(): TestResponse { return new TestResponse(this.body, this.status); }
}

async function loadGeneratedServiceWorker() {
  const generator = await readFile(generatorPath, "utf8");
  const match = generator.match(/const source = `([\s\S]*?)`;\r?\nawait writeFile/);
  if (!match?.[1]) throw new Error("Could not locate the generated service-worker source template.");
  const source = match[1]
    .replace("${JSON.stringify(cacheName)}", JSON.stringify("notepad-static-test"))
    .replace("${JSON.stringify(precache)}", JSON.stringify(precache));

  const handlers = new Map<string, (event: any) => void>();
  const cache = {
    added: [] as string[],
    async addAll(resources: string[]) { this.added = [...resources]; },
    async put() { /* runtime caching is outside this contract test */ },
  };
  const caches = {
    async open() { return cache; },
    async keys() { return ["notepad-static-old", "unrelated-cache"]; },
    async delete() { return true; },
    async match() { return undefined as TestResponse | undefined; },
  };
  const self = {
    location: { origin: "https://notes.example.test" },
    registration: { scope: "https://notes.example.test/native-notes/" },
    clients: { async matchAll() { return []; } },
    addEventListener(type: string, listener: (event: any) => void) { handlers.set(type, listener); },
    skipWaiting() { /* no-op */ },
  };
  const context = { self, caches, URL, Response: TestResponse, console, fetch: async () => { throw new Error("offline"); } };
  vm.runInNewContext(source, context);
  return { handlers, cache, caches, context };
}

describe("generated service worker contract", () => {
  it("precaches the complete offline app shell, including WASM and worker assets", async () => {
    const { handlers, cache } = await loadGeneratedServiceWorker();
    let installPromise: Promise<unknown> | undefined;
    handlers.get("install")?.({ waitUntil(value: Promise<unknown>) { installPromise = value; } });
    await installPromise;
    expect(cache.added).toEqual(precache);
    expect(cache.added).toContain("./index.html");
    expect(cache.added.some((path) => path.endsWith(".js"))).toBe(true);
    expect(cache.added.some((path) => path.includes("worker"))).toBe(true);
    expect(cache.added.some((path) => path.endsWith(".wasm"))).toBe(true);
  });

  it("serves the cached shell for an offline navigation", async () => {
    const loaded = await loadGeneratedServiceWorker();
    const shell = new TestResponse("<!doctype html><div id=app></div>");
    loaded.caches.match = async (request: string | TestRequest) => {
      const url = typeof request === "string" ? request : request.url;
      return url.endsWith("/index.html") ? shell : undefined;
    };
    loaded.context.fetch = async () => { throw new Error("offline"); };
    let responsePromise: Promise<TestResponse> | undefined;
    loaded.handlers.get("fetch")?.({
      request: new TestRequest("https://notes.example.test/native-notes/", "navigate"),
      respondWith(value: Promise<TestResponse>) { responsePromise = value; },
    });
    await expect(responsePromise).resolves.toBe(shell);
  });

  it("does not intercept external or authenticated API requests", async () => {
    const loaded = await loadGeneratedServiceWorker();
    const requests = [
      new TestRequest("https://api.example.test/v1/sync", "cors"),
      new TestRequest("https://notes.example.test/native-notes/v1/auth/login", "same-origin"),
      new TestRequest("https://notes.example.test/native-notes/assets/index.js", "same-origin", { Authorization: "Bearer secret" }),
    ];
    for (const request of requests) {
      let intercepted = false;
      loaded.handlers.get("fetch")?.({ request, respondWith() { intercepted = true; } });
      expect(intercepted).toBe(false);
    }
  });
});
