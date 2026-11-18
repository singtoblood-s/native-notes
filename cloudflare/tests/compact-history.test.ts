import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { compactHistory } from "../src/compact-history";
import { unpackSnapshot } from "../src/snapshot-codec";

afterEach(async () => { await reset(); });

async function createUser(id: string) {
  await env.DB.prepare("INSERT INTO users(id, identifier, salt, password_hash, created_at) VALUES (?, ?, '', '', '')").bind(id, id).run();
}

function change(user: string, id: string, revision: number, payload: string) {
  return env.DB.prepare("INSERT INTO changes(user_id, entity_type, entity_id, revision, action, payload) VALUES (?, 'page', ?, ?, 'upsert', ?)")
    .bind(user, id, revision, payload);
}

function document(user: string, id: string, revision: number, payload: string) {
  return env.DB.prepare("INSERT INTO documents(user_id, entity_type, entity_id, revision, payload, updated_at) VALUES (?, 'page', ?, ?, ?, '')")
    .bind(user, id, revision, payload);
}

function chunk(user: string, index: number, payload: string) {
  return env.DB.prepare("INSERT INTO payload_chunks(user_id, payload_ref, chunk_index, payload) VALUES (?, 'reference', ?, ?)")
    .bind(user, index, payload);
}

it("preserves historical content, document identity and exact chunk bytes within a single account", async () => {
  await createUser("owner");
  await createUser("neighbor");
  const original = JSON.stringify({ text: "คำจด🖋\uFEFF".repeat(1600) });
  const newer = JSON.stringify({ text: "newer".repeat(4000) });
  const distinct = JSON.stringify({ text: "other".repeat(4000) });
  const rawChunk = "@gzip:" + "\uFEFFหมึก🖋".repeat(2000);
  const marker = "@payload:" + "x".repeat(43) + ":1800010:3";
  await env.DB.batch([
    change("owner", "match", 1, original), document("owner", "match", 1, original),
    change("owner", "newer", 1, original), document("owner", "newer", 2, newer),
    change("owner", "different", 1, original), document("owner", "different", 1, distinct),
    change("owner", "chunked", 1, marker), document("owner", "chunked", 1, marker),
    chunk("owner", 0, rawChunk), chunk("owner", 1, "@gzip:literal"),
    change("neighbor", "match", 1, original), document("neighbor", "match", 1, original), chunk("neighbor", 0, rawChunk),
    env.DB.prepare("INSERT INTO sync_operations(user_id, op_id, request_hash, status, revision, sequence, server_payload) VALUES ('owner', 'existing', 'hash', 'conflict', 1, 1, ?)").bind(original),
  ]);
  const result = await compactHistory(env.DB, "owner");
  expect(result.finished).toBe(true);
  expect(result.rowsPacked).toBe(5);
  expect(result.bytesSaved).toBeGreaterThan(50_000);
  const history = await env.DB.prepare("SELECT sequence, entity_id, revision, action, payload FROM changes WHERE user_id = 'owner' ORDER BY sequence")
    .all<{ sequence: number; entity_id: string; revision: number; action: string; payload: string }>();
  expect(history.results.map(row => [row.sequence, row.entity_id, row.revision, row.action])).toEqual([
    [1, "match", 1, "upsert"], [2, "newer", 1, "upsert"], [3, "different", 1, "upsert"], [4, "chunked", 1, "upsert"],
  ]);
  for (const row of history.results.slice(0, 3)) {
    expect(row.payload.startsWith("@gzip:")).toBe(true);
    expect(await unpackSnapshot(row.payload, 100_000)).toBe(original);
  }
  expect(history.results[3]!.payload).toBe(marker);
  const docs = await env.DB.prepare("SELECT entity_id, payload FROM documents WHERE user_id = 'owner'").all<{ entity_id: string; payload: string }>();
  expect(Object.fromEntries(docs.results.map(row => [row.entity_id, row.payload]))).toEqual({
    match: history.results[0]!.payload, newer, different: distinct, chunked: marker,
  });
  const parts = await env.DB.prepare("SELECT typeof(payload) AS kind, CAST(payload AS TEXT) AS payload FROM payload_chunks WHERE user_id = 'owner' ORDER BY chunk_index")
    .all<{ kind: string; payload: string }>();
  expect(parts.results.map(row => row.kind)).toEqual(["blob", "text"]);
  expect(await unpackSnapshot(parts.results[0]!.payload, 100_000)).toBe(rawChunk);
  expect(parts.results[1]!.payload).toBe("@gzip:literal");
  expect(await env.DB.prepare("SELECT server_payload FROM sync_operations WHERE user_id = 'owner' AND op_id = 'existing'").first("server_payload")).toBe(original);
  for (const table of ["changes", "documents"] as const) {
    expect(await env.DB.prepare(`SELECT payload FROM ${table} WHERE user_id = 'neighbor'`).first("payload")).toBe(original);
  }
  expect(await env.DB.prepare("SELECT typeof(payload) FROM payload_chunks WHERE user_id = 'neighbor'").first("typeof(payload)")).toBe("text");
  expect(await compactHistory(env.DB, "owner")).toMatchObject({ finished: true, rowsPacked: 0, bytesSaved: 0 });
});

it("advances through small rows and bounds large payload work without skipping an eligible revision", async () => {
  await createUser("owner");
  const keys = Array.from({ length: 50 }, (_, i) => change("owner", String(i), 1, "{}"));
  await env.DB.batch(keys);
  const raw = JSON.stringify({ text: "w".repeat(1_100_000) });
  for (let i = 0; i < 4; i++) await change("owner", "large", i + 1, raw).run();
  const first = await compactHistory(env.DB, "owner");
  expect(first).toMatchObject({ cursor: { sequence: 48 }, rowsPacked: 0, finished: false });
  const second = await compactHistory(env.DB, "owner", first.cursor);
  expect(second).toMatchObject({ cursor: { sequence: 52 }, rowsPacked: 2, finished: false });
  const last = await compactHistory(env.DB, "owner", second.cursor);
  expect(last).toMatchObject({ cursor: { sequence: 54 }, rowsPacked: 2, finished: true });
  const history = await env.DB.prepare("SELECT payload FROM changes WHERE user_id = 'owner' AND entity_id = 'large' ORDER BY revision").all<{ payload: string }>();
  for (const row of history.results) expect(await unpackSnapshot(row.payload, 1_200_000) === raw).toBe(true);
});

it("resumes chunk work in account primary-key order even when that differs from insertion order", async () => {
  await createUser("owner");
  await createUser("neighbor");
  const raw = "ตัวอย่าง".repeat(1800);
  for (const ref of ["z", "f", "e", "d", "c", "b", "a"]) {
    await env.DB.prepare("INSERT INTO payload_chunks(user_id, payload_ref, chunk_index, payload) VALUES ('owner', ?, 0, ?)").bind(ref, raw).run();
  }
  await chunk("neighbor", 0, raw).run();
  const first = await compactHistory(env.DB, "owner");
  expect(first).toMatchObject({ finished: false, rowsPacked: 4 });
  const last = await compactHistory(env.DB, "owner", first.cursor);
  expect(last).toMatchObject({ finished: true, rowsPacked: 3 });
  expect(await env.DB.prepare("SELECT count(*) AS n FROM payload_chunks WHERE user_id='owner' AND typeof(payload)='blob'").first("n")).toBe(7);
  expect(await env.DB.prepare("SELECT typeof(payload) AS kind FROM payload_chunks WHERE user_id='neighbor'").first("kind")).toBe("text");
});
