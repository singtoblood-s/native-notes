import { describe, expect, it, vi } from "vitest";
import { createNotebook, createPage, Notebook, PullChange, SyncOperation } from "../src/models";
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
    const fake = { db: { exec: vi.fn() }, row: vi.fn(() => null), pageFromRow: vi.fn(() => null), query: vi.fn(() => []), queueOperation } as unknown as SQLiteNoteStoreEngine;
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
    const transaction = vi.fn(async (body: () => unknown) => body());
    const saveNotebookRow = vi.fn();
    const savePageRow = vi.fn();
    const fake = Object.assign(Object.create(SQLiteNoteStoreEngine.prototype), {
      transaction,
      query: vi.fn(() => []),
      row: vi.fn(() => null),
      notebookFromRow: vi.fn(() => null),
      saveNotebookRow,
      savePageRow,
      db: { exec: vi.fn() },
    }) as unknown as SQLiteNoteStoreEngine;
    const method = (SQLiteNoteStoreEngine.prototype as unknown as {
      createConflictCopyFromOperation(this: SQLiteNoteStoreEngine, operation: SyncOperation, originalPageID?: string): Promise<void>;
    }).createConflictCopyFromOperation;

    await method.call(fake, pageOperation());

    expect(saveNotebookRow).toHaveBeenCalledWith(expect.objectContaining({ title: "Recovered page", revision: 0 }), true);
    const saveCall = (saveNotebookRow.mock.calls as unknown as Array<[{ id: string }, boolean]>)[0]!;
    const recoveredNotebookID = saveCall[0].id;
    expect(savePageRow).toHaveBeenCalledWith(expect.objectContaining({ notebookId: recoveredNotebookID }), false);
  });

  it("replays the same page conflict recovery without replacing an edited copy", async () => {
    const operation = pageOperation();
    const state: { marked: boolean; page: Record<string, unknown> | null } = { marked: false, page: null };
    const makeEngine = (): SQLiteNoteStoreEngine => Object.assign(Object.create(SQLiteNoteStoreEngine.prototype), {
      transaction: vi.fn(async (body: () => unknown) => body()),
      query: vi.fn((sql: string) => sql.includes("FROM metadata") && state.marked ? [{ value: "1" }] : []),
      row: vi.fn(() => null),
      notebookFromRow: vi.fn(() => null),
      saveNotebookRow: vi.fn(),
      savePageRow: vi.fn((page: Record<string, unknown>) => { state.page = page; }),
      db: { exec: vi.fn((statement: { sql?: string }) => { if (statement.sql?.includes("INSERT INTO metadata")) state.marked = true; }) },
    }) as unknown as SQLiteNoteStoreEngine;
    const method = (SQLiteNoteStoreEngine.prototype as unknown as {
      createConflictCopyFromOperation(this: SQLiteNoteStoreEngine, operation: SyncOperation, originalPageID?: string): Promise<void>;
    }).createConflictCopyFromOperation;

    await method.call(makeEngine(), operation);
    expect(state.page).toEqual(expect.objectContaining({ conflictOf: pageID }));
    const savedPage = state.page!;
    savedPage.title = "Edited recovery";
    await method.call(makeEngine(), operation);

    expect(state.page).toBe(savedPage);
    expect(state.page?.title).toBe("Edited recovery");
  });

  it("replays the same notebook conflict recovery without creating another parent", async () => {
    const notebook = createNotebook("Notebook conflict");
    notebook.id = notebookID;
    const operation: SyncOperation = {
      opId: "44444444-4444-4444-8444-444444444444",
      entityType: "notebook",
      entityId: notebookID,
      baseRevision: 1,
      action: "upsert",
      payload: notebook as unknown as Record<string, unknown>,
      createdAt: notebook.updatedAt,
      state: "sending",
    };
    const state = { marked: false, notebook: null as Notebook | null };
    const saveNotebookRow = vi.fn((value: Notebook) => { state.notebook = value; });
    const makeEngine = (): SQLiteNoteStoreEngine => Object.assign(Object.create(SQLiteNoteStoreEngine.prototype), {
      transaction: vi.fn(async (body: () => unknown) => body()),
      query: vi.fn((sql: string) => sql.includes("FROM metadata") && state.marked ? [{ value: "1" }] : []),
      saveNotebookRow,
      db: { exec: vi.fn((statement: { sql?: string }) => { if (statement.sql?.includes("INSERT INTO metadata")) state.marked = true; }) },
    }) as unknown as SQLiteNoteStoreEngine;
    const method = (SQLiteNoteStoreEngine.prototype as unknown as {
      createConflictCopyFromOperation(this: SQLiteNoteStoreEngine, operation: SyncOperation, originalPageID?: string): Promise<void>;
    }).createConflictCopyFromOperation;

    await method.call(makeEngine(), operation);
    expect(state.notebook).toEqual(expect.objectContaining({ title: "Notebook conflict · conflict", revision: 0 }));
    const savedNotebook = state.notebook!;
    savedNotebook.title = "Edited recovery notebook";
    await method.call(makeEngine(), operation);

    expect(saveNotebookRow).toHaveBeenCalledTimes(1);
    expect(state.notebook).toBe(savedNotebook);
    expect(state.notebook?.title).toBe("Edited recovery notebook");
  });

  it("does not repeat a sequence-less server conflict snapshot on retry", async () => {
    const original = pageOperation();
    const newer = { ...pageOperation(), opId: "55555555-5555-4555-8555-555555555555", state: "pending" as const };
    const state = { marked: false };
    const insertConflictDirect = vi.fn();
    const fake = Object.assign(Object.create(SQLiteNoteStoreEngine.prototype), {
      transaction: vi.fn(async (body: () => unknown) => body()),
      query: vi.fn((sql: string) => sql.includes("FROM metadata") && state.marked ? [{ value: "1" }] : []),
      pendingForEntityDirect: vi.fn(() => [newer]),
      insertConflictDirect,
      db: { exec: vi.fn((statement: { sql?: string }) => { if (statement.sql?.includes("INSERT INTO metadata")) state.marked = true; }) },
    }) as unknown as SQLiteNoteStoreEngine;
    const method = (SQLiteNoteStoreEngine.prototype as unknown as {
      applyServerSnapshot(this: SQLiteNoteStoreEngine, change: PullChange, operationID?: string): Promise<void>;
    }).applyServerSnapshot;
    const payload = { ...original.payload, revision: 2 };
    const change: PullChange = {
      sequence: 0,
      entityType: "page",
      entityId: pageID,
      revision: 2,
      action: "upsert",
      payload,
    };

    await method.call(fake, change, original.opId);
    await method.call(fake, change, original.opId);

    expect(insertConflictDirect).toHaveBeenCalledTimes(1);
  });

  it("queues a recovered parent when a remote conflict arrives during a local edit", () => {
    const queueOperation = vi.fn(() => "parent-operation");
    const upsertPageDirect = vi.fn();
    const fake = {
      db: { exec: vi.fn() },
      query: vi.fn(() => []),
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
      query: vi.fn(() => []),
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

  it("ignores an acknowledged server echo while a newer local edit is pending", () => {
    const current = createPage(notebookID, "First page");
    current.id = pageID;
    current.revision = 4;
    const pending = pageOperation();
    pending.baseRevision = current.revision;
    pending.state = "pending";
    const insertConflictDirect = vi.fn();
    const applySnapshotDirect = vi.fn();
    const fake = {
      row: vi.fn(() => ({ revision: current.revision, json: JSON.stringify(current) })),
      pendingForEntityDirect: vi.fn(() => [pending]),
      insertConflictDirect,
      applySnapshotDirect,
    } as unknown as SQLiteNoteStoreEngine;
    const method = (SQLiteNoteStoreEngine.prototype as unknown as {
      applyRemoteDirect(this: SQLiteNoteStoreEngine, change: PullChange): void;
    }).applyRemoteDirect;

    method.call(fake, {
      sequence: 9,
      entityType: "page",
      entityId: pageID,
      revision: current.revision,
      action: "upsert",
      payload: current as unknown as Record<string, unknown>,
    });

    expect(insertConflictDirect).not.toHaveBeenCalled();
    expect(applySnapshotDirect).not.toHaveBeenCalled();
  });

  it("keeps a newer remote edit as a conflict while local work is pending", () => {
    const current = createPage(notebookID, "First page");
    current.id = pageID;
    current.revision = 4;
    const pending = pageOperation();
    pending.baseRevision = current.revision;
    pending.state = "pending";
    const insertConflictDirect = vi.fn();
    const fake = {
      row: vi.fn(() => ({ revision: current.revision, json: JSON.stringify(current) })),
      pendingForEntityDirect: vi.fn(() => [pending]),
      insertConflictDirect,
      applySnapshotDirect: vi.fn(),
    } as unknown as SQLiteNoteStoreEngine;
    const method = (SQLiteNoteStoreEngine.prototype as unknown as {
      applyRemoteDirect(this: SQLiteNoteStoreEngine, change: PullChange): void;
    }).applyRemoteDirect;
    const remote = { ...current, revision: current.revision + 1, text: "Remote edit" };

    method.call(fake, {
      sequence: 10,
      entityType: "page",
      entityId: pageID,
      revision: remote.revision,
      action: "upsert",
      payload: remote as unknown as Record<string, unknown>,
    });

    expect(insertConflictDirect).toHaveBeenCalledWith("page", pageID, remote, "remote update while local edit is pending", 10);
  });

  it("does not create a second conflict copy when the same pull sequence is retried", () => {
    const insert = vi.fn();
    const fake = {
      db: { exec: insert },
      query: vi.fn(() => [{ id: "existing-conflict" }]),
      upsertPageDirect: vi.fn(),
      upsertNotebookDirect: vi.fn(),
      notebookFromRow: vi.fn(() => null),
    } as unknown as SQLiteNoteStoreEngine;
    const method = (SQLiteNoteStoreEngine.prototype as unknown as {
      insertConflictDirect(this: SQLiteNoteStoreEngine, entityType: "page" | "notebook", entityID: string, payload: Record<string, unknown>, reason: string, sequence: number): void;
    }).insertConflictDirect;

    method.call(fake, "page", pageID, pageOperation().payload, "remote update while local edit is pending", 10);

    expect(insert).not.toHaveBeenCalled();
  });
});
