import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
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

let sourcePromise: Promise<string> | undefined;
async function generateFixture(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "notepad-sw-unit-"));
  try {
    await mkdir(resolve(directory, "assets"));
    for (const file of precache) await writeFile(resolve(directory, file), file);
    execFileSync(process.execPath, [generatorPath, directory], { windowsHide: true });
    return await readFile(resolve(directory, "sw.js"), "utf8");
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function loadGeneratedServiceWorker() {
  const source = await (sourcePromise ??= generateFixture());

  const handlers = new Map<string, (event: any) => void>();
  const cache = {
    added: [] as string[],
    async addAll(resources: Request[]) { this.added.push(...resources.map(req => "." + new URL(req.url).pathname.slice("/native-notes".length))); },
    async match() { return undefined; },
    async put(_request: TestRequest, _response: Response) {},
  };
  const caches = {
    async open() { return cache; },
    async keys() { return ["notepad-static-old", "unrelated-cache"]; },
    async delete(_name: string) { return true; },
    async match(_request: string | TestRequest, _options?: { ignoreVary?: boolean; cacheName?: string }) { return undefined as TestResponse | undefined; },
  };
  const self = {
    location: { origin: "https://notes.example.test" },
    registration: { scope: "https://notes.example.test/native-notes/" },
    clients: { async matchAll() { return []; }, async claim() {} },
    addEventListener(type: string, listener: (event: any) => void) { handlers.set(type, listener); },
    skipWaiting() { /* no-op */ },
  };
  const context = { self, caches, URL, Request, Response: TestResponse, console, fetch: async (): Promise<Response> => { throw new Error("offline"); } };
  vm.runInNewContext(source, context);
  return { handlers, cache, caches, context };
}

describe("generated service worker contract", () => {
  it("keeps an independent offline copy of a fetched static asset", async () => {
    const { handlers, caches, cache, context } = await loadGeneratedServiceWorker();
    context.fetch = async () => new Response("online content");
    let openCache!: () => void;
    const delayed = new Promise<void>(resolve => { openCache = resolve; });
    caches.open = async () => { await delayed; return cache; };
    let cachedContent: string | undefined;
    cache.put = async (_request, copy) => { cachedContent = await copy.text(); };
    let served!: Promise<Response>;
    let written: Promise<void> | undefined;
    handlers.get("fetch")!({
      request: new TestRequest("https://notes.example.test/native-notes/resource", "cors"),
      respondWith(response: Promise<Response>) { served = response; },
      waitUntil(write: Promise<void>) { written = write; },
    });
    expect(await (await served).text()).toBe("online content");
    openCache();
    expect(written).toBeDefined();
    await written;
    expect(cachedContent).toBe("online content");
  });

  it("serves a precached module offline despite differing Origin request headers", async () => {
    const loaded = await loadGeneratedServiceWorker();
    const module = new TestResponse("export default true;");
    loaded.caches.match = async (_request, options) => options?.ignoreVary ? module : undefined;
    let response: Promise<TestResponse> | undefined;
    loaded.handlers.get("fetch")?.({
      request: new TestRequest("https://notes.example.test/native-notes/assets/index-test.js", "cors", { Origin: "https://notes.example.test" }),
      respondWith(value: Promise<TestResponse>) { response = value; },
    });
    await expect(response).resolves.toBe(module);
  });
  it("precaches the complete offline app shell, including WASM and worker assets", async () => {
    const { handlers, cache } = await loadGeneratedServiceWorker();
    let installPromise: Promise<unknown> | undefined;
    handlers.get("install")?.({ waitUntil(value: Promise<unknown>) { installPromise = value; } });
    await installPromise;
    expect([...cache.added].sort()).toEqual([...precache].sort());
    expect(cache.added.at(-1)).toBe("./index.html");
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

  it.each([
    ["/native-notes/", 503, true],
    ["/native-notes/index.html", 404, true],
    ["/native-notes/", 401, false],
    ["/native-notes/missing.pdf", 404, false],
  ] as const)("handles navigation to %s returning %i", async (path, status, fallback) => {
    const { handlers, caches, context } = await loadGeneratedServiceWorker();
    const shell = new TestResponse("offline shell");
    caches.match = async () => shell;
    const failure = new Response("error", { status });
    context.fetch = async () => failure;
    let served!: Promise<Response>;
    handlers.get("fetch")!({
      request: new TestRequest("https://notes.example.test" + path, "navigate"),
      respondWith(value: Promise<Response>) { served = value; },
    });
    await expect(served).resolves.toBe(fallback ? shell : failure);
  });

  it("retains a complete prior version for open tabs and claims clients only after cleanup", async () => {
    const { handlers, caches } = await loadGeneratedServiceWorker();
    const removed: string[] = [];
    const prefix = "notepad-static-%2Fnative-notes%2F:";
    const legacy = "notepad-static-123412341234";
    const foreignLegacy = "notepad-static-ffffffffffff";
    caches.keys = async () => [legacy, prefix + "previous", prefix + "interrupted", foreignLegacy, "unrelated"];
    caches.match = async (_url, options) => [legacy, prefix + "previous"].includes(options?.cacheName ?? "") ? new TestResponse("shell") : undefined;
    caches.delete = async (key: string) => { removed.push(key); return true; };
    let activation!: Promise<void>;
    handlers.get("activate")!({ waitUntil(value: Promise<void>) { activation = value; } });
    await activation;
    expect(removed).toEqual([legacy, prefix + "interrupted"]);
  });

  it("removes a partially downloaded build and rejects installation so the previous worker stays active", async () => {
    const { handlers, caches, cache } = await loadGeneratedServiceWorker();
    cache.addAll = async () => { throw new Error("network interrupted"); };
    const deleted: string[] = [];
    caches.delete = async (name: string) => { deleted.push(name); return true; };
    let install!: Promise<void>;
    handlers.get("install")!({ waitUntil(value: Promise<void>) { install = value; } });
    await expect(install).rejects.toThrow("network interrupted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/^notepad-static-%2Fnative-notes%2F:[a-f0-9]{12}$/);
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
