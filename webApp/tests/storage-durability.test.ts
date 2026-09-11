import { createRequire } from "node:module";
import type { DatabaseSync as Database, SQLInputValue } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { SQLiteNoteStoreEngine } from "../src/storage";
import { createNotebook, createPage } from "../src/models";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const databases: Database[] = [];
afterEach(() => { vi.useRealTimers(); databases.splice(0).forEach(db => db.close()); });

function openEngine() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  const engine = Object.assign(Object.create(SQLiteNoteStoreEngine.prototype), {
    db: { exec: (request: string | { sql: string; bind?: SQLInputValue[]; returnValue?: string }) => {
      if (typeof request === "string") return db.exec(request);
      const statement = db.prepare(request.sql);
      return request.returnValue === "resultRows" ? statement.all(...(request.bind ?? [])) : statement.run(...(request.bind ?? []));
    } },
    accountKey: "test", persistence: "opfs", writeQueue: Promise.resolve(),
  }) as SQLiteNoteStoreEngine & { initializeSchema(): void; migrateUnqueuedConflictCopies(): boolean };
  // Exercise production SQL and transactions using Node's bundled SQLite.
  const internal = engine as unknown as { initializeSchema(): void; migrateUnqueuedConflictCopies(): boolean };
  internal.initializeSchema();
  return { engine: engine as SQLiteNoteStoreEngine, db, migrate: () => internal.migrateUnqueuedConflictCopies() };
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
  const { engine, migrate } = openEngine();
  const book = createNotebook("Server deleted this book"); await engine.saveNotebook(book);
  const page = createPage(book.id); page.text = "Offline handwriting and text"; await engine.savePage(page);
  const rejected = (await engine.pendingOperations()).find(op => op.entityType === "page")!;
  await engine.createConflictCopyFromOperation(rejected, page.id, false);
  await engine.createConflictCopyFromOperation(rejected, page.id, false);
  await engine.markOperationAcked(rejected.opId, undefined, false);
  const books = await engine.listNotebooks();
  expect(books).toHaveLength(2);
  const recoveredBook = books.find(item => item.id !== book.id)!;
  const copies = await engine.listPages(recoveredBook.id);
  expect(copies).toHaveLength(1);
  expect(copies[0]).toMatchObject({ text: page.text, conflictOf: page.id });
  expect((await engine.pendingOperations()).every(op => op.entityType === "notebook")).toBe(true);
  expect(migrate()).toBe(false);
  const archive = await engine.exportArchive();
  expect(archive.pages.some(item => item.id === copies[0]!.id)).toBe(true);
  await engine.savePage({ ...copies[0]!, conflictOf: undefined });
  const queue = await engine.pendingOperations();
  expect(queue.at(-1)).toMatchObject({ entityType: "page", entityId: copies[0]!.id });
  expect(queue.findIndex(op => op.entityId === recoveredBook.id)).toBeLessThan(queue.length - 1);
});

it("rolls back recovery completely if durable SQL fails, leaving the original queued", async () => {
  const { engine, db } = openEngine();
  const book = createNotebook("Rollback"); await engine.saveNotebook(book);
  const page = createPage(book.id); await engine.savePage(page);
  const operation = (await engine.pendingOperations()).at(-1)!;
  db.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON metadata WHEN NEW.key LIKE 'local-recovery:%' BEGIN SELECT RAISE(ABORT, 'Disk full'); END");
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
  expect((await engine.listPages(book.id)).some(item => item.conflictOf === page.id && item.text === "Offline copy")).toBe(true);
});
