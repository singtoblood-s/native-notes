import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthResponse, ConflictCopy, PullChange, SyncOperation, toWirePayload } from "../src/models";
import { NoteStore } from "../src/storage";
import { SyncClient, selectPushBatch } from "../src/sync";

const notebookID = "11111111-1111-4111-8111-111111111111";
const pageID = "22222222-2222-4222-8222-222222222222";
const strokeID = "77777777-7777-4777-8777-777777777777";
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

function inkOperation(opId: string, points: number): SyncOperation {
  return {
    ...operation(opId, pageID),
    entityType: "page",
    payload: {
      id: pageID,
      notebookId: notebookID,
      title: "Ink",
      text: "",
      background: "blank",
      width: 1024,
      height: 1366,
      strokes: [{
        id: strokeID,
        color: 0xff1b1b1f,
        width: 2.5,
        points: Array.from({ length: points }, (_, index) => ({
          x: index % 1000,
          y: Math.floor(index / 1000),
          pressure: 0.5,
          time: index,
          tiltX: null,
          tiltY: null,
        })),
      }],
      formatVersion: 1,
      revision: 0,
      updatedAt: "2026-01-01T00:00:00Z",
      deletedAt: null,
    },
  };
}

function fakeStore(initial: SyncOperation[], initialCursor = 0): { store: NoteStore; cursor: () => number; sent: SyncOperation[]; pulled: PullChange[][]; events: string[]; remaining: () => SyncOperation[] } {
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
  return { store, cursor: () => currentCursor, sent, pulled, events, remaining: () => [...outbox.values()] };
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
    expect(requests[1]).toContain("limit=100");
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

  it("reports changes applied before a later pull page failed", async () => {
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const fake = fakeStore([]);
    const change: PullChange = {
      sequence: 1,
      entityType: "notebook",
      entityId: notebookID,
      revision: 1,
      action: "upsert",
      payload: { id: notebookID, title: "Notebook", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", deletedAt: null, revision: 1 },
    };
    let pulls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/push")) return new Response(JSON.stringify({ results: [], cursor: 0 }), { status: 200 });
      pulls += 1;
      if (pulls === 1) return new Response(JSON.stringify({ changes: [change], nextCursor: 1, hasMore: true }), { status: 200 });
      if (pulls === 2) throw new TypeError("offline");
      return new Response(JSON.stringify({ changes: [], nextCursor: 1, hasMore: false }), { status: 200 });
    }));

    const client = new SyncClient();
    await expect(client.sync(fake.store, session)).rejects.toThrow("Network unavailable");
    const report = await client.sync(fake.store, session);

    expect(report.pulled).toBe(1);
    expect(fake.store.applyRemoteBatch).toHaveBeenCalledWith([change], 1);
  });

  it("does not turn historical conflict rows into a new sync conflict", async () => {
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const fake = fakeStore([]);
    fake.store.listConflicts = vi.fn(async (): Promise<ConflictCopy[]> => [{
      id: "99999999-9999-4999-8999-999999999999",
      entityType: "page",
      entityId: pageID,
      payload: {},
      createdAt: "2026-01-01T00:00:00Z",
      reason: "historical recovery",
    }]);
    const change: PullChange = {
      sequence: 1,
      entityType: "notebook",
      entityId: notebookID,
      revision: 1,
      action: "upsert",
      payload: { id: notebookID, title: "Notebook", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", deletedAt: null, revision: 1 },
    };
    let pulls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/push")) return new Response(JSON.stringify({ results: [], cursor: 0 }), { status: 200 });
      pulls += 1;
      if (pulls === 1) return new Response(JSON.stringify({ changes: [change], nextCursor: 1, hasMore: false }), { status: 200 });
      return new Response(JSON.stringify({ changes: [], nextCursor: 1, hasMore: false }), { status: 200 });
    }));

    const client = new SyncClient();
    const report = await client.sync(fake.store, session);

    expect(report.pulled).toBe(1);
    expect(report.conflicts).toBe(0);
    expect(fake.store.listConflicts).not.toHaveBeenCalled();

    const secondReport = await client.sync(fake.store, session);
    expect(secondReport).toEqual({ pushed: 0, pulled: 0, conflicts: 0 });
  });

  it("does not carry a partial pull count into another account store", async () => {
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const first = fakeStore([]);
    const second = fakeStore([]);
    const secondUserID = "66666666-6666-4666-8666-666666666666";
    Object.defineProperty(second.store, "accountKey", { value: `https://sync.example.test:${secondUserID}`, configurable: true });
    const change: PullChange = {
      sequence: 1,
      entityType: "notebook",
      entityId: notebookID,
      revision: 1,
      action: "upsert",
      payload: { id: notebookID, title: "Notebook", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", deletedAt: null, revision: 1 },
    };
    let pulls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/push")) return new Response(JSON.stringify({ results: [], cursor: 0 }), { status: 200 });
      pulls += 1;
      if (pulls === 1) return new Response(JSON.stringify({ changes: [change], nextCursor: 1, hasMore: true }), { status: 200 });
      if (pulls === 2) throw new TypeError("offline");
      return new Response(JSON.stringify({ changes: [], nextCursor: 0, hasMore: false }), { status: 200 });
    }));

    const client = new SyncClient();
    await expect(client.sync(first.store, session)).rejects.toThrow("Network unavailable");
    const report = await client.sync(second.store, { ...session, user: { ...session.user, id: secondUserID } });

    expect(report.pulled).toBe(0);
  });

  it("sends at most one queued revision for an entity in a batch", () => {
    const selected = selectPushBatch([operation(operationID), operation(secondOperationID, notebookID)]);
    expect(selected.map((item) => item.opId)).toEqual([operationID]);
  });

  it("measures UTF-8 bytes instead of JavaScript string length", () => {
    const unicode = operation(operationID);
    const title = "é".repeat(1_000_000);
    unicode.payload = { ...unicode.payload, title };

    const payloadBytes = new TextEncoder().encode(JSON.stringify(unicode.payload)).byteLength;
    expect(title.length).toBeLessThan(1_900_000);
    expect(payloadBytes).toBeGreaterThan(1_900_000);
    expect(selectPushBatch([unicode])).toEqual([unicode]);
  });

  it("round trips every ink point after the former payload ceiling", async () => {
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const ink = inkOperation(operationID, 30_000);
    const wirePayload = toWirePayload(ink);
    expect(new TextEncoder().encode(JSON.stringify(wirePayload)).byteLength).toBeGreaterThan(1_900_000);
    const fake = fakeStore([ink]);
    let received: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/push")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { operations?: Array<Record<string, unknown>> };
        received = body.operations?.[0];
        return new Response(JSON.stringify({ results: [{ opId: operationID, status: "acked", revision: 1, sequence: null, serverPayload: null, code: null }], cursor: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ changes: [], nextCursor: 0, hasMore: false }), { status: 200 });
    }));

    const report = await new SyncClient().sync(fake.store, session);
    const receivedPayload = received?.payload as { strokes?: Array<{ points?: unknown[] }> } | undefined;
    expect(report).toEqual({ pushed: 1, pulled: 0, conflicts: 0 });
    expect(received?.payload).toEqual(wirePayload);
    expect(receivedPayload?.strokes?.[0]?.points).toHaveLength(30_000);
  });

  it("sends a large operation alone within the larger request bound", async () => {
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const largeOperationID = "88888888-8888-4888-8888-888888888888";
    const largeEntityID = "99999999-9999-4999-8999-999999999999";
    const normalEntityID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const large = operation(largeOperationID, largeEntityID);
    large.payload = { ...large.payload, title: "x".repeat(3_200_000) };
    const normal = operation(secondOperationID, normalEntityID);
    const fake = fakeStore([large, normal]);
    const pushBatches: string[][] = [];
    const pushBytes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/push")) {
        const raw = String(init?.body ?? "{}");
        const body = JSON.parse(raw) as { operations?: Array<{ opId: string }> };
        const batch = body.operations ?? [];
        pushBatches.push(batch.map((item) => item.opId));
        pushBytes.push(new TextEncoder().encode(raw).byteLength);
        return new Response(JSON.stringify({
          results: batch.map((item, itemIndex) => ({ opId: item.opId, status: "acked", revision: 1, sequence: itemIndex + 1, serverPayload: null, code: null })),
          cursor: batch.length,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ changes: [], nextCursor: 0, hasMore: false }), { status: 200 });
    }));

    const report = await new SyncClient().sync(fake.store, session);
    expect(pushBatches).toEqual([[largeOperationID], [secondOperationID]]);
    expect(pushBytes[0]).toBeGreaterThan(3 * 1024 * 1024);
    expect(pushBytes[0]).toBeLessThanOrEqual(34 * 1024 * 1024);
    expect(pushBytes[1]).toBeLessThanOrEqual(3 * 1024 * 1024);
    expect(report.pushed).toBe(2);
  });

  it("skips an oversized row while pushing independent work and pulling", async () => {
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const oversizedOperationID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const oversizedEntityID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const independentEntityID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const oversized = operation(oversizedOperationID, oversizedEntityID);
    oversized.payload = { ...oversized.payload, title: "x".repeat(32 * 1024 * 1024) };
    const independent = operation(secondOperationID, independentEntityID);
    const fake = fakeStore([oversized, independent]);
    const pushed: string[] = [];
    const change: PullChange = {
      sequence: 1,
      entityType: "notebook",
      entityId: independentEntityID,
      revision: 1,
      action: "upsert",
      payload: { ...independent.payload, revision: 1 },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/push")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { operations?: Array<{ opId: string }> };
        pushed.push(...(body.operations ?? []).map((item) => item.opId));
        return new Response(JSON.stringify({ results: (body.operations ?? []).map((item) => ({ opId: item.opId, status: "acked", revision: 1, sequence: null, serverPayload: null, code: null })), cursor: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ changes: [change], nextCursor: 1, hasMore: false }), { status: 200 });
    }));

    const report = await new SyncClient().sync(fake.store, session);
    expect(pushed).toEqual([secondOperationID]);
    expect(fake.remaining().map((item) => item.opId)).toEqual([oversizedOperationID]);
    expect(report.pulled).toBe(1);
    expect(report.blockedReason).toContain("32 MiB");
  });

  it("does not upload a workspace selected for another account", async () => {
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const fake = fakeStore([operation(operationID)]);
    Object.defineProperty(fake.store, "accountKey", { value: "https://sync.example.test:other-account", configurable: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new SyncClient().sync(fake.store, session)).rejects.toThrow("different account");
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("drains more than ten queued operations in separate push batches", async () => {
    localStorage.setItem("notepad.endpoint", "https://sync.example.test");
    const operations = Array.from({ length: 11 }, (_, index) => {
      const suffix = String(index + 10).padStart(12, "0");
      return operation(`00000000-0000-4000-8000-${suffix}`, `10000000-0000-4000-8000-${suffix}`);
    });
    const fake = fakeStore(operations);
    const pushSizes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/push")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { operations?: Array<{ opId: string }> };
        const batch = body.operations ?? [];
        pushSizes.push(batch.length);
        return new Response(JSON.stringify({
          results: batch.map((item, itemIndex) => ({ opId: item.opId, status: "acked", revision: 1, sequence: itemIndex + 1, serverPayload: null, code: null })),
          cursor: batch.length,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ changes: [], nextCursor: 0, hasMore: false }), { status: 200 });
    }));

    const report = await new SyncClient().sync(fake.store, session);
    expect(pushSizes).toEqual([10, 1]);
    expect(fake.sent).toHaveLength(11);
    expect(report.pushed).toBe(11);
  });
});
