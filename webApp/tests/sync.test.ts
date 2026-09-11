import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthResponse, PullChange, SyncOperation } from "../src/models";
import { NoteStore } from "../src/storage";
import { SyncClient, selectPushBatch } from "../src/sync";

const notebookID = "11111111-1111-4111-8111-111111111111";
const operationID = "33333333-3333-4333-8333-333333333333";
const secondOperationID = "44444444-4444-4444-8444-444444444444";
const session: AuthResponse = {
  user: { id: "55555555-5555-4555-8555-555555555555", identifier: "tester@example.test" },
  sessionToken: "opaque-test-token",
  expiresAt: "2099-01-01T00:00:00Z",
};

function operation(opId: string, entityId = notebookID): SyncOperation {
  return {
    opId,
    entityType: "notebook",
    entityId,
    baseRevision: 0,
    action: "upsert",
    payload: { id: entityId, title: "Notebook", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", deletedAt: null, revision: 0 },
    createdAt: "2026-01-01T00:00:00Z",
    state: "pending",
  };
}

function fakeStore(initial: SyncOperation[], initialCursor = 0): { store: NoteStore; cursor: () => number; sent: SyncOperation[]; pulled: PullChange[][]; events: string[] } {
  const outbox = new Map(initial.map((item) => [item.opId, structuredClone(item)]));
  let currentCursor = initialCursor;
  const sent: SyncOperation[] = [];
  const pulled: PullChange[][] = [];
  const events: string[] = [];
  const store = {
    accountKey: "https://sync.example.test:55555555-5555-4555-8555-555555555555",
    persistence: "indexeddb" as const,
    pendingOperations: vi.fn(async (limit = 100) => [...outbox.values()].slice(0, limit)),
    getOperation: vi.fn(async (opId: string) => outbox.get(opId) ?? null),
    markOperationSending: vi.fn(async (opId: string) => { const item = outbox.get(opId); if (item) { item.state = "sending"; sent.push(structuredClone(item)); } }),
    markOperationAcked: vi.fn(async (opId: string) => { events.push("ack"); outbox.delete(opId); }),
    markOperationPending: vi.fn(async (opId: string) => { const item = outbox.get(opId); if (item) item.state = "pending"; }),
    createConflictCopyFromOperation: vi.fn(async () => { events.push("copy"); }),
    applyServerSnapshot: vi.fn(async () => { events.push("server"); }),
    applyRemoteBatch: vi.fn(async (changes: PullChange[], nextCursor: number) => { pulled.push(changes); currentCursor = nextCursor; }),
    getCursor: vi.fn(async () => currentCursor),
    setCursor: vi.fn(async (next: number) => { currentCursor = next; }),
    listConflicts: vi.fn(async () => []),
  } as unknown as NoteStore;
  return { store, cursor: () => currentCursor, sent, pulled, events };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("sync durability protocol", () => {
  it("leaves the local cursor to pull even when push reports a higher cursor", async () => {
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const fake = fakeStore([operation(operationID)]);
    const change: PullChange = {
      sequence: 7,
      entityType: "notebook",
      entityId: notebookID,
      revision: 1,
      action: "upsert",
      payload: { id: notebookID, title: "Notebook", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", deletedAt: null, revision: 1 },
    };
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      if (String(input).includes("/push")) return new Response(JSON.stringify({ results: [{ opId: operationID, status: "acked", revision: 1, sequence: 7, serverPayload: null, code: null }], cursor: 99 }), { status: 200 });
      return new Response(JSON.stringify({ changes: [change], nextCursor: 7, hasMore: false }), { status: 200 });
    }));

    const report = await new SyncClient().sync(fake.store, session);
    expect(report).toEqual({ pushed: 1, pulled: 1, conflicts: 0 });
    expect(requests[1]).toContain("cursor=0");
    expect(fake.cursor()).toBe(7);
    expect(fake.store.applyRemoteBatch).toHaveBeenCalledWith([change], 7);
  });

  it("retries a sending operation with its original opId after a failed request", async () => {
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const fake = fakeStore([operation(operationID)]);
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/push")) {
        attempts += 1;
        if (attempts === 1) throw new TypeError("offline");
        return new Response(JSON.stringify({ results: [{ opId: operationID, status: "acked", revision: 1, sequence: 1, serverPayload: null, code: null }], cursor: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ changes: [], nextCursor: 1, hasMore: false }), { status: 200 });
    }));

    await expect(new SyncClient().sync(fake.store, session)).rejects.toThrow("Network unavailable");
    await new SyncClient().sync(fake.store, session);
    expect(fake.sent.map((item) => item.opId)).toEqual([operationID, operationID]);
  });

  it("sends at most one queued revision for an entity in a batch", () => {
    const selected = selectPushBatch([operation(operationID), operation(secondOperationID, notebookID)]);
    expect(selected.map((item) => item.opId)).toEqual([operationID]);
  });

  it("applies a conflict snapshot before acknowledging the rejected local edit", async () => {
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const fake = fakeStore([operation(operationID)]);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/push")) return new Response(JSON.stringify({
        results: [{ opId: operationID, status: "conflict", revision: 2, sequence: null, serverPayload: { id: notebookID, title: "Server copy", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", deletedAt: null, revision: 2 }, code: "revision_conflict" }],
        cursor: 2,
      }), { status: 200 });
      return new Response(JSON.stringify({ changes: [], nextCursor: 0, hasMore: false }), { status: 200 });
    }));

    const report = await new SyncClient().sync(fake.store, session);
    expect(fake.events).toEqual(["copy", "server", "ack"]);
    expect(report.conflicts).toBe(1);
  });

  it("uses an explicit cursor reset after the server expires a cursor", async () => {
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const fake = fakeStore([], 12);
    let pulls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/push")) return new Response(JSON.stringify({ results: [], cursor: 12 }), { status: 200 });
      pulls += 1;
      if (pulls === 1) return new Response(JSON.stringify({ error: { code: "cursor_expired", message: "Full sync required" } }), { status: 409 });
      return new Response(JSON.stringify({ changes: [], nextCursor: 0, hasMore: false }), { status: 200 });
    }));

    await new SyncClient().sync(fake.store, session);
    expect(fake.store.setCursor).toHaveBeenCalledWith(0);
    expect(fake.cursor()).toBe(0);
  });
});
