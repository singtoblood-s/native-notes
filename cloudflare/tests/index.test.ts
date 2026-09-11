import { exports as workerExports, env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { derivePassword } from "../src/index";

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
