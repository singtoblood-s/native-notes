import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { DurableObject } from "cloudflare:workers";

export interface Env {
  DB: D1Database;
  API: DurableObjectNamespace;
  ALLOWED_ORIGINS?: string;
}

type JsonRecord = Record<string, unknown>;
type EntityType = "notebook" | "page";
type SyncAction = "upsert" | "delete";
type PushStatus = "acked" | "conflict" | "rejected";

interface Operation {
  opId: string;
  entityType: EntityType;
  entityId: string;
  baseRevision: number;
  action: SyncAction;
  payload: unknown;
  createdAt: string;
}

interface NotebookPayload {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  revision: number;
}

interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  time: number;
  tiltX: number | null;
  tiltY: number | null;
}

interface InkStroke {
  id: string;
  color: number;
  width: number;
  points: StrokePoint[];
}

interface PagePayload {
  id: string;
  notebookId: string;
  title: string;
  text: string;
  background: "blank" | "ruled" | "grid";
  width: number;
  height: number;
  strokes: InkStroke[];
  formatVersion: number;
  revision: number;
  updatedAt: string;
  deletedAt: string | null;
}

interface StoredDocument {
  entityType: EntityType;
  entityId: string;
  revision: number;
  /** Hydrated JSON, or null until a chunked snapshot is needed. */
  payload: string | null;
  /** The exact value stored in documents.payload (inline JSON or marker). */
  storedPayload: string;
  deleted: boolean;
  updatedAt: string;
}

interface StoredOperation {
  opId: string;
  request_hash: string;
  status: string;
  revision: number | null;
  sequence: number | null;
  server_payload: string | null;
  serverPayloadStorage: string | null;
  code: string | null;
}

interface PushResult {
  opId: string;
  status: PushStatus;
  revision: number | null;
  sequence: number | null;
  serverPayload: JsonRecord | null;
  code: string | null;
}

interface Change {
  sequence: number;
  entityType: EntityType;
  entityId: string;
  revision: number;
  action: SyncAction;
  payload: JsonRecord;
}

interface ValidatedOperation {
  value: NotebookPayload | PagePayload;
  deleted: boolean;
  notebookId?: string;
}

interface AckPlan {
  kind: "ack";
  operation: Operation;
  requestHash: string;
  document: StoredDocument;
  payloadChunks: PayloadChunks;
  action: SyncAction;
  result: PushResult;
}

interface FinalPlan {
  kind: "final";
  operation: Operation;
  requestHash: string;
  serverPayloadStorage: string | null;
  result: PushResult;
}

type WritePlan = AckPlan | FinalPlan;

interface PayloadChunks {
  storedPayload: string;
  chunks: string[];
}

interface RawChange {
  sequence: number;
  entityType: EntityType;
  entityId: string;
  revision: number;
  action: SyncAction;
  storedPayload: string;
  payloadBytes: number;
}

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_BITS = 256;
const SALT_BYTES = 16;
const SESSION_BYTES = 32;
const SESSION_DAYS = 30;
const MAX_AUTH_BODY = 64 * 1024;
const MAX_SYNC_BODY = 36 * 1024 * 1024;
// Free D1 allows 50 queries per invocation. Multi-operation pushes are capped
// at 3 MiB and large single operations batch their chunk inserts by parameter
// count so the write and hydration paths stay below that ceiling.
const MAX_PUSH_OPERATIONS = 10;
// D1's 2,000,000-byte row limit applies to each row. Large JSON snapshots are
// kept in immutable UTF-8 chunks and the existing rows keep a small marker.
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const INLINE_PAYLOAD_BYTES = 1_800_000;
const PAYLOAD_CHUNK_BYTES = 900_000;
const PAYLOAD_MARKER_PREFIX = "@payload:";
const MAX_PULL_RESPONSE_BYTES = 4 * 1024 * 1024;
const PULL_CHANGE_OVERHEAD_BYTES = 8 * 1024;
const MAX_MULTI_OPERATION_BYTES = 3 * 1024 * 1024;
const MAX_STROKES = 10_000;
const MAX_POINTS = 200_000;
const MAX_BATCH_STATEMENTS = 45;
const MAX_SQL_PARAMETERS = 100;
const MAX_CHUNKS_PER_STATEMENT = Math.floor((MAX_SQL_PARAMETERS - 3) / 4);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DUMMY_SALT = new Uint8Array(SALT_BYTES);
const textEncoder = new TextEncoder();

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

class LoginRateLimiter {
  private readonly buckets = new Map<string, { startedAt: number; count: number }>();

  constructor(private readonly maxAttempts: number, private readonly windowMs = 60_000) {}

  allow(key: string, now = Date.now()): boolean {
    const current = this.buckets.get(key);
    if (!current || now - current.startedAt >= this.windowMs) {
      if (this.buckets.size >= 10_000 && !current) {
        const oldest = [...this.buckets.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
        if (oldest) this.buckets.delete(oldest[0]);
      }
      this.buckets.set(key, { startedAt: now, count: 1 });
      for (const [bucketKey, bucket] of this.buckets) {
        if (bucketKey !== key && now - bucket.startedAt >= this.windowMs) this.buckets.delete(bucketKey);
      }
      return true;
    }
    if (current.count >= this.maxAttempts) return false;
    current.count += 1;
    return true;
  }
}

/**
 * A single personal workspace is intentionally one DO. blockConcurrencyWhile
 * gives each API request one serialized read/write turn; split this into
 * account shards only after measured throughput requires it.
 */
export class ApiDurableObject extends DurableObject<Env> {
  private readonly clientLimiter = new LoginRateLimiter(20);
  private readonly identifierLimiter = new LoginRateLimiter(10);

  constructor(
    private readonly state: DurableObjectState,
    private readonly runtimeEnv: Env,
  ) {
    super(state, runtimeEnv);
  }

  fetch(request: Request): Promise<Response> {
    return this.state.blockConcurrencyWhile(() => handleRequest(request, this.runtimeEnv, this));
  }

  getClientLimiter(): LoginRateLimiter {
    return this.clientLimiter;
  }

  getIdentifierLimiter(): LoginRateLimiter {
    return this.identifierLimiter;
  }
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.API.idFromName("native-notes-global");
    return env.API.get(id).fetch(request);
  },
};

export default worker;

async function handleRequest(request: Request, env: Env, object: ApiDurableObject): Promise<Response> {
  const cors = corsHeaders(request, env);
  try {
    const origin = request.headers.get("Origin");
    if (origin && !isAllowedOrigin(origin, env)) throw new ApiFailure(403, "cors_forbidden", "Origin is not allowed");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      const headers = new Headers(cors);
      headers.set("Content-Type", "text/plain; charset=utf-8");
      return new Response("ok", { status: 200, headers });
    }

    if (url.pathname === "/v1/auth/register" && request.method === "POST") {
      const body = parseAuthRequest(await readJsonBody(request, MAX_AUTH_BODY));
      return jsonResponse(await register(env.DB, body, clientKey(request), object), 200, cors);
    }
    if (url.pathname === "/v1/auth/login" && request.method === "POST") {
      const body = parseAuthRequest(await readJsonBody(request, MAX_AUTH_BODY));
      return jsonResponse(await login(env.DB, body, clientKey(request), object), 200, cors);
    }
    if (url.pathname === "/v1/auth/logout" && request.method === "POST") {
      await logout(env.DB, bearerToken(request));
      return new Response(null, { status: 204, headers: cors });
    }
    if (url.pathname === "/v1/sync/push" && request.method === "POST") {
      const user = await authenticate(env.DB, bearerToken(request));
      const body = parsePushRequest(await readJsonBody(request, MAX_SYNC_BODY));
      return jsonResponse(await push(env.DB, user.id, body), 200, cors);
    }
    if (url.pathname === "/v1/sync/pull" && request.method === "GET") {
      const user = await authenticate(env.DB, bearerToken(request));
      const cursor = parseCursor(url.searchParams.get("cursor"));
      const limit = parseLimit(url.searchParams.get("limit"));
      return jsonResponse(await pull(env.DB, user.id, cursor, limit), 200, cors);
    }
    throw new ApiFailure(404, "not_found", "Not found");
  } catch (error) {
    if (error instanceof ApiFailure) return errorResponse(error, cors);
    return errorResponse(new ApiFailure(500, "internal_error", "The server could not complete the request"), cors);
  }
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  if (origin && isAllowedOrigin(origin, env)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Max-Age", "3600");
    headers.set("Vary", "Origin");
  }
  return headers;
}

function isAllowedOrigin(origin: string, env: Env): boolean {
  const configured = (env.ALLOWED_ORIGINS ?? "https://singtoblood-s.github.io")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.includes(origin);
}

function jsonResponse(value: unknown, status: number, headers = new Headers()): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

function errorResponse(error: ApiFailure, headers: Headers): Response {
  return jsonResponse({ error: { code: error.code, message: error.message } }, error.status, headers);
}

async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiFailure(413, "request_too_large", "Request is too large");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ApiFailure(413, "request_too_large", "Request is too large");
      }
      chunks.push(next.value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiFailure(400, "invalid_json", "Request JSON is invalid");
  }
}

function parseAuthRequest(value: unknown): { identifier: string; password: string } {
  if (!isRecord(value) || !exactKeys(value, ["identifier", "password"]) ||
      typeof value.identifier !== "string" || typeof value.password !== "string") {
    throw new ApiFailure(400, "invalid_json", "Request JSON is invalid");
  }
  return { identifier: value.identifier, password: value.password };
}

function parsePushRequest(value: unknown): Operation[] {
  if (!isRecord(value) || !exactKeys(value, ["operations"]) || !Array.isArray(value.operations)) {
    throw new ApiFailure(400, "invalid_json", "Request JSON is invalid");
  }
  return value.operations.map((raw) => {
    if (!isRecord(raw) || !exactKeys(raw, ["opId", "entityType", "entityId", "baseRevision", "action", "payload", "createdAt"]) ||
        typeof raw.opId !== "string" || typeof raw.entityType !== "string" || typeof raw.entityId !== "string" ||
        typeof raw.baseRevision !== "number" || !Number.isSafeInteger(raw.baseRevision) ||
        typeof raw.action !== "string" || typeof raw.createdAt !== "string" ||
        (raw.entityType !== "notebook" && raw.entityType !== "page") ||
        (raw.action !== "upsert" && raw.action !== "delete")) {
      throw new ApiFailure(400, "invalid_json", "Request JSON is invalid");
    }
    return {
      opId: raw.opId,
      entityType: raw.entityType,
      entityId: raw.entityId,
      baseRevision: raw.baseRevision,
      action: raw.action,
      payload: raw.payload,
      createdAt: raw.createdAt,
    };
  });
}

function exactKeys(value: JsonRecord, keys: string[]): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clientKey(request: Request): string {
  const cloudflareIp = request.headers.get("CF-Connecting-IP")?.trim();
  if (cloudflareIp) return cloudflareIp;
  return request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("Authorization");
  if (!value || !/^Bearer\s/i.test(value)) return null;
  const token = value.slice(7).trim();
  return token || null;
}

function parseCursor(value: string | null): number {
  if (value === null || !/^[+-]?[0-9]+$/.test(value)) throw new ApiFailure(400, "invalid_cursor", "Cursor is required");
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new ApiFailure(400, "invalid_cursor", "Cursor is invalid");
  return cursor;
}

function parseLimit(value: string | null): number {
  if (value === null || !/^[+-]?[0-9]+$/.test(value)) return 100;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return 100;
  return Math.min(100, Math.max(1, parsed));
}

function normalizeIdentifier(value: string): string {
  const identifier = value.trim().toLowerCase();
  if (identifier.length < 3 || identifier.length > 254 || [...identifier].some((char) => /\s/.test(char) || char.codePointAt(0)! < 0x21)) {
    throw new ApiFailure(400, "invalid_identifier", "Identifier is invalid");
  }
  return identifier;
}

function validatePassword(value: string): void {
  if (value.length < 12 || value.length > 128) throw new ApiFailure(400, "invalid_password", "Password must be 12 to 128 characters");
}

function rateLimit(object: ApiDurableObject, client: string, identifier: string, action: "register" | "login"): void {
  const clientAllowed = object.getClientLimiter().allow(`${action}-client:${client}`);
  const identifierAllowed = object.getIdentifierLimiter().allow(`${action}-identifier:${identifier}`);
  if (!clientAllowed || !identifierAllowed) throw new ApiFailure(429, "rate_limited", "Too many attempts");
}

interface AuthResponse {
  user: { id: string; identifier: string };
  sessionToken: string;
  expiresAt: string;
}

async function register(
  db: D1Database,
  request: { identifier: string; password: string },
  client: string,
  object: ApiDurableObject,
): Promise<AuthResponse> {
  const identifier = normalizeIdentifier(request.identifier);
  validatePassword(request.password);
  rateLimit(object, client, identifier, "register");
  const hash = await hashPassword(request.password);
  const userId = crypto.randomUUID();
  const response = await issueSession(userId, identifier);
  try {
    await db.batch([
      db.prepare("INSERT INTO users(id, identifier, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(userId, identifier, hash.salt, hash.hash, new Date().toISOString()),
      db.prepare("INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(response.tokenHash, userId, response.createdAt, response.expiresAt),
    ]);
  } catch (error) {
    if (isConstraintError(error)) throw new ApiFailure(409, "identifier_unavailable", "This identifier is already registered");
    throw error;
  }
  return response.auth;
}

async function login(
  db: D1Database,
  request: { identifier: string; password: string },
  client: string,
  object: ApiDurableObject,
): Promise<AuthResponse> {
  const identifier = normalizeIdentifier(request.identifier);
  if (request.password.length < 1 || request.password.length > 128) throw new ApiFailure(401, "invalid_credentials", "Invalid credentials");
  rateLimit(object, client, identifier, "login");
  const credentials = await db.prepare("SELECT id, identifier, salt, password_hash FROM users WHERE identifier = ?")
    .bind(identifier)
    .first<{ id: string; identifier: string; salt: string; password_hash: string }>();
  const actual = await derivePassword(request.password, credentials ? decodeBase64Url(credentials.salt) : DUMMY_SALT);
  const expected = credentials ? decodeBase64Url(credentials.password_hash) : new Uint8Array(0);
  if (!constantTimeEqual(actual, expected) || !credentials) throw new ApiFailure(401, "invalid_credentials", "Invalid credentials");
  const response = await issueSession(credentials.id, credentials.identifier);
  await db.prepare("INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(response.tokenHash, credentials.id, response.createdAt, response.expiresAt)
    .run();
  return response.auth;
}

async function issueSession(userId: string, identifier: string): Promise<{
  auth: AuthResponse;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
}> {
  const token = base64Url(crypto.getRandomValues(new Uint8Array(SESSION_BYTES)));
  const tokenHash = await sha256Base64(token);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return { auth: { user: { id: userId, identifier }, sessionToken: token, expiresAt }, tokenHash, createdAt, expiresAt };
}

async function authenticate(db: D1Database, token: string | null): Promise<{ id: string; identifier: string }> {
  if (!token || token.length > 256) throw new ApiFailure(401, "unauthorized", "Authentication required");
  const tokenHash = await sha256Base64(token);
  const user = await db.prepare(
    "SELECT users.id, users.identifier, sessions.expires_at, sessions.revoked_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?",
  ).bind(tokenHash).first<{ id: string; identifier: string; expires_at: string; revoked_at: string | null }>();
  if (!user || user.revoked_at !== null || !Number.isFinite(Date.parse(user.expires_at)) || Date.parse(user.expires_at) < Date.now()) {
    throw new ApiFailure(401, "unauthorized", "Authentication required");
  }
  return { id: user.id, identifier: user.identifier };
}

async function logout(db: D1Database, token: string | null): Promise<void> {
  if (!token || token.length > 256) return;
  await db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?").bind(new Date().toISOString(), await sha256Base64(token)).run();
}

async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await derivePassword(password, salt);
  return { salt: base64Url(salt), hash: base64Url(derived) };
}

export async function derivePassword(password: string, salt: Uint8Array): Promise<Uint8Array> {
  try {
    const key = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, key, PBKDF2_BITS);
    const result = new Uint8Array(bits);
    if (result.byteLength !== PBKDF2_BITS / 8) throw new Error("PBKDF2 returned an invalid length");
    return result;
  } catch (nativeError) {
    try {
      // Audited @noble/hashes fallback keeps the exact 600,000-round contract
      // when a Workers runtime rejects the native iteration count.
      return await pbkdf2Async(sha256, textEncoder.encode(password), salt, { c: PBKDF2_ITERATIONS, dkLen: PBKDF2_BITS / 8 });
    } catch {
      void nativeError;
      throw new ApiFailure(503, "crypto_unavailable", "Password hashing is unavailable in this runtime");
    }
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return new Uint8Array(0);
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return new Uint8Array(0);
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  const max = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < max; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

async function sha256Base64(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value))));
}

function isConstraintError(error: unknown): boolean {
  return /unique|constraint/i.test(error instanceof Error ? error.message : String(error));
}

function parseOperationPayload(value: unknown, operation: Operation, documents: Map<string, StoredDocument>): ValidatedOperation {
  const payloadBytes = textEncoder.encode(JSON.stringify(value)).byteLength;
  if (payloadBytes > MAX_PAYLOAD_BYTES) throw new ApiFailure(413, "payload_too_large", "Note payload is too large");
  if (!UUID_RE.test(operation.opId) || !UUID_RE.test(operation.entityId)) {
    throw new ApiFailure(400, "invalid_id", "Invalid operation or entity ID");
  }
  if (operation.baseRevision < 0) throw new ApiFailure(400, "invalid_revision", "Revision must be non-negative");

  if (operation.entityType === "notebook") {
    const notebook = parseNotebook(value, operation.entityId);
    return { value: notebook, deleted: operation.action === "delete" || notebook.deletedAt !== null };
  }

  const page = parsePage(value, operation.entityId);
  const parent = documents.get(documentKey("notebook", page.notebookId));
  if (!parent) throw new ApiFailure(400, "notebook_not_found", "Notebook does not exist");
  if (parent.deleted && operation.action === "upsert") {
    throw new ApiFailure(409, "notebook_deleted", "Restore the notebook before editing this page");
  }
  return { value: page, deleted: operation.action === "delete" || page.deletedAt !== null, notebookId: page.notebookId };
}

function parseNotebook(value: unknown, expectedId: string): NotebookPayload {
  if (!isRecord(value) || !keysIn(value, ["id", "title", "createdAt", "updatedAt", "deletedAt", "revision"]) ||
      !hasKeys(value, ["id", "title", "createdAt", "updatedAt"]) ||
      typeof value.id !== "string" || typeof value.title !== "string" || typeof value.createdAt !== "string" ||
      typeof value.updatedAt !== "string") {
    throw new ApiFailure(400, "invalid_payload", "Note payload is invalid");
  }
  if (value.id !== expectedId || !UUID_RE.test(value.id)) throw new ApiFailure(400, "invalid_id", "Payload ID does not match operation");
  if (value.title.trim().length === 0 || value.title.length > 500) throw new ApiFailure(400, "invalid_notebook", "Notebook title is invalid");
  const deletedAt = optionalString(value.deletedAt);
  const revision = optionalInteger(value.revision, 0);
  return { id: value.id, title: value.title, createdAt: value.createdAt, updatedAt: value.updatedAt, deletedAt, revision };
}

function parsePage(value: unknown, expectedId: string): PagePayload {
  if (!isRecord(value) || !keysIn(value, ["id", "notebookId", "title", "text", "background", "width", "height", "strokes", "formatVersion", "revision", "updatedAt", "deletedAt"]) ||
      !hasKeys(value, ["id", "notebookId", "title", "text", "updatedAt"]) ||
      typeof value.id !== "string" || typeof value.notebookId !== "string" || typeof value.title !== "string" ||
      typeof value.text !== "string" || typeof value.updatedAt !== "string") {
    throw new ApiFailure(400, "invalid_payload", "Note payload is invalid");
  }
  if (value.id !== expectedId || !UUID_RE.test(value.id)) throw new ApiFailure(400, "invalid_id", "Payload ID does not match operation");
  if (!UUID_RE.test(value.notebookId)) throw new ApiFailure(400, "invalid_notebook_id", "Invalid notebook ID");
  if (value.title.length > 500 || value.text.length > 1_000_000) throw new ApiFailure(400, "page_too_large", "Page text or title is too large");

  const background = value.background === undefined ? "blank" : value.background;
  if (background !== "blank" && background !== "ruled" && background !== "grid") throw new ApiFailure(400, "invalid_payload", "Note payload is invalid");
  const width = optionalNumber(value.width, 1024);
  const height = optionalNumber(value.height, 1366);
  if (width < 1 || width > 10_000 || height < 1 || height > 10_000) throw new ApiFailure(400, "invalid_page_size", "Page size is invalid");
  const formatVersion = optionalInteger(value.formatVersion, 1);
  if (formatVersion !== 1) throw new ApiFailure(400, "unsupported_format", "Unsupported ink format");
  const revision = optionalInteger(value.revision, 0);
  const deletedAt = optionalString(value.deletedAt);
  const strokesValue = value.strokes === undefined ? [] : value.strokes;
  if (!Array.isArray(strokesValue)) throw new ApiFailure(400, "invalid_payload", "Note payload is invalid");
  if (strokesValue.length > MAX_STROKES) throw new ApiFailure(413, "too_many_strokes", "Page has too many strokes");
  const strokes: InkStroke[] = [];
  const strokeIds = new Set<string>();
  let points = 0;
  for (const rawStroke of strokesValue) {
    if (!isRecord(rawStroke) || !keysIn(rawStroke, ["id", "color", "width", "points"]) ||
        !hasKeys(rawStroke, ["id", "color", "width", "points"]) || typeof rawStroke.id !== "string" ||
        typeof rawStroke.color !== "number" || typeof rawStroke.width !== "number" || !Array.isArray(rawStroke.points)) {
      throw new ApiFailure(400, "invalid_stroke", "Stroke is invalid");
    }
    if (!UUID_RE.test(rawStroke.id)) throw new ApiFailure(400, "invalid_id", "Invalid stroke ID");
    if (strokeIds.has(rawStroke.id)) throw new ApiFailure(400, "invalid_stroke", "Stroke is invalid");
    strokeIds.add(rawStroke.id);
    if (!Number.isFinite(rawStroke.width) || rawStroke.width < 0.1 || rawStroke.width > 100 || rawStroke.points.length === 0 ||
        !Number.isSafeInteger(rawStroke.color) || rawStroke.color < 0 || rawStroke.color > 0xffff_ffff) {
      throw new ApiFailure(400, "invalid_stroke", "Stroke is invalid");
    }
    const normalizedPoints: StrokePoint[] = [];
    let previousTime = -1;
    for (const rawPoint of rawStroke.points) {
      if (!isRecord(rawPoint) || !keysIn(rawPoint, ["x", "y", "pressure", "time", "tiltX", "tiltY"]) ||
          !hasKeys(rawPoint, ["x", "y"]) || typeof rawPoint.x !== "number" || typeof rawPoint.y !== "number" ||
          !Number.isFinite(rawPoint.x) || !Number.isFinite(rawPoint.y)) {
        throw new ApiFailure(400, "invalid_point", "Stroke point is invalid");
      }
      const pressure = optionalNumber(rawPoint.pressure, 0.5);
      const time = optionalInteger(rawPoint.time, 0);
      const tiltX = optionalNullableNumber(rawPoint.tiltX);
      const tiltY = optionalNullableNumber(rawPoint.tiltY);
      if (pressure < 0 || pressure > 1 || time < 0 || time < previousTime ||
          (tiltX !== null && (tiltX < -90 || tiltX > 90)) || (tiltY !== null && (tiltY < -90 || tiltY > 90))) {
        throw new ApiFailure(400, "invalid_point", "Stroke point is invalid");
      }
      previousTime = time;
      normalizedPoints.push({ x: rawPoint.x, y: rawPoint.y, pressure, time, tiltX, tiltY });
    }
    points += normalizedPoints.length;
    if (points > MAX_POINTS) throw new ApiFailure(413, "too_many_points", "Page has too many points");
    strokes.push({ id: rawStroke.id, color: rawStroke.color, width: rawStroke.width, points: normalizedPoints });
  }
  return {
    id: value.id,
    notebookId: value.notebookId,
    title: value.title,
    text: value.text,
    background,
    width,
    height,
    strokes,
    formatVersion,
    revision,
    updatedAt: value.updatedAt,
    deletedAt,
  };
}

function keysIn(value: JsonRecord, allowed: string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function hasKeys(value: JsonRecord, required: string[]): boolean {
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApiFailure(400, "invalid_payload", "Note payload is invalid");
  return value;
}

function optionalNumber(value: unknown, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ApiFailure(400, "invalid_payload", "Note payload is invalid");
  return value;
}

function optionalNullableNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return optionalNumber(value);
}

function optionalInteger(value: unknown, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new ApiFailure(400, "invalid_payload", "Note payload is invalid");
  return value;
}

function documentKey(entityType: EntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function canonicalPayload(value: NotebookPayload | PagePayload, action: SyncAction, revision: number): { payload: string; deleted: boolean; updatedAt: string } {
  const updatedAt = new Date().toISOString();
  const deletedAt = action === "delete" ? (value.deletedAt ?? updatedAt) : value.deletedAt;
  const canonical = "notebookId" in value
    ? {
        id: value.id,
        notebookId: value.notebookId,
        title: value.title,
        text: value.text,
        background: value.background,
        width: value.width,
        height: value.height,
        strokes: value.strokes.map((stroke) => ({
          id: stroke.id,
          color: stroke.color,
          width: stroke.width,
          points: stroke.points.map((point) => ({
            x: point.x,
            y: point.y,
            pressure: point.pressure,
            time: point.time,
            tiltX: point.tiltX,
            tiltY: point.tiltY,
          })),
        })),
        formatVersion: value.formatVersion,
        revision,
        updatedAt,
        deletedAt,
      }
    : {
        id: value.id,
        title: value.title,
        createdAt: value.createdAt,
        updatedAt,
        deletedAt,
        revision,
      };
  const payload = JSON.stringify(canonical);
  if (textEncoder.encode(payload).byteLength > MAX_PAYLOAD_BYTES) throw new ApiFailure(413, "payload_too_large", "Note payload is too large");
  return { payload, deleted: action === "delete" || deletedAt !== null, updatedAt };
}

async function payloadChunks(payload: string): Promise<PayloadChunks> {
  const bytes = textEncoder.encode(payload);
  if (bytes.byteLength <= INLINE_PAYLOAD_BYTES) return { storedPayload: payload, chunks: [] };
  const chunks = splitUtf8(bytes);
  const payloadRef = await sha256Base64(payload);
  return {
    storedPayload: `${PAYLOAD_MARKER_PREFIX}${payloadRef}:${bytes.byteLength}:${chunks.length}`,
    chunks,
  };
}

function splitUtf8(bytes: Uint8Array): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < bytes.byteLength;) {
    let end = Math.min(bytes.byteLength, start + PAYLOAD_CHUNK_BYTES);
    while (end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    if (end <= start) throw new ApiFailure(500, "internal_error", "The server could not split a note payload");
    chunks.push(new TextDecoder().decode(bytes.slice(start, end)));
    start = end;
  }
  return chunks;
}

interface PayloadMarker {
  ref: string;
  bytes: number;
  parts: number;
}

function parsePayloadMarker(value: string): PayloadMarker | null {
  if (!value.startsWith(PAYLOAD_MARKER_PREFIX)) return null;
  const match = /^@payload:([A-Za-z0-9_-]{43}):([1-9][0-9]*):([1-9][0-9]*)$/.exec(value);
  if (!match) throw new ApiFailure(500, "internal_error", "The server could not complete the request");
  const bytes = Number(match[2]);
  const parts = Number(match[3]);
  if (!Number.isSafeInteger(bytes) || bytes > MAX_PAYLOAD_BYTES || !Number.isSafeInteger(parts) || parts < 2 || parts > Math.ceil(MAX_PAYLOAD_BYTES / PAYLOAD_CHUNK_BYTES) + 1) {
    throw new ApiFailure(500, "internal_error", "The server could not complete the request");
  }
  return { ref: match[1]!, bytes, parts };
}

async function hydratePayloads(db: D1Database, userId: string, storedPayloads: string[]): Promise<Map<string, string>> {
  const markers = [...new Set(storedPayloads.filter((value) => parsePayloadMarker(value) !== null))].map((value) => parsePayloadMarker(value)!);
  if (markers.length === 0) return new Map();
  const chunksByRef = new Map<string, string[]>();
  for (const marker of markers) chunksByRef.set(marker.ref, []);
  const statements: D1PreparedStatement[] = [];
  for (const group of chunks(markers, MAX_SQL_PARAMETERS - 1)) {
    const placeholders = group.map(() => "?").join(",");
    statements.push(db.prepare(
      `SELECT payload_ref, chunk_index, payload FROM payload_chunks WHERE user_id = ? AND payload_ref IN (${placeholders}) ORDER BY payload_ref, chunk_index`,
    ).bind(userId, ...group.map((marker) => marker.ref)));
  }
  const rows = await db.batch(statements);
  for (const batch of rows) {
    for (const row of rowsFrom(batch)) {
      const typed = row as { payload_ref?: unknown; chunk_index?: unknown; payload?: unknown };
      if (typeof typed.payload_ref !== "string" || typeof typed.payload !== "string") {
        throw new ApiFailure(500, "internal_error", "The server could not complete the request");
      }
      const index = nullableInteger(typed.chunk_index);
      const target = chunksByRef.get(typed.payload_ref);
      if (index === null || !target || index !== target.length) {
        throw new ApiFailure(500, "internal_error", "The server could not complete the request");
      }
      target.push(typed.payload);
    }
  }
  const result = new Map<string, string>();
  for (const marker of markers) {
    const parts = chunksByRef.get(marker.ref)!;
    if (parts.length !== marker.parts) throw new ApiFailure(500, "internal_error", "The server could not complete the request");
    const payload = parts.join("");
    if (textEncoder.encode(payload).byteLength !== marker.bytes) throw new ApiFailure(500, "internal_error", "The server could not complete the request");
    result.set(`${PAYLOAD_MARKER_PREFIX}${marker.ref}:${marker.bytes}:${marker.parts}`, payload);
  }
  return result;
}

async function hydrateDocument(db: D1Database, userId: string, document: StoredDocument): Promise<string> {
  if (document.payload !== null) return document.payload;
  const marker = parsePayloadMarker(document.storedPayload);
  let payload: string | undefined;
  if (marker) {
    payload = (await hydratePayloads(db, userId, [document.storedPayload])).get(document.storedPayload);
  } else {
    const row = await db.prepare("SELECT payload FROM documents WHERE user_id = ? AND entity_type = ? AND entity_id = ?")
      .bind(userId, document.entityType, document.entityId)
      .first<{ payload?: unknown }>();
    if (typeof row?.payload === "string") {
      payload = row.payload;
      document.storedPayload = row.payload;
    }
  }
  if (payload === undefined) throw new ApiFailure(500, "internal_error", "The server could not complete the request");
  document.payload = payload;
  return payload;
}

function operationWireJson(operation: Operation): string {
  return JSON.stringify({
    opId: operation.opId,
    entityType: operation.entityType,
    entityId: operation.entityId,
    baseRevision: operation.baseRevision,
    action: operation.action,
    payload: operation.payload,
    createdAt: operation.createdAt,
  });
}

function toPushResult(
  opId: string,
  status: PushStatus,
  revision: number | null = null,
  sequence: number | null = null,
  serverPayload: JsonRecord | null = null,
  code: string | null = null,
): PushResult {
  return { opId, status, revision, sequence, serverPayload, code };
}

function storedResult(row: StoredOperation): PushResult {
  let serverPayload: JsonRecord | null = null;
  if (row.server_payload !== null) {
    try {
      const parsed: unknown = JSON.parse(row.server_payload);
      if (!isRecord(parsed)) throw new Error("invalid stored payload");
      serverPayload = parsed;
    } catch {
      throw new ApiFailure(500, "internal_error", "The server could not complete the request");
    }
  } else if (row.serverPayloadStorage !== null) {
    throw new ApiFailure(500, "internal_error", "The server could not complete the request");
  }
  const status: PushStatus = row.status === "acked" ? "acked" : row.status === "conflict" ? "conflict" : "rejected";
  return toPushResult(row.opId, status, row.revision, row.sequence, serverPayload, row.code);
}

async function push(db: D1Database, userId: string, operations: Operation[]): Promise<{ results: PushResult[]; cursor: number }> {
  if (operations.length > MAX_PUSH_OPERATIONS) throw new ApiFailure(413, "too_many_operations", `At most ${MAX_PUSH_OPERATIONS} operations may be sent`);
  const wireJson = operations.map(operationWireJson);
  const aggregateBytes = textEncoder.encode(`{"operations":[${wireJson.join(",")}]}`).byteLength;
  if (operations.length > 1 && aggregateBytes > MAX_MULTI_OPERATION_BYTES) {
    throw new ApiFailure(413, "too_many_operations", "Large note changes must be sent one at a time");
  }
  const hashes = await Promise.all(wireJson.map((value) => sha256Base64(value)));
  const stored = await loadStoredOperations(db, userId, operations.map((operation) => operation.opId));
  const documents = await loadDocuments(db, userId, operations);
  const predicted = new Map<string, StoredDocument>(documents);
  const plannedByOperation = new Map<string, { requestHash: string; result: PushResult }>();
  const plans: WritePlan[] = [];
  const results: PushResult[] = [];
  let conflictHydrationQueries = 0;
  let storedHydrationQueries = 0;

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index]!;
    const requestHash = hashes[index]!;
    const prior = plannedByOperation.get(operation.opId);
    if (prior) {
      const result = prior.requestHash === requestHash
        ? prior.result
        : toPushResult(operation.opId, "rejected", null, null, null, "idempotency_mismatch");
      results.push(result);
      continue;
    }

    const existing = stored.get(operation.opId);
    if (existing && existing.request_hash !== requestHash) {
      const result = toPushResult(operation.opId, "rejected", null, null, null, "idempotency_mismatch");
      plannedByOperation.set(operation.opId, { requestHash, result });
      results.push(result);
      continue;
    }
    if (existing && existing.status !== "processing") {
      if (existing.serverPayloadStorage !== null && existing.server_payload === null) storedHydrationQueries += 1;
      await hydrateStoredOperation(db, userId, existing);
      const result = storedResult(existing);
      plannedByOperation.set(operation.opId, { requestHash, result });
      results.push(result);
      continue;
    }

    let validated: ValidatedOperation;
    try {
      validated = parseOperationPayload(operation.payload, operation, predicted);
    } catch (error) {
      const failure = error instanceof ApiFailure ? error : new ApiFailure(400, "invalid_payload", "Note payload is invalid");
      const result = toPushResult(operation.opId, "rejected", null, null, null, failure.code);
      plannedByOperation.set(operation.opId, { requestHash, result });
      plans.push({ kind: "final", operation, requestHash, serverPayloadStorage: null, result });
      results.push(result);
      continue;
    }

    const current = predicted.get(documentKey(operation.entityType, operation.entityId));
    const currentRevision = current?.revision ?? 0;
    if (operation.baseRevision !== currentRevision) {
      if (current?.payload === null) conflictHydrationQueries += 1;
      const currentPayload = current ? await hydrateDocument(db, userId, current) : null;
      const result = toPushResult(
        operation.opId,
        "conflict",
        currentRevision,
        null,
        currentPayload ? parseStoredPayload(currentPayload) : null,
        "revision_conflict",
      );
      plannedByOperation.set(operation.opId, { requestHash, result });
      plans.push({ kind: "final", operation, requestHash, serverPayloadStorage: current?.storedPayload ?? null, result });
      results.push(result);
      continue;
    }

    const canonical = canonicalPayload(validated.value, operation.action, currentRevision + 1);
    const storedPayload = await payloadChunks(canonical.payload);
    const document: StoredDocument = {
      entityType: operation.entityType,
      entityId: operation.entityId,
      revision: currentRevision + 1,
      payload: canonical.payload,
      storedPayload: storedPayload.storedPayload,
      deleted: canonical.deleted,
      updatedAt: canonical.updatedAt,
    };
    const result = toPushResult(operation.opId, "acked", document.revision, null, null, null);
    plannedByOperation.set(operation.opId, { requestHash, result });
    plans.push({ kind: "ack", operation, requestHash, document, payloadChunks: storedPayload, action: operation.action, result });
    predicted.set(documentKey(operation.entityType, operation.entityId), document);
    results.push(result);
  }

  const operationWriteStatements = plans.reduce((total, plan) => total + (plan.kind === "ack"
    ? Math.ceil(plan.payloadChunks.chunks.length / MAX_CHUNKS_PER_STATEMENT) + 4
    : 1), 0);
  const receiptHydrationQueries = plans.reduce((total, plan) => total + (plan.kind === "final" && plan.result.serverPayload !== null ? 1 : 0), 0);
  if (operationWriteStatements + conflictHydrationQueries + storedHydrationQueries + receiptHydrationQueries > MAX_BATCH_STATEMENTS) {
    throw new ApiFailure(413, "too_many_operations", "This push exceeds the server query budget");
  }
  await persistPlans(db, userId, plans);
  if (plans.length > 0) {
    const receipts = await loadStoredOperations(db, userId, operations.map((operation) => operation.opId));
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]!;
      if (result.code === "idempotency_mismatch") continue;
      const receipt = receipts.get(result.opId);
      if (receipt && receipt.request_hash === hashes[index]) {
        await hydrateStoredOperation(db, userId, receipt);
        results[index] = storedResult(receipt);
      }
    }
  }
  const cursor = await maxUserSequence(db, userId);
  return { results, cursor };
}

function parseStoredPayload(payload: string): JsonRecord {
  try {
    const value: unknown = JSON.parse(payload);
    if (!isRecord(value)) throw new Error("stored payload is not an object");
    return value;
  } catch {
    throw new ApiFailure(500, "internal_error", "The server could not complete the request");
  }
}

async function loadStoredOperations(db: D1Database, userId: string, opIds: string[]): Promise<Map<string, StoredOperation>> {
  const unique = [...new Set(opIds)];
  if (unique.length === 0) return new Map();
  const statements: D1PreparedStatement[] = [];
  for (const chunk of chunks(unique, MAX_SQL_PARAMETERS - 1)) {
    const placeholders = chunk.map(() => "?").join(",");
    statements.push(db.prepare(
      `SELECT op_id, request_hash, status, revision, sequence,
         CASE WHEN server_payload IS NULL THEN NULL
              WHEN substr(server_payload, 1, ${PAYLOAD_MARKER_PREFIX.length}) = '${PAYLOAD_MARKER_PREFIX}' THEN server_payload
              ELSE '' END AS server_payload_storage,
         server_payload IS NOT NULL AS has_server_payload, code
       FROM sync_operations WHERE user_id = ? AND op_id IN (${placeholders})`,
    ).bind(userId, ...chunk));
  }
  const rows = await db.batch(statements);
  const result = new Map<string, StoredOperation>();
  for (const batch of rows) {
    for (const row of rowsFrom(batch)) {
      const typed = row as { op_id?: unknown; request_hash?: unknown; status?: unknown; revision?: unknown; sequence?: unknown; server_payload_storage?: unknown; has_server_payload?: unknown; code?: unknown };
      if (typeof typed.op_id !== "string" || typeof typed.request_hash !== "string" || typeof typed.status !== "string") continue;
      const hasServerPayload = Number(typed.has_server_payload) !== 0;
      const serverPayloadStorage = hasServerPayload
        ? typeof typed.server_payload_storage === "string" ? typed.server_payload_storage : null
        : null;
      result.set(typed.op_id, {
        opId: typed.op_id,
        request_hash: typed.request_hash,
        status: typed.status,
        revision: nullableInteger(typed.revision),
        sequence: nullableInteger(typed.sequence),
        server_payload: null,
        serverPayloadStorage,
        code: typed.code === null || typed.code === undefined ? null : String(typed.code),
      });
    }
  }
  return result;
}

async function hydrateStoredOperation(db: D1Database, userId: string, operation: StoredOperation): Promise<void> {
  if (operation.serverPayloadStorage === null || operation.server_payload !== null) return;
  const marker = parsePayloadMarker(operation.serverPayloadStorage);
  if (marker) {
    const hydrated = await hydratePayloads(db, userId, [operation.serverPayloadStorage]);
    operation.server_payload = hydrated.get(operation.serverPayloadStorage) ?? null;
    if (operation.server_payload === null) throw new ApiFailure(500, "internal_error", "The server could not complete the request");
    return;
  }
  const row = await db.prepare("SELECT server_payload FROM sync_operations WHERE user_id = ? AND op_id = ?")
    .bind(userId, operation.opId)
    .first<{ server_payload?: unknown }>();
  if (typeof row?.server_payload !== "string") throw new ApiFailure(500, "internal_error", "The server could not complete the request");
  operation.serverPayloadStorage = row.server_payload;
  operation.server_payload = row.server_payload;
}

async function loadDocuments(db: D1Database, userId: string, operations: Operation[]): Promise<Map<string, StoredDocument>> {
  const ids = new Set<string>();
  for (const operation of operations) {
    if (UUID_RE.test(operation.entityId)) ids.add(operation.entityId);
    if (operation.entityType === "page" && isRecord(operation.payload) && typeof operation.payload.notebookId === "string" && UUID_RE.test(operation.payload.notebookId)) {
      ids.add(operation.payload.notebookId);
    }
  }
  const unique = [...ids];
  if (unique.length === 0) return new Map();
  const statements: D1PreparedStatement[] = [];
  for (const chunk of chunks(unique, MAX_SQL_PARAMETERS - 1)) {
    const placeholders = chunk.map(() => "?").join(",");
    statements.push(db.prepare(
      `SELECT entity_type, entity_id, revision,
         CASE WHEN substr(payload, 1, ${PAYLOAD_MARKER_PREFIX.length}) = '${PAYLOAD_MARKER_PREFIX}' THEN payload ELSE '' END AS payload_storage,
         deleted, updated_at
       FROM documents WHERE user_id = ? AND entity_id IN (${placeholders})`,
    ).bind(userId, ...chunk));
  }
  const rows = await db.batch(statements);
  const result = new Map<string, StoredDocument>();
  for (const batch of rows) {
    for (const row of rowsFrom(batch)) {
      const typed = row as { entity_type?: unknown; entity_id?: unknown; revision?: unknown; payload_storage?: unknown; deleted?: unknown; updated_at?: unknown };
      if ((typed.entity_type !== "notebook" && typed.entity_type !== "page") || typeof typed.entity_id !== "string" || typeof typed.payload_storage !== "string") continue;
      if (typed.payload_storage) parsePayloadMarker(typed.payload_storage);
      const document: StoredDocument = {
        entityType: typed.entity_type,
        entityId: typed.entity_id,
        revision: nullableInteger(typed.revision) ?? 0,
        payload: null,
        storedPayload: typed.payload_storage,
        deleted: Number(typed.deleted) !== 0,
        updatedAt: String(typed.updated_at ?? ""),
      };
      result.set(documentKey(document.entityType, document.entityId), document);
    }
  }
  return result;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function rowsFrom(result: { results?: unknown[] | null }): unknown[] {
  return Array.isArray(result.results) ? result.results : [];
}

function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

async function persistPlans(db: D1Database, userId: string, plans: WritePlan[]): Promise<void> {
  let statements: D1PreparedStatement[] = [];
  const flush = async (): Promise<void> => {
    if (statements.length === 0) return;
    await db.batch(statements);
    statements = [];
  };
  for (const plan of plans) {
    const next = plan.kind === "ack" ? ackStatements(db, userId, plan) : [finalOperationStatement(db, userId, plan)];
    if (statements.length > 0 && statements.length + next.length > MAX_BATCH_STATEMENTS) await flush();
    statements.push(...next);
  }
  await flush();
}

function finalOperationStatement(db: D1Database, userId: string, plan: FinalPlan): D1PreparedStatement {
  const { operation, requestHash, result, serverPayloadStorage } = plan;
  return db.prepare(
    `INSERT INTO sync_operations(user_id, op_id, request_hash, status, revision, sequence, server_payload, code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, op_id) DO UPDATE SET
       status = excluded.status, revision = excluded.revision, sequence = excluded.sequence,
       server_payload = excluded.server_payload, code = excluded.code
     WHERE sync_operations.request_hash = excluded.request_hash AND sync_operations.status = 'processing'`,
  ).bind(userId, operation.opId, requestHash, result.status, result.revision, result.sequence, serverPayloadStorage, result.code);
}

function ackStatements(db: D1Database, userId: string, plan: AckPlan): D1PreparedStatement[] {
  const { operation, requestHash, document, payloadChunks: stored, action } = plan;
  const parentGuard = operation.entityType === "page"
    ? `AND EXISTS (
         SELECT 1 FROM documents AS parent
         WHERE parent.user_id = ? AND parent.entity_type = 'notebook' AND parent.entity_id = ?
           ${action === "upsert" ? "AND parent.deleted = 0" : ""}
       )`
    : "";
  const parentValues = operation.entityType === "page"
    ? [userId, (parseStoredPayload(document.payload ?? "").notebookId as string)]
    : [];
  const documentWrite = db.prepare(
    `INSERT INTO documents(user_id, entity_type, entity_id, revision, payload, deleted, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM sync_operations
       WHERE user_id = ? AND op_id = ? AND request_hash = ? AND status = 'processing'
     )
     ${parentGuard}
     ON CONFLICT(user_id, entity_type, entity_id) DO UPDATE SET
       revision = excluded.revision, payload = excluded.payload,
       deleted = excluded.deleted, updated_at = excluded.updated_at
     WHERE documents.revision = ?`,
  ).bind(
    userId,
    operation.entityType,
    operation.entityId,
    document.revision,
    document.storedPayload,
    document.deleted ? 1 : 0,
    document.updatedAt,
    userId,
    operation.opId,
    requestHash,
    ...parentValues,
    document.revision - 1,
  );
  const changeInsert = db.prepare(
    `INSERT INTO changes(user_id, entity_type, entity_id, revision, action, payload)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM sync_operations
       WHERE user_id = ? AND op_id = ? AND request_hash = ? AND status = 'processing'
     )
       AND EXISTS (
         SELECT 1 FROM documents
         WHERE user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ? AND payload = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM changes
         WHERE user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ?
       )`,
  ).bind(
    userId,
    operation.entityType,
    operation.entityId,
    document.revision,
    action,
    document.storedPayload,
    userId,
    operation.opId,
    requestHash,
    userId,
    operation.entityType,
    operation.entityId,
    document.revision,
    document.storedPayload,
    userId,
    operation.entityType,
    operation.entityId,
    document.revision,
  );
  const finalUpdate = db.prepare(
    `UPDATE sync_operations SET status = 'acked', revision = ?,
       sequence = (
         SELECT sequence FROM changes
         WHERE user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ?
         ORDER BY sequence DESC LIMIT 1
       ), server_payload = NULL, code = NULL
     WHERE user_id = ? AND op_id = ? AND request_hash = ? AND status = 'processing'`,
  ).bind(
    document.revision,
    userId,
    operation.entityType,
    operation.entityId,
    document.revision,
    userId,
    operation.opId,
    requestHash,
  );
  const marker = stored.chunks.length > 0 ? parsePayloadMarker(stored.storedPayload) : null;
  if (stored.chunks.length > 0 && !marker) throw new ApiFailure(500, "internal_error", "The server could not store a note payload");
  const chunkWrites = chunks(stored.chunks, MAX_CHUNKS_PER_STATEMENT).map((group, groupIndex) => {
    const values = group.map(() => "(?, ?, ?, ?)").join(",");
    const bindings: unknown[] = [];
    for (let index = 0; index < group.length; index += 1) {
      bindings.push(userId, marker!.ref, groupIndex * MAX_CHUNKS_PER_STATEMENT + index, group[index]!);
    }
    return db.prepare(
      `WITH input(user_id, payload_ref, chunk_index, payload) AS (VALUES ${values})
       INSERT OR IGNORE INTO payload_chunks(user_id, payload_ref, chunk_index, payload)
       SELECT input.user_id, input.payload_ref, input.chunk_index, input.payload
       FROM input
       WHERE EXISTS (
         SELECT 1 FROM sync_operations
         WHERE user_id = ? AND op_id = ? AND request_hash = ? AND status = 'processing'
       )`,
    ).bind(...bindings, userId, operation.opId, requestHash);
  });
  return [
    db.prepare("INSERT OR IGNORE INTO sync_operations(user_id, op_id, request_hash, status) VALUES (?, ?, ?, 'processing')")
      .bind(userId, operation.opId, requestHash),
    ...chunkWrites,
    documentWrite,
    changeInsert,
    finalUpdate,
  ];
}

async function maxUserSequence(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM changes WHERE user_id = ?")
    .bind(userId)
    .first<{ max_sequence?: unknown }>();
  return nullableInteger(row?.max_sequence) ?? 0;
}

async function pull(db: D1Database, userId: string, cursor: number, limit: number): Promise<{ changes: Change[]; nextCursor: number; hasMore: boolean }> {
  const results = await db.batch([
    db.prepare("SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM changes WHERE user_id = ?").bind(userId),
    db.prepare(
      `SELECT sequence, entity_type, entity_id, revision, action,
         CASE WHEN substr(payload, 1, ${PAYLOAD_MARKER_PREFIX.length}) = '${PAYLOAD_MARKER_PREFIX}' THEN payload ELSE '' END AS payload_marker,
         length(CAST(payload AS BLOB)) AS payload_bytes
       FROM changes WHERE user_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
    ).bind(userId, cursor, limit + 1),
  ]);
  const maxSequence = nullableInteger((rowsFrom(results[0] ?? {}).at(0) as { max_sequence?: unknown } | undefined)?.max_sequence) ?? 0;
  if (cursor > maxSequence) throw new ApiFailure(409, "cursor_expired", "A full sync is required");
  const rawChanges: RawChange[] = rowsFrom(results[1] ?? {}).map((raw) => {
    const row = raw as { sequence?: unknown; entity_type?: unknown; entity_id?: unknown; revision?: unknown; action?: unknown; payload_marker?: unknown; payload_bytes?: unknown };
    if ((row.entity_type !== "notebook" && row.entity_type !== "page") || (row.action !== "upsert" && row.action !== "delete") ||
        typeof row.entity_id !== "string" || typeof row.payload_marker !== "string") {
      throw new ApiFailure(500, "internal_error", "The server could not complete the request");
    }
    const sequence = nullableInteger(row.sequence);
    const revision = nullableInteger(row.revision);
    const payloadBytes = nullableInteger(row.payload_bytes);
    if (sequence === null || revision === null || payloadBytes === null || payloadBytes < 1) throw new ApiFailure(500, "internal_error", "The server could not complete the request");
    const entityType: EntityType = row.entity_type;
    const action: SyncAction = row.action;
    if (row.payload_marker) parsePayloadMarker(row.payload_marker);
    return {
      sequence,
      entityType,
      entityId: row.entity_id,
      revision,
      action,
      storedPayload: row.payload_marker,
      payloadBytes,
    };
  });
  const candidates = rawChanges.slice(0, limit);
  const selected: RawChange[] = [];
  let estimatedBytes = 0;
  for (const change of candidates) {
    const marker = parsePayloadMarker(change.storedPayload);
    const payloadBytes = marker?.bytes ?? change.payloadBytes;
    const changeBytes = payloadBytes + PULL_CHANGE_OVERHEAD_BYTES;
    if (selected.length > 0 && estimatedBytes + changeBytes > MAX_PULL_RESPONSE_BYTES) break;
    selected.push(change);
    estimatedBytes += changeBytes;
  }
  const inline = selected.filter((change) => !parsePayloadMarker(change.storedPayload));
  if (inline.length > 0) {
    const inlineStatements = chunks(inline, MAX_SQL_PARAMETERS - 1).map((group) => {
      const placeholders = group.map(() => "?").join(",");
      return db.prepare(
        `SELECT sequence, payload FROM changes WHERE user_id = ? AND sequence IN (${placeholders})`,
      ).bind(userId, ...group.map((change) => change.sequence));
    });
    const inlineRows = await db.batch(inlineStatements);
    const payloadBySequence = new Map<number, string>();
    for (const batch of inlineRows) {
      for (const row of rowsFrom(batch)) {
        const typed = row as { sequence?: unknown; payload?: unknown };
        const sequence = nullableInteger(typed.sequence);
        if (sequence === null || typeof typed.payload !== "string") throw new ApiFailure(500, "internal_error", "The server could not complete the request");
        payloadBySequence.set(sequence, typed.payload);
      }
    }
    for (const change of inline) {
      const payload = payloadBySequence.get(change.sequence);
      if (payload === undefined) throw new ApiFailure(500, "internal_error", "The server could not complete the request");
      change.storedPayload = payload;
    }
  }
  const hydrated = await hydratePayloads(db, userId, selected.map((change) => change.storedPayload));
  const changes = selected.map((change) => ({
    sequence: change.sequence,
    entityType: change.entityType,
    entityId: change.entityId,
    revision: change.revision,
    action: change.action,
    payload: parseStoredPayload(hydrated.get(change.storedPayload) ?? change.storedPayload),
  }));
  const hasMore = rawChanges.length > selected.length;
  return { changes, nextCursor: changes.at(-1)?.sequence ?? cursor, hasMore };
}
