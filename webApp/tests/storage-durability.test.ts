import { createRequire } from "node:module";
import type { DatabaseSync as Database, SQLInputValue } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { SQLiteNoteStoreEngine } from "../src/storage";
import { createNotebook, createPage, type AuthResponse, type PullChange, type PushResult, type SyncOperation } from "../src/models";
import { SyncClient } from "../src/sync";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const databases: Database[] = [];
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); databases.splice(0).forEach(db => db.close()); });

function openEngine() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  const engine = Object.assign(Object.create(SQLiteNoteStoreEngine.prototype), {
    db: { exec: (request: string | { sql: string; bind?: SQLInputValue[]; returnValue?: string }) => {
      if (typeof request === "string") return db.exec(request);
      const statement = db.prepare(request.sql);
      return request.returnValue === "resultRows" ? statement.all(...(request.bind ?? [])) : statement.run(...(request.bind ?? []));
    } },
    accountKey: "test", persistence: "opfs", writeQueue: Promise.resolve(),
  }) as SQLiteNoteStoreEngine & { initializeSchema(): void };
  // Exercise production SQL and transactions using Node's bundled SQLite.
  const internal = engine as unknown as { initializeSchema(): void };
  internal.initializeSchema();
  return { engine: engine as SQLiteNoteStoreEngine, db };
}

it("preserves parent/child and delete/restore ordering when the device clock moves backward", async () => {
  vi.useFakeTimers();
  const { engine } = openEngine();
  vi.setSystemTime(new Date("2026-09-11T12:00:00Z"));
  const book = createNotebook("Clock drift"); await engine.saveNotebook(book);
  vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
  const page = createPage(book.id); await engine.savePage(page);
  await engine.deletePage(page.id);
  vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
  await engine.restorePage(page.id);
  const queued = await engine.pendingOperations();
  expect(queued.map(op => [op.entityType, op.action])).toEqual([["notebook", "upsert"], ["page", "upsert"], ["page", "delete"], ["page", "upsert"]]);
  await engine.markOperationSending(queued[1]!.opId);
  const latest = (await engine.getPage(page.id))!;
  await engine.savePage({ ...latest, text: "Newest text" });
  expect((await engine.pendingOperations())[1]!.payload.text).toBe("");
  expect((await engine.pendingOperations()).at(-1)!.payload.text).toBe("Newest text");
});

it("keeps a rejected page recoverable across reopen without automatically uploading it again", async () => {
  const { engine } = openEngine();
  const book = createNotebook("Server deleted this book"); await engine.saveNotebook(book);
  const page = createPage(book.id); page.text = "Offline handwriting and text"; await engine.savePage(page);
  const rejected = (await engine.pendingOperations()).find(op => op.entityType === "page")!;
  await engine.createConflictCopyFromOperation(rejected, page.id, false);
  await engine.createConflictCopyFromOperation(rejected, page.id, false);
  await engine.markOperationAcked(rejected.opId, undefined, false);
  expect(await engine.listNotebooks()).toHaveLength(1);
  expect(await engine.listPages(book.id)).toHaveLength(1);
  expect(await engine.listConflicts()).toHaveLength(1);
  expect((await engine.listConflicts())[0]!.payload.text).toBe(page.text);
  expect((await engine.pendingOperations()).every(op => op.entityType === "notebook")).toBe(true);
  const archive = await engine.exportArchive();
  expect(archive.versions).toHaveLength(1);
  const restored = openEngine().engine;
  await restored.importArchive(archive);
  expect((await restored.listConflicts())[0]!.payload.text).toBe(page.text);

});

it("rolls back recovery completely if durable SQL fails, leaving the original queued", async () => {
  const { engine, db } = openEngine();
  const book = createNotebook("Rollback"); await engine.saveNotebook(book);
  const page = createPage(book.id); await engine.savePage(page);
  const operation = (await engine.pendingOperations()).at(-1)!;
  db.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON metadata WHEN NEW.key LIKE 'conflict-recovery:%' BEGIN SELECT RAISE(ABORT, 'Disk full'); END");
  await expect(engine.createConflictCopyFromOperation(operation, page.id, false)).rejects.toThrow("Disk full");
  expect(await engine.listNotebooks()).toHaveLength(1);
  expect(await engine.listPages(book.id)).toHaveLength(1);
  expect(await engine.getOperation(operation.opId)).not.toBeNull();
});

it("queues a local recovery notebook before its first child edit", async () => {
  const { engine } = openEngine();
  const book = createNotebook("Recovered notebook"); await engine.saveNotebook(book, false);
  await engine.savePage(createPage(book.id));
  expect((await engine.pendingOperations()).map(op => op.entityType)).toEqual(["notebook", "page"]);
});

it("applies an authoritative conflict snapshot after the server restores an older revision", async () => {
  const { engine } = openEngine();
  const book = createNotebook("Server restore"); await engine.saveNotebook(book);
  const page = createPage(book.id); page.revision = 5; page.text = "Offline copy";
  await engine.savePage(page);
  const operation = (await engine.pendingOperations()).at(-1)!;
  await engine.createConflictCopyFromOperation(operation);
  await engine.applyServerSnapshot({ sequence: 0, entityType: "page", entityId: page.id, revision: 2, action: "upsert", payload: { ...page, revision: 2, text: "Restored server version" } }, operation.opId);
  await engine.markOperationAcked(operation.opId, 2);
  expect(await engine.getPage(page.id)).toMatchObject({ revision: 2, text: "Restored server version" });
  expect((await engine.listConflicts()).some(item => item.entityId === page.id && item.payload.text === "Offline copy")).toBe(true);
  expect(await engine.listPages(book.id)).toHaveLength(1);
});

it("moves only settled empty generated notebooks to Trash, keeps content, and allows restoration", async () => {
  const { engine } = openEngine();
  const books = Array.from({ length: 20 }, () => ({ ...createNotebook("My notebook · conflict"), revision: 2 }));
  for (const book of books) await engine.saveNotebook(book, false);
  const withPage = { ...createNotebook("Actual work · conflict"), revision: 2 };
  await engine.saveNotebook(withPage, false);
  const trashedPage = { ...createPage(withPage.id), deletedAt: new Date().toISOString() };
  await engine.savePage(trashedPage, false);
  const edited = { ...createNotebook("User edit · conflict"), revision: 2 };
  await engine.saveNotebook(edited);
  const ordinary = { ...createNotebook("My notebook"), revision: 2 };
  await engine.saveNotebook(ordinary, false);
  expect(await engine.archiveEmptyConflictNotebooks()).toBe(20);
  expect(await engine.listNotebooks()).toHaveLength(3);
  expect(await engine.listNotebooks(true)).toHaveLength(23);
  expect(await engine.getPage(trashedPage.id)).not.toBeNull();
  expect(await engine.archiveEmptyConflictNotebooks()).toBe(0);
  const first = books[0]!;
  await engine.restoreNotebook(first.id);
  expect(await engine.archiveEmptyConflictNotebooks()).toBe(0);
  expect(await engine.getNotebook(first.id)).toMatchObject({ title: "My notebook", deletedAt: null });
  const anotherDevice = openEngine().engine;
  await anotherDevice.saveNotebook((await engine.getNotebook(first.id))!, false);
  expect(await anotherDevice.archiveEmptyConflictNotebooks()).toBe(0);
});

it("two offline devices converge without creating notebook or page IDs during repeated conflicts", async () => {
  const session: AuthResponse = { user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", identifier: "QA" }, sessionToken: "QA", expiresAt: "2099-01-01T00:00:00Z" };
  const endpoint = "https://sync.example.test";
  localStorage.setItem("notepad.endpoint", endpoint);
  const a = openEngine().engine, b = openEngine().engine;
  for (const store of [a, b]) Object.defineProperty(store, "accountKey", { value: `${endpoint}:${session.user.id}` });
  const documents = new Map<string, PullChange>();
  const receipts = new Map<string, PushResult>();
  const changes: PullChange[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    if (!String(input).includes("/push")) {
      const cursor = Number(new URL(String(input)).searchParams.get("cursor"));
      return new Response(JSON.stringify({ changes: changes.filter(change => change.sequence > cursor), nextCursor: changes.length, hasMore: false }));
    }
    const operations = JSON.parse(String(init.body)).operations as SyncOperation[];
    const results = operations.map(operation => {
      const receipt = receipts.get(operation.opId); if (receipt) return receipt;
      const key = `${operation.entityType}:${operation.entityId}`;
      const current = documents.get(key);
      const revision = current?.revision ?? 0;
      let result: PushResult;
      if (operation.baseRevision !== revision) result = { opId: operation.opId, status: "conflict", revision, serverPayload: current?.payload ?? null };
      else {
        const change: PullChange = { sequence: changes.length + 1, entityId: operation.entityId, entityType: operation.entityType, action: operation.action, revision: revision + 1, payload: { ...operation.payload, revision: revision + 1 } };
        documents.set(key, change); changes.push(change);
        result = { opId: operation.opId, status: "acked", revision: change.revision };
      }
      receipts.set(operation.opId, result); return result;
    });
    return new Response(JSON.stringify({ results, cursor: changes.length }));
  }));
  const client = new SyncClient();
  const book = createNotebook("Shared notes"), page = createPage(book.id);
  await a.saveNotebook(book); await a.savePage(page);
  await client.sync(a, session); await client.sync(b, session);
  for (let round = 0; round < 3; round++) {
    await a.saveNotebook({ ...(await a.getNotebook(book.id))!, title: `A ${round}` });
    await b.saveNotebook({ ...(await b.getNotebook(book.id))!, title: `B ${round}` });
    await a.savePage({ ...(await a.getPage(page.id))!, text: `A text ${round}` });
    await b.savePage({ ...(await b.getPage(page.id))!, text: `B text ${round}` });
    await client.sync(a, session); await client.sync(b, session); await client.sync(a, session);
    expect(await b.getNotebook(book.id)).toEqual(await a.getNotebook(book.id));
    expect(await b.getPage(page.id)).toEqual(await a.getPage(page.id));
    expect(await b.listNotebooks(true)).toHaveLength(1);
    expect(await b.listPages(book.id, true)).toHaveLength(1);
    expect(await b.pendingOperations()).toHaveLength(0);
  }
  const versionCount = (await b.listConflicts()).length;
  await client.sync(b, session); await client.sync(a, session);
  expect(await b.listConflicts()).toHaveLength(versionCount);
  expect((await b.listConflicts()).some(version => version.payload.text === "B text 2")).toBe(true);
  expect(documents.size).toBe(2);
});
