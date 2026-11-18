import { exports as workerExports, env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { derivePassword } from "../src/index";
import { unpackSnapshot } from "../src/snapshot-codec";

const ORIGIN = "https://singtoblood-s.github.io";
const jsonHeaders = { "Content-Type": "application/json", Origin: ORIGIN };

afterEach(async () => {
  await reset();
});

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return workerExports.default.fetch(new Request(`https://native-notes.test${path}`, init));
}

async function auth(): Promise<{ token: string; userId: string }> {
  const identifier = `test-${crypto.randomUUID()}@example.com`;
  const response = await request("/v1/auth/register", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ identifier, password: "a-strong-test-password" }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { sessionToken: string; user: { id: string } };
  return { token: body.sessionToken, userId: body.user.id };
}

function id(): string {
  return crypto.randomUUID().toLowerCase();
}

function notebook(notebookId: string, title = "Notebook"): Record<string, unknown> {
  return {
    id: notebookId,
    title,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    deletedAt: null,
    revision: 0,
  };
}

function page(pageId: string, notebookId: string, title = "Page"): Record<string, unknown> {
  return {
    id: pageId,
    notebookId,
    title,
    text: "",
    background: "blank",
    width: 1024,
    height: 1366,
    strokes: [],
    formatVersion: 1,
    revision: 0,
    updatedAt: "2026-01-01T00:00:00Z",
    deletedAt: null,
  };
}

function largePage(pageId: string, notebookId: string): Record<string, unknown> {
  return {
    ...page(pageId, notebookId, "Large page"),
    text: "large page ".repeat(10_000),
    strokes: [{
      id: id(),
      color: 0xff1b1b1f,
      width: 2.5,
      points: Array.from({ length: 35_000 }, (_, time) => ({
        x: time % 1000,
        y: (time * 3) % 1000,
        pressure: 0.5,
        time,
        tiltX: null,
        tiltY: null,
      })),
    }],
  };
}

function operation(
  entityType: "notebook" | "page",
  entityId: string,
  payload: Record<string, unknown>,
  baseRevision = 0,
  action: "upsert" | "delete" = "upsert",
): Record<string, unknown> {
  return { opId: id(), entityType, entityId, baseRevision, action, payload, createdAt: "2026-01-01T00:00:00Z" };
}

async function push(token: string, operations: Record<string, unknown>[]): Promise<{ results: Array<Record<string, unknown>>; cursor: number }> {
  const response = await request("/v1/sync/push", {
    method: "POST",
    headers: { ...jsonHeaders, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ operations }),
  });
  return await response.json() as { results: Array<Record<string, unknown>>; cursor: number };
}

describe("native-notes Cloudflare Worker", () => {
  it("derives the Kotlin-compatible 600,000-round PBKDF2 value", async () => {
    const value = await derivePassword("password", new Uint8Array(16));
    const encoded = btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    expect(encoded).toBe("t1EqilHZMO856EIVAAMU3zwbjXFmENWg-2V9QOcxc98");
  }, 30_000);

  it("falls back to the same 600,000-round PBKDF2 output when native crypto fails", async () => {
    const nativeDeriveBits = vi.spyOn(crypto.subtle, "deriveBits").mockRejectedValue(new Error("forced native failure"));
    try {
      const value = await derivePassword("password", new Uint8Array(16));
      const encoded = btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
      expect(encoded).toBe("t1EqilHZMO856EIVAAMU3zwbjXFmENWg-2V9QOcxc98");
    } finally {
      nativeDeriveBits.mockRestore();
    }
  }, 30_000);

  it("accepts a legacy 600,000-round PBKDF2 account fixture", async () => {
    const userId = "99999999-9999-4999-8999-999999999999";
    const identifier = "legacy-fixture@example.test";
    await env.DB.prepare("INSERT INTO users(id, identifier, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(userId, identifier, "AAAAAAAAAAAAAAAAAAAAAA", "t1EqilHZMO856EIVAAMU3zwbjXFmENWg-2V9QOcxc98", "2026-01-01T00:00:00Z")
      .run();

    const response = await request("/v1/auth/login", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ identifier, password: "password" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { user: { id: string; identifier: string }; sessionToken: string; expiresAt: string };
    expect(body.user).toEqual({ id: userId, identifier });
    expect(body.sessionToken).toEqual(expect.any(String));
    expect(body.expiresAt).toEqual(expect.any(String));
  }, 30_000);

  it("registers, keeps sessions revocable, and returns idempotent receipts", async () => {
    const { token, userId } = await auth();
    const bearer = { Origin: ORIGIN, Authorization: `Bearer ${token}` };
    const remember = () => request("/v1/auth/remember", { method: "POST", headers: bearer });
    const remembered = await remember();
    expect(remembered.status).toBe(200);
    const { expiresAt: expiry } = await remembered.json() as { expiresAt: string };
    expect(Date.parse(expiry) - Date.now()).toBeGreaterThan(364 * 86_400_000);
    expect(Date.parse(expiry) - Date.now()).toBeLessThanOrEqual(365 * 86_400_000);
    expect(await env.DB.prepare("SELECT expires_at FROM sessions WHERE user_id = ?").bind(userId).first("expires_at")).toBe(expiry);
    expect((await remember()).status).toBe(200);
    const row = await env.DB.prepare("SELECT salt, password_hash FROM users WHERE id = ?").bind(userId).first<{ salt: string; password_hash: string }>();
    expect(row?.salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(row?.password_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const notebookId = id();
    const firstOperation = operation("notebook", notebookId, notebook(notebookId));
    const first = await push(token, [firstOperation]);
    expect(first.results[0]).toMatchObject({ opId: firstOperation.opId, status: "acked", revision: 1, sequence: 1 });
    const retry = await push(token, [firstOperation]);
    expect(retry.results[0]).toEqual(first.results[0]);

    const tampered = { ...firstOperation, payload: notebook(notebookId, "Tampered") };
    const mismatch = await push(token, [tampered]);
    expect(mismatch.results[0]).toMatchObject({ status: "rejected", code: "idempotency_mismatch" });

    const pulledResponse = await request("/v1/sync/pull?cursor=0&limit=100", {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
    });
    expect(pulledResponse.status).toBe(200);
    await expect(pulledResponse.json()).resolves.toMatchObject({ nextCursor: 1, hasMore: false, changes: [{ sequence: 1, entityType: "notebook", action: "upsert" }] });

    await request("/v1/auth/logout", { method: "POST", headers: { ...jsonHeaders, Authorization: `Bearer ${token}` }, body: "{}" });
    const afterLogout = await request("/v1/sync/pull?cursor=0", { headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` } });
    expect(afterLogout.status).toBe(401);
    expect((await remember()).status).toBe(401);
  });

  it("keeps the web operation fingerprint stable", async () => {
    const { token, userId } = await auth();
    const notebookId = "11111111-1111-4111-8111-111111111111";
    const firstOperation = {
      opId: "22222222-2222-4222-8222-222222222222",
      entityType: "notebook",
      entityId: notebookId,
      baseRevision: 0,
      action: "upsert",
      payload: notebook(notebookId, "Golden notebook"),
      createdAt: "2026-01-01T00:00:00Z",
    };
    const response = await push(token, [firstOperation]);
    expect(response.results[0]).toMatchObject({ opId: firstOperation.opId, status: "acked" });
    const row = await env.DB.prepare("SELECT request_hash FROM sync_operations WHERE user_id = ? AND op_id = ?")
      .bind(userId, firstOperation.opId)
      .first<{ request_hash: string }>();
    expect(row?.request_hash).toBe("JGgMdGiaJk2Ec31uNUn_sBgwSx0lf-M35NDuP-_9ado");
  });

  it("keeps packed inline pages readable through pull, conflict receipts and retry", async () => {
    const { token } = await auth();
    const bookId = id(), pageId = id();
    const text = "บันทึกการเขียน 🖋\n".repeat(8_000);
    const data = { ...page(pageId, bookId), text };
    await push(token, [operation("notebook", bookId, notebook(bookId))]);
    const save = operation("page", pageId, data);
    const result = await push(token, [save]);
    expect(result.results[0]).toMatchObject({ status: "acked", revision: 1 });
    const encoded = await env.DB.prepare("SELECT payload FROM documents WHERE entity_id = ?").bind(pageId).first<string>("payload");
    expect(encoded).toMatch(/^@gzip:/);
    expect(encoded!.length).toBeLessThan(text.length / 10);
    expect((await push(token, [save])).results[0]).toEqual(result.results[0]);
    const response = await request("/v1/sync/pull?cursor=1", { headers: { Authorization: `Bearer ${token}` } });
    const history = await response.json() as { changes: { payload: { text: string } }[] };
    expect(history.changes[0]?.payload.text).toBe(text);
    const stale = operation("page", pageId, { ...data, text: "Different edit" }, 0);
    const conflict = await push(token, [stale]);
    expect(conflict.results[0]).toMatchObject({ status: "conflict", serverPayload: { text } });
    expect((await push(token, [stale])).results).toEqual(conflict.results);
  });

  it("recovers from full storage on a separate push and saves the retried edit exactly once", async () => {
    const { token, userId } = await auth();
    const bookId = id(), pageId = id();
    const priorText = "บันทึกเดิม 🖋\n".repeat(4000);
    const priorPage = { ...page(pageId, bookId), text: priorText };
    await push(token, [operation("notebook", bookId, notebook(bookId)), operation("page", pageId, priorPage)]);
    const stored = await env.DB.prepare("SELECT payload FROM changes WHERE user_id=? AND entity_id=? AND revision=1")
      .bind(userId, pageId).first<string>("payload");
    expect(stored).toMatch(/^@gzip:/);
    const raw = await unpackSnapshot(stored!, 1_000_000);
    // Simulate an existing account that still has pre-compression history.
    await env.DB.batch([
      env.DB.prepare("UPDATE changes SET payload=? WHERE user_id=? AND entity_id=? AND revision=1").bind(raw, userId, pageId),
      env.DB.prepare("UPDATE documents SET payload=? WHERE user_id=? AND entity_id=? AND revision=1").bind(raw, userId, pageId),
    ]);
    const latestText = priorText + "new ink";
    const edit = operation("page", pageId, { ...priorPage, text: latestText }, 1);
    const headers = { ...jsonHeaders, Authorization: `Bearer ${token}` };
    const send = () => request("/v1/sync/push", { method: "POST", headers, body: JSON.stringify({ operations: [edit] }) });
    // SQLite does not accept bound parameters in trigger definitions. The ID is a freshly issued UUID.
    expect(userId).toMatch(/^[a-f0-9-]{36}$/);
    await env.DB.prepare(`CREATE TRIGGER qa_full_storage BEFORE INSERT ON changes
      WHEN new.user_id='${userId}' BEGIN SELECT RAISE(ABORT, 'SQLITE_FULL: database or disk is full'); END`).run();
    try {
      const full = await send();
      expect(full.status).toBe(507);
      expect(await full.json()).toMatchObject({ error: { code: "sync_storage_full" } });
      const recovering = await send();
      expect(recovering.status).toBe(503);
      expect(await recovering.json()).toMatchObject({ error: { code: "sync_space_recovery" } });
      expect(await env.DB.prepare("SELECT substr(payload,1,6) FROM changes WHERE user_id=? AND entity_id=? AND revision=1")
        .bind(userId, pageId).first("substr(payload,1,6)")).toBe("@gzip:");
      expect(await env.DB.prepare("SELECT count(*) AS n FROM sync_operations WHERE user_id=? AND op_id=?")
        .bind(userId, edit.opId).first("n")).toBe(0);
    } finally {
      await env.DB.prepare("DROP TRIGGER qa_full_storage").run();
    }
    const accepted = await send();
    expect(accepted.status).toBe(200);
    const receipt = await accepted.json();
    expect(receipt).toMatchObject({ results: [{ opId: edit.opId, status: "acked", revision: 2 }] });
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    const response = await request("/v1/sync/pull?cursor=0&limit=100", { headers });
    expect(response.status).toBe(200);
    const history = await response.json() as { changes: { entityId: string; revision: number; payload: { text: string } }[] };
    expect(history.changes.filter(item => item.entityId === pageId).map(item => [item.revision, item.payload.text]))
      .toEqual([[1, priorText], [2, latestText]]);
  }, 30_000);

  it("stores and hydrates a large page without losing ink across retry, conflict, pull, or delete", async () => {
    const { token } = await auth();
    const notebookId = id();
    const pageId = id();
    const notebookOperation = operation("notebook", notebookId, notebook(notebookId));
    expect((await push(token, [notebookOperation])).results[0]).toMatchObject({ status: "acked", revision: 1 });

    const large = largePage(pageId, notebookId);
    expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeGreaterThan(1_900_000);
    const pageOperation = operation("page", pageId, large);
    const first = await push(token, [pageOperation]);
    expect(first.results[0]).toMatchObject({ status: "acked", revision: 1, sequence: 2 });

    const documentRow = await env.DB.prepare("SELECT payload FROM documents WHERE entity_type = 'page' AND entity_id = ?")
      .bind(pageId)
      .first<{ payload: string }>();
    expect(documentRow?.payload).toMatch(/^@payload:[A-Za-z0-9_-]{43}:/);
    const chunkCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM payload_chunks").first<{ count: number }>();
    expect(Number(chunkCount?.count)).toBeGreaterThan(1);
    const bytes = await env.DB.prepare("SELECT sum(length(payload)) FROM payload_chunks WHERE typeof(payload)='blob'").first<number>("sum(length(payload))");
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(500_000);

    const retry = await push(token, [pageOperation]);
    expect(retry.results[0]).toEqual(first.results[0]);

    const pulled = await request("/v1/sync/pull?cursor=1&limit=100", {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
    });
    expect(pulled.status).toBe(200);
    const pulledBody = await pulled.json() as { changes: Array<Record<string, unknown>> };
    expect(pulledBody.changes).toHaveLength(1);
    expect(pulledBody.changes[0]?.payload).toMatchObject({ id: pageId, text: large.text });
    expect((pulledBody.changes[0]?.payload as { strokes: unknown[] }).strokes).toEqual(large.strokes);

    const staleOperation = operation("page", pageId, page(pageId, notebookId), 0);
    const conflict = await push(token, [staleOperation]);
    expect(conflict.results[0]).toMatchObject({ status: "conflict", revision: 1 });
    expect(conflict.results[0]?.serverPayload).toMatchObject({ id: pageId, text: large.text });
    expect((conflict.results[0]?.serverPayload as { strokes: unknown[] }).strokes).toEqual(large.strokes);
    const conflictRow = await env.DB.prepare("SELECT server_payload FROM sync_operations WHERE op_id = ?")
      .bind(staleOperation.opId)
      .first<{ server_payload: string }>();
    expect(conflictRow?.server_payload).toMatch(/^@payload:[A-Za-z0-9_-]{43}:/);
    const conflictRetry = await push(token, [staleOperation]);
    expect(conflictRetry.results[0]).toEqual(conflict.results[0]);

    const deleteOperation = operation("page", pageId, large, 1, "delete");
    expect((await push(token, [deleteOperation])).results[0]).toMatchObject({ status: "acked", revision: 2, sequence: 3 });
    const deletedPull = await request("/v1/sync/pull?cursor=2&limit=1", {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
    });
    const deletedBody = await deletedPull.json() as { changes: Array<Record<string, unknown>> };
    expect(deletedBody.changes[0]).toMatchObject({ action: "delete", payload: { id: pageId, text: large.text } });
    expect((deletedBody.changes[0]?.payload as { strokes: unknown[] }).strokes).toEqual(large.strokes);
  }, 30_000);

  it("round-trips page images and metadata without allowing a legacy overwrite", async () => {
    const { token } = await auth();
    const notebookId = id();
    const pageId = id();
    expect((await push(token, [operation("notebook", notebookId, notebook(notebookId))])).results[0]).toMatchObject({ status: "acked", revision: 1 });

    const image = {
      id: id(),
      src: "data:image/png;base64,AAAA",
      x: 12,
      y: 24,
      width: 320,
      height: 240,
    };
    const imagePage = { ...page(pageId, notebookId, "Image page"), formatVersion: 2, images: [image], order: 4, conflictOf: id() };
    const stored = await push(token, [operation("page", pageId, imagePage)]);
    expect(stored.results[0]).toMatchObject({ status: "acked", revision: 1, sequence: 2 });

    const pulled = await request("/v1/sync/pull?cursor=1&limit=100", {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
    });
    const pulledBody = await pulled.json() as { changes: Array<Record<string, unknown>> };
    expect(pulledBody.changes[0]?.payload).toMatchObject({
      id: pageId,
      formatVersion: 2,
      images: [image],
      order: 4,
      conflictOf: imagePage.conflictOf,
    });

    const legacyEdit = page(pageId, notebookId, "Legacy edit");
    const rejected = await push(token, [operation("page", pageId, legacyEdit, 1)]);
    expect(rejected.results[0]).toMatchObject({ status: "rejected", code: "legacy_format" });

    const legacyPageId = id();
    const legacyCreated = await push(token, [operation("page", legacyPageId, page(legacyPageId, notebookId, "Legacy page"))]);
    expect(legacyCreated.results[0]).toMatchObject({ status: "acked", revision: 1, sequence: 3 });
    const legacyPull = await request("/v1/sync/pull?cursor=2&limit=100", {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
    });
    const legacyPayload = ((await legacyPull.json()) as { changes: Array<Record<string, unknown>> }).changes[0]?.payload as Record<string, unknown>;
    expect(legacyPayload).not.toHaveProperty("images");
    expect(legacyPayload).not.toHaveProperty("order");
    expect(legacyPayload).not.toHaveProperty("conflictOf");

    const unsafePageId = id();
    const unsafe = { ...page(unsafePageId, notebookId, "Unsafe"), formatVersion: 2, images: [{ ...image, id: id(), src: "data:image/svg+xml;base64,AAAA" }] };
    const unsafeResult = await push(token, [operation("page", unsafePageId, unsafe)]);
    expect(unsafeResult.results[0]).toMatchObject({ status: "rejected", code: "invalid_image" });
  });

  it("bounds pull batches by bytes and rejects a multi-large push before writing", async () => {
    const { token } = await auth();
    const notebookId = id();
    expect((await push(token, [operation("notebook", notebookId, notebook(notebookId))])).results[0]).toMatchObject({ status: "acked", sequence: 1 });
    const firstPage = largePage(id(), notebookId);
    const secondPage = largePage(id(), notebookId);
    expect((await push(token, [operation("page", firstPage.id as string, firstPage)])).results[0]).toMatchObject({ status: "acked", sequence: 2 });
    expect((await push(token, [operation("page", secondPage.id as string, secondPage)])).results[0]).toMatchObject({ status: "acked", sequence: 3 });

    const bounded = await request("/v1/sync/pull?cursor=1&limit=100", {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
    });
    expect(bounded.status).toBe(200);
    const boundedBody = await bounded.json() as { changes: Array<Record<string, unknown>>; nextCursor: number; hasMore: boolean };
    expect(boundedBody.changes).toHaveLength(1);
    expect(boundedBody.nextCursor).toBe(2);
    expect(boundedBody.hasMore).toBe(true);
    expect(boundedBody.changes[0]?.payload).toMatchObject({ id: firstPage.id, text: firstPage.text });

    const remainder = await request("/v1/sync/pull?cursor=2&limit=100", {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
    });
    const remainderBody = await remainder.json() as { changes: Array<Record<string, unknown>>; nextCursor: number; hasMore: boolean };
    expect(remainderBody.changes).toHaveLength(1);
    expect(remainderBody.nextCursor).toBe(3);
    expect(remainderBody.hasMore).toBe(false);
    expect(remainderBody.changes[0]?.payload).toMatchObject({ id: secondPage.id, text: secondPage.text });

    const rejectedFirst = largePage(id(), notebookId);
    const rejectedSecond = largePage(id(), notebookId);
    const rejected = await request("/v1/sync/push", {
      method: "POST",
      headers: { ...jsonHeaders, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ operations: [
        operation("page", rejectedFirst.id as string, rejectedFirst),
        operation("page", rejectedSecond.id as string, rejectedSecond),
      ] }),
    });
    expect(rejected.status).toBe(413);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: "too_many_operations" } });
    const unchanged = await request("/v1/sync/pull?cursor=3&limit=100", {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
    });
    await expect(unchanged.json()).resolves.toMatchObject({ changes: [], nextCursor: 3, hasMore: false });
  }, 30_000);

  it("serializes concurrent CAS updates so only one wins", async () => {
    const { token } = await auth();
    const notebookId = id();
    const created = await push(token, [operation("notebook", notebookId, notebook(notebookId))]);
    expect(created.results[0]).toMatchObject({ status: "acked", revision: 1 });
    const one = operation("notebook", notebookId, notebook(notebookId, "One"), 1);
    const two = operation("notebook", notebookId, notebook(notebookId, "Two"), 1);
    const [left, right] = await Promise.all([push(token, [one]), push(token, [two])]);
    const results = [left.results[0]!, right.results[0]!];
    expect(results.filter((result) => result.status === "acked")).toHaveLength(1);
    expect(results.filter((result) => result.status === "conflict")).toHaveLength(1);
    expect(results.find((result) => result.status === "acked")).toMatchObject({ revision: 2, sequence: 2 });
  });

  it("isolates accounts and enforces page tombstone parent rules", async () => {
    const first = await auth();
    const second = await auth();
    const notebookId = id();
    const pageId = id();
    await push(first.token, [operation("notebook", notebookId, notebook(notebookId))]);
    const pageCreated = await push(first.token, [operation("page", pageId, page(pageId, notebookId))]);
    expect(pageCreated.results[0]).toMatchObject({ status: "acked", revision: 1 });
    const pageDeleted = await push(first.token, [operation("page", pageId, page(pageId, notebookId), 1, "delete")]);
    expect(pageDeleted.results[0]).toMatchObject({ status: "acked", revision: 2 });
    const pageRestored = await push(first.token, [operation("page", pageId, page(pageId, notebookId), 2)]);
    expect(pageRestored.results[0]).toMatchObject({ status: "acked", revision: 3 });
    const notebookDeleted = await push(first.token, [operation("notebook", notebookId, notebook(notebookId), 1, "delete")]);
    expect(notebookDeleted.results[0]).toMatchObject({ status: "acked", revision: 2 });
    const blocked = await push(first.token, [operation("page", pageId, page(pageId, notebookId), 3)]);
    expect(blocked.results[0]).toMatchObject({ status: "rejected", code: "notebook_deleted" });

    const otherPull = await request("/v1/sync/pull?cursor=0", { headers: { Origin: ORIGIN, Authorization: `Bearer ${second.token}` } });
    expect(otherPull.status).toBe(200);
    await expect(otherPull.json()).resolves.toMatchObject({ changes: [], nextCursor: 0 });
  });

  it("answers CORS preflight and bounds requests", async () => {
    const preflight = await request("/v1/auth/login", {
      method: "OPTIONS",
      headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const { token } = await auth();
    const tooManyOperations = Array.from({ length: 11 }, () => {
      const notebookId = id();
      return operation("notebook", notebookId, notebook(notebookId));
    });
    const tooMany = await request("/v1/sync/push", {
      method: "POST",
      headers: { ...jsonHeaders, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ operations: tooManyOperations }),
    });
    expect(tooMany.status).toBe(413);
    await expect(tooMany.json()).resolves.toMatchObject({ error: { code: "too_many_operations" } });

    const pulled = await request("/v1/sync/pull?cursor=0&limit=100", {
      headers: { ...jsonHeaders, Authorization: `Bearer ${token}` },
    });
    expect(pulled.status).toBe(200);
    await expect(pulled.json()).resolves.toMatchObject({ changes: [], nextCursor: 0, hasMore: false });
  });
});
