import { describe, expect, it, vi } from "vitest";
import { createNotebook, createPage, SyncOperation } from "../src/models";
import { SQLiteNoteStoreEngine } from "../src/storage";

const pageID = "11111111-1111-4111-8111-111111111111";
const notebookID = "22222222-2222-4222-8222-222222222222";

function pageOperation() : SyncOperation {
  const page = createPage(notebookID, "Offline page");
  page.id = pageID;
  return {
    opId: "33333333-3333-4333-8333-333333333333",
    entityType: "page",
    entityId: page.id,
    baseRevision: 1,
    action: "upsert",
    payload: page as unknown as Record<string, unknown>,
    createdAt: page.updatedAt,
    state: "sending",
  };
}

describe("conflict recovery storage", () => {
  it("saves and queues old local strokes with repaired timing while preserving their geometry", () => {
    const page = createPage(notebookID);
    page.id = pageID;
    page.strokes = [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", color: 0xff000000, width: 2, points: [0, 30, 10].map((time, x) => ({ x, y: x * 2, pressure: 0.5, time, tiltX: null, tiltY: null })) }];
    const queueOperation = vi.fn(() => "queued");
    const fake = { db: { exec: vi.fn() }, row: vi.fn(() => null), pageFromRow: vi.fn(() => null), queueOperation } as unknown as SQLiteNoteStoreEngine;
    const method = (SQLiteNoteStoreEngine.prototype as unknown as {
      savePageRow: (this: SQLiteNoteStoreEngine, value: typeof page, queue: boolean) => unknown;
    }).savePageRow;
    expect(method.call(fake, page, true)).toMatchObject({ status: "saved", operationId: "queued" });
    const queued = (queueOperation.mock.calls as unknown as Array<[{ payload: typeof page }]>)[0]![0].payload;
    expect(queued.strokes[0]!.points).toEqual(page.strokes[0]!.points.map((point) => ({ ...point, time: point.x === 2 ? 30 : point.time })));
    expect(page.strokes[0]!.points[2]!.time).toBe(10);
    page.strokes[0]!.points[0]!.pressure = 2;
    expect(() => method.call(fake, page, true)).toThrow("Stroke point values are invalid");
  });

  it("queues a missing parent before creating a recovered page", async () => {
    const saveNotebook = vi.fn(async () => ({ status: "saved" as const, revision: 0 }));
    const createConflictCopy = vi.fn(async () => undefined);
    const fake = {
      getNotebook: vi.fn(async () => null),
      saveNotebook,
      createConflictCopy,
    } as unknown as SQLiteNoteStoreEngine;
    const method = (SQLiteNoteStoreEngine.prototype as unknown as {
      createConflictCopyFromOperation(this: SQLiteNoteStoreEngine, operation: SyncOperation, originalPageID?: string): Promise<void>;
    }).createConflictCopyFromOperation;

    await method.call(fake, pageOperation());

    expect(saveNotebook).toHaveBeenCalledWith(expect.objectContaining({ title: "Recovered page", revision: 0 }), true);
    const saveCall = (saveNotebook.mock.calls as unknown as Array<[{ id: string }, boolean]>)[0]!;
    const recoveredNotebookID = saveCall[0].id;
    expect(createConflictCopy).toHaveBeenCalledWith(expect.objectContaining({ notebookId: recoveredNotebookID }), pageID);
  });

  it("queues a recovered parent when a remote conflict arrives during a local edit", () => {
    const queueOperation = vi.fn(() => "parent-operation");
    const upsertPageDirect = vi.fn();
    const fake = {
      db: { exec: vi.fn() },
      row: vi.fn(() => null),
      notebookFromRow: vi.fn(() => null),
      upsertNotebookDirect: vi.fn(),
      upsertPageDirect,
      queueOperation,
    } as unknown as SQLiteNoteStoreEngine;
    const method = (SQLiteNoteStoreEngine.prototype as unknown as {
      insertConflictDirect(this: SQLiteNoteStoreEngine, entityType: "page" | "notebook", entityID: string, payload: Record<string, unknown>, reason: string, sequence: number): void;
    }).insertConflictDirect;

    const page = pageOperation().payload;
    method.call(fake, "page", pageID, page, "remote update while local edit is pending", 7);

    const parentCall = (queueOperation.mock.calls as unknown as Array<[{ entityType: string; entityId: string; baseRevision: number; action: string; payload: { id: string } }]>)[0]!;
    const parent = parentCall[0];
    expect(parent).toMatchObject({ entityType: "notebook", baseRevision: 0, action: "upsert" });
    expect(parent.entityId).toBe(parent.payload.id);
    const recoveredPage = (upsertPageDirect.mock.calls as unknown as Array<[{ notebookId: string }]>)[0]![0];
    expect(recoveredPage.notebookId).toBe(parent.entityId);
  });

  it("queues a recovered notebook conflict copy before it can own new pages", () => {
    const queueOperation = vi.fn(() => "notebook-operation");
    const upsertNotebookDirect = vi.fn();
    const fake = {
      db: { exec: vi.fn() },
      upsertNotebookDirect,
      queueOperation,
    } as unknown as SQLiteNoteStoreEngine;
    const method = (SQLiteNoteStoreEngine.prototype as unknown as {
      insertConflictDirect(this: SQLiteNoteStoreEngine, entityType: "page" | "notebook", entityID: string, payload: Record<string, unknown>, reason: string, sequence: number): void;
    }).insertConflictDirect;
    const notebook = createNotebook("Notebook conflict");
    notebook.id = notebookID;

    method.call(fake, "notebook", notebookID, notebook as unknown as Record<string, unknown>, "remote update while local edit is pending", 8);

    expect(upsertNotebookDirect).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String), revision: 0, deletedAt: null }));
    const operationCall = (queueOperation.mock.calls as unknown as Array<[{ entityType: string; entityId: string; baseRevision: number; action: string; payload: { id: string } }]>)[0]!;
    const operation = operationCall[0];
    expect(operation).toMatchObject({ entityType: "notebook", baseRevision: 0, action: "upsert" });
    expect(operation.entityId).toBe(operation.payload.id);
  });
});
