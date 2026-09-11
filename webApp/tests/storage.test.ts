import { describe, expect, it, vi } from "vitest";
import { createNotebook, createPage, PullChange, SyncOperation, toWirePayload } from "../src/models";
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
  it("validates imported pages before writing and persists a whole document in one transaction", async () => {
    const notebook = createNotebook("PDF import");
    const pages = [createPage(notebook.id), createPage(notebook.id)];
    pages.forEach((page, order) => { page.formatVersion = 2; page.order = order; });
    const saveNotebookRow = vi.fn(() => ({ status: "saved" }));
    const savePageRow = vi.fn(() => ({ status: "saved" }));
    const transaction = vi.fn(async (body: () => unknown) => body());
    const fake = { transaction, row: () => null, notebookFromRow: () => null, saveNotebookRow, savePageRow } as unknown as SQLiteNoteStoreEngine;
    await SQLiteNoteStoreEngine.prototype.importDocument.call(fake, notebook, pages);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(saveNotebookRow).toHaveBeenCalledTimes(1);
    expect(savePageRow).toHaveBeenCalledTimes(2);
    transaction.mockClear(); savePageRow.mockClear();
    await expect(SQLiteNoteStoreEngine.prototype.importDocument.call(fake, notebook, [pages[0]!, pages[0]!])).rejects.toThrow("Invalid imported pages");
    expect(transaction).not.toHaveBeenCalled();
    expect(savePageRow).not.toHaveBeenCalled();
    savePageRow.mockImplementation(() => { throw new Error("Disk full"); });
    await expect(SQLiteNoteStoreEngine.prototype.importDocument.call(fake, notebook, pages)).rejects.toThrow("Disk full");
  });
  it("saves and queues old local strokes with repaired timing while preserving their geometry", () => {
    const page = createPage(notebookID);
    page.id = pageID;
    page.strokes = [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", color: 0xff000000, width: 2, points: [0, 30, 10].map((time, x) => ({ x, y: x * 2, pressure: 0.5, time, tiltX: null, tiltY: null })) }];
    const queueOperation = vi.fn((operation: { payload: typeof page }) => {
      void operation;
      return "queued";
    });
    const fake = { db: { exec: vi.fn() }, row: vi.fn(() => null), pageFromRow: vi.fn(() => null), query: vi.fn(() => []), nextPageOrderDirect: vi.fn(() => 0), queueOperation } as unknown as SQLiteNoteStoreEngine;
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

  it.each(["page", "notebook"] as const)("keeps %s sync versions without making library entries or uploading copies", async entityType => {
    const operation = entityType === "page" ? pageOperation() : { ...pageOperation(), entityType, entityId: notebookID, payload: createNotebook("Notebook") as unknown as Record<string, unknown> };
    operation.payload.id = operation.entityId;
    let marked = false;
    const insertConflictDirect = vi.fn();
    const saveNotebookRow = vi.fn();
    const savePageRow = vi.fn();
    const fake = Object.assign(Object.create(SQLiteNoteStoreEngine.prototype), {
      transaction: async (body: () => unknown) => body(),
      query: (sql: string) => sql.includes("FROM metadata") && marked ? [{ value: "1" }] : [],
      insertConflictDirect, saveNotebookRow, savePageRow,
      db: { exec: (statement: { sql: string }) => { if (statement.sql.includes("INSERT INTO metadata")) marked = true; } },
    }) as SQLiteNoteStoreEngine;
    await fake.createConflictCopyFromOperation(operation);
    await fake.createConflictCopyFromOperation(operation);
    expect(insertConflictDirect).toHaveBeenCalledTimes(1);
    expect(insertConflictDirect).toHaveBeenCalledWith(entityType, operation.entityId, operation.payload, expect.any(String), 0);
    expect(saveNotebookRow).not.toHaveBeenCalled();
    expect(savePageRow).not.toHaveBeenCalled();
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

  it.each(["page", "notebook"] as const)("stores remote %s history without queuing new entities", entityType => {
    const queueOperation = vi.fn();
    const upsertNotebookDirect = vi.fn();
    const upsertPageDirect = vi.fn();
    const insert = vi.fn();
    const fake = { query: () => [], db: { exec: insert }, queueOperation, upsertNotebookDirect, upsertPageDirect };
    const method = (SQLiteNoteStoreEngine.prototype as unknown as { insertConflictDirect: (...args: unknown[]) => void }).insertConflictDirect;
    method.call(fake, entityType, pageID, pageOperation().payload, "Remote version", 7);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(queueOperation).not.toHaveBeenCalled();
    expect(upsertNotebookDirect).not.toHaveBeenCalled();
    expect(upsertPageDirect).not.toHaveBeenCalled();
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

  it("keeps notebook creation and state transitions ordered in the outbox", () => {
    const rows: Array<Record<string, unknown>> = [{ op_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", entity_type: "notebook", entity_id: notebookID, action: "upsert", base_revision: 0, state: "pending", rowid: 1, payload: "create" }];
    let nextRowID = 1;
    const dbExec = vi.fn((statement: { sql?: string; bind?: unknown[] }) => {
      const sql = statement.sql ?? "";
      const bind = statement.bind ?? [];
      if (sql.includes("INSERT INTO outbox")) {
        rows.push({ op_id: bind[0], entity_type: bind[1], entity_id: bind[2], action: bind[4], base_revision: bind[3], state: "pending", rowid: ++nextRowID, payload: bind[5] });
      } else if (sql.includes("UPDATE outbox SET payload")) {
        const row = rows.find((candidate) => candidate.op_id === bind[1]);
        if (row) row.payload = bind[0];
      }
    });
    const fake = {
      query: vi.fn((_sql: string, bind?: unknown[]) => [...rows]
        .filter((row) => !bind || (row.entity_type === bind[0] && row.entity_id === bind[1]))
        .sort((left, right) => Number(right.rowid) - Number(left.rowid))),
      db: { exec: dbExec },
    } as unknown as SQLiteNoteStoreEngine;
    const method = (SQLiteNoteStoreEngine.prototype as unknown as {
      queueOperation: (this: SQLiteNoteStoreEngine, operation: { entityType: "notebook" | "page"; entityId: string; baseRevision: number; action: "upsert" | "delete"; payload: Record<string, unknown> }) => string;
    }).queueOperation;
    const payload = { id: notebookID, title: "Notebook" };

    for (const [index, pageEntityID] of ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"].entries()) {
      method.call(fake, { entityType: "page", entityId: pageEntityID, baseRevision: 0, action: "upsert", payload: { id: pageEntityID, notebookId: notebookID, title: `Page ${index + 1}` } });
    }

    const deleteID = method.call(fake, { entityType: "notebook", entityId: notebookID, baseRevision: 0, action: "delete", payload });
    const restoreID = method.call(fake, { entityType: "notebook", entityId: notebookID, baseRevision: 0, action: "upsert", payload: { ...payload, deletedAt: null } });
    const finalDeleteID = method.call(fake, { entityType: "notebook", entityId: notebookID, baseRevision: 0, action: "delete", payload: { ...payload, deletedAt: "2026-01-01T00:00:00Z" } });
    expect(rows.map((row) => `${row.entity_type}:${row.action}`)).toEqual(["notebook:upsert", "page:upsert", "page:upsert", "page:upsert", "notebook:delete", "notebook:upsert", "notebook:delete"]);
    expect(rows.filter((row) => row.entity_type === "notebook").map((row) => row.base_revision)).toEqual([0, 0, 0, 0]);
    expect(new Set([deleteID, restoreID, finalDeleteID]).size).toBe(3);

    const sameDeleteID = method.call(fake, { entityType: "notebook", entityId: notebookID, baseRevision: 0, action: "delete", payload: { ...payload, deletedAt: "2026-01-02T00:00:00Z" } });
    expect(sameDeleteID).toBe(finalDeleteID);
    expect(rows).toHaveLength(7);

    rows.splice(0, rows.length, { op_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", entity_type: "notebook", entity_id: notebookID, action: "upsert", base_revision: 0, state: "sending", rowid: 1, payload: "immutable" });
    nextRowID = 1;
    const sendingID = method.call(fake, { entityType: "notebook", entityId: notebookID, baseRevision: 0, action: "upsert", payload });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ action: "upsert", base_revision: 0, state: "pending" });
    expect(rows[0]?.payload).toBe("immutable");
    expect(sendingID).not.toBe(rows[0]?.op_id);
  });

  it("preserves embedded images and conflict metadata through local validation", () => {
    const page = createPage(notebookID, "Image page");
    page.id = pageID;
    page.conflictOf = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    page.images = [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", src: "data:image/png;base64,AAAA", x: 10, y: 20, width: 300, height: 200 }];
    const queueOperation = vi.fn((operation: { payload: typeof page }) => {
      void operation;
      return "queued";
    });
    const dbExec = vi.fn();
    const fake = { db: { exec: dbExec }, row: vi.fn(() => null), pageFromRow: vi.fn(() => null), query: vi.fn(() => []), nextPageOrderDirect: vi.fn(() => 0), queueOperation } as unknown as SQLiteNoteStoreEngine;
    const method = (SQLiteNoteStoreEngine.prototype as unknown as { savePageRow: (this: SQLiteNoteStoreEngine, value: typeof page, queue: boolean) => unknown }).savePageRow;

    method.call(fake, page, true);
    const queued = queueOperation.mock.calls[0]![0] as { payload: typeof page };
    expect(queued.payload.images).toEqual(page.images);
    expect(queued.payload.conflictOf).toBe(page.conflictOf);
    expect(queued.payload.formatVersion).toBe(2);
    expect(() => method.call(fake, { ...page, images: [{ ...page.images![0]!, src: "data:image/svg+xml;base64,AAAA" }] }, true)).toThrow("Page image data is invalid");
    expect(dbExec).toHaveBeenCalled();
  });

  it("does not rewrite an old sending payload when validating a retry", () => {
    const page = createPage(notebookID, "Legacy");
    page.id = pageID;
    const raw = JSON.stringify({ ...page, images: undefined, order: undefined, conflictOf: undefined });
    const operationFromRow = (SQLiteNoteStoreEngine.prototype as unknown as { operationFromRow: (this: SQLiteNoteStoreEngine, row: Record<string, unknown>) => SyncOperation | null }).operationFromRow;
    const restored = operationFromRow.call({} as SQLiteNoteStoreEngine, {
      op_id: "33333333-3333-4333-8333-333333333333",
      entity_type: "page",
      entity_id: pageID,
      base_revision: 0,
      action: "upsert",
      payload: raw,
      created_at: page.updatedAt,
      state: "sending",
    });
    expect(restored).not.toBeNull();
    expect(JSON.stringify(toWirePayload(restored!))).toBe(raw);
  });

  it("appends new pages while preserving legacy order when an old page is edited", () => {
    const legacy = createPage(notebookID, "Page 1");
    legacy.id = pageID;
    legacy.order = undefined;
    const nextPageOrderDirect = vi.fn(() => 9);
    const dbExec = vi.fn();
    const row = vi.fn(() => ({ json: JSON.stringify(legacy), revision: legacy.revision }));
    const pageFromRow = vi.fn(() => legacy);
    const fake = {
      db: { exec: dbExec },
      row,
      pageFromRow,
      query: vi.fn(() => []),
      nextPageOrderDirect,
    } as unknown as SQLiteNoteStoreEngine;
    const method = (SQLiteNoteStoreEngine.prototype as unknown as { savePageRow: (this: SQLiteNoteStoreEngine, value: typeof legacy, queue: boolean) => unknown }).savePageRow;

    method.call(fake, { ...legacy, title: "Renamed" }, false);
    const edited = JSON.parse((dbExec.mock.calls[0]![0] as { bind: unknown[] }).bind[4] as string) as typeof legacy;
    expect(edited.order).toBeUndefined();
    expect(nextPageOrderDirect).not.toHaveBeenCalled();

    const fresh = createPage(notebookID, "Page 10");
    fresh.id = "66666666-6666-4666-8666-666666666666";
    row.mockReturnValue(null as never);
    pageFromRow.mockReturnValue(null as never);
    method.call(fake, fresh, false);
    const appended = JSON.parse((dbExec.mock.calls[1]![0] as { bind: unknown[] }).bind[4] as string) as typeof fresh;
    expect(appended.order).toBe(9);
    expect(appended.formatVersion).toBe(2);
  });

  it("sorts pages deterministically without renaming tied pages", async () => {
    const pages = [
      { ...createPage(notebookID, "Page 10"), id: "77777777-7777-4777-8777-777777777777", order: undefined },
      { ...createPage(notebookID, "Page 2"), id: "88888888-8888-4888-8888-888888888888", order: undefined },
      { ...createPage(notebookID, "Renamed"), id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", order: 2 },
      { ...createPage(notebookID, "Renamed again"), id: "99999999-9999-4999-8999-999999999999", order: 2 },
    ];
    const fake = {
      query: vi.fn(() => pages.map((page) => ({ page }))),
      pageFromRow: vi.fn((row: { page: typeof pages[number] }) => row.page),
    } as unknown as SQLiteNoteStoreEngine;
    const listed = await (SQLiteNoteStoreEngine.prototype.listPages.call(fake, notebookID));
    expect(listed.map((page) => page.id)).toEqual([
      "88888888-8888-4888-8888-888888888888",
      "77777777-7777-4777-8777-777777777777",
      "99999999-9999-4999-8999-999999999999",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ]);
  });

  it("keeps page images and order when importing an archive", async () => {
    const notebook = createNotebook("Archive notebook");
    const page = createPage(notebook.id, "Image page");
    page.formatVersion = 2;
    page.order = 3;
    page.images = [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", src: "data:image/png;base64,AAAA", x: 4, y: 8, width: 120, height: 90 }];
    const saveNotebookRow = vi.fn();
    const savePageRow = vi.fn();
    const fake = {
      accountKey: "guest",
      query: vi.fn(() => []),
      transaction: vi.fn(async (body: () => unknown) => body()),
      saveNotebookRow,
      savePageRow,
    } as unknown as SQLiteNoteStoreEngine;
    const imported = await SQLiteNoteStoreEngine.prototype.importArchive.call(fake, {
      version: 1,
      exportedAt: "2026-01-01T00:00:00Z",
      account: "guest",
      notebooks: [notebook],
      pages: [page],
    });
    expect(imported).toEqual({ notebooks: 1, pages: 1 });
    expect(savePageRow).toHaveBeenCalledWith(expect.objectContaining({
      formatVersion: 2,
      order: 3,
      images: page.images,
      conflictOf: undefined,
    }), true);
  });
});
