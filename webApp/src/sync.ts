import {
  AuthResponse,
  PullChange,
  PullResponse,
  PushResponse,
  PushResult,
  SyncAction,
  SyncEntityType,
  SyncOperation,
  toWirePayload,
} from "./models";
import { fetchWithTimeout, getEndpoint, parseJSON, readError } from "./auth";
import { NoteStore } from "./storage";

const MAX_PUSH_OPERATIONS = 10;
const MAX_PULL_CHANGES = 100;
const MAX_PUSH_BYTES = 3 * 1024 * 1024;
const MAX_OPERATION_PAYLOAD_BYTES = 1_900_000;
const MAX_PULL_PAGES = 1000;

export interface SyncReport {
  pushed: number;
  pulled: number;
  conflicts: number;
}

export class SyncHttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "SyncHttpError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Select a bounded push batch without placing two revisions of one entity in
 * the same request. A sending operation is deliberately eligible: it is the
 * durable retry record left behind when a previous request did not finish.
 */
export function selectPushBatch(operations: SyncOperation[], maxBytes = MAX_PUSH_BYTES): SyncOperation[] {
  const batch: SyncOperation[] = [];
  const entities = new Set<string>();
  for (const operation of operations) {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(toWirePayload(operation))).byteLength;
    if (payloadBytes > MAX_OPERATION_PAYLOAD_BYTES) throw new Error("A note change is larger than the server payload limit.");
    const entityKey = `${operation.entityType}:${operation.entityId}`;
    if (entities.has(entityKey)) continue;
    if (new TextEncoder().encode(JSON.stringify(toWireOperation(operation))).byteLength > MAX_OPERATION_PAYLOAD_BYTES) {
      throw new Error("A note change is larger than the server payload limit.");
    }
    const candidate = [...batch, operation];
    const size = encodedPushSize(candidate);
    if (size > maxBytes) {
      if (batch.length === 0) throw new Error("A note change is larger than the server request limit.");
      break;
    }
    batch.push(operation);
    entities.add(entityKey);
    if (batch.length >= MAX_PUSH_OPERATIONS) break;
  }
  return batch;
}

function encodedPushSize(operations: SyncOperation[]): number {
  return new TextEncoder().encode(JSON.stringify({ operations: operations.map(toWireOperation) })).byteLength;
}

function toWireOperation(operation: SyncOperation): Record<string, unknown> {
  return {
    opId: operation.opId,
    entityType: operation.entityType,
    entityId: operation.entityId,
    baseRevision: operation.baseRevision,
    action: operation.action,
    payload: toWirePayload(operation),
    createdAt: operation.createdAt,
  };
}

export class SyncClient {
  private active: Promise<SyncReport> | null = null;

  async sync(store: NoteStore, session: AuthResponse | null): Promise<SyncReport> {
    if (this.active) return this.active;
    const run = this.runSync(store, session);
    this.active = run;
    try {
      return await run;
    } finally {
      if (this.active === run) this.active = null;
    }
  }

  private async runSync(store: NoteStore, session: AuthResponse | null): Promise<SyncReport> {
    if (!session) throw new Error("Sign in before syncing.");
    const endpoint = getEndpoint();
    if (!endpoint) throw new Error("Add your HTTPS server URL in Settings before syncing.");
    const expectedAccountKey = `${endpoint}:${session.user.id.toLowerCase()}`;
    if (store.accountKey !== expectedAccountKey) {
      throw new Error("The selected notebook belongs to a different account or sync server.");
    }

    // close() waits for this lease. That keeps an account switch from closing
    // the SQLite handle while an authenticated request is still applying ACKs.
    const releaseLease = store.acquireSyncLease?.();
    try {
      const report: SyncReport = { pushed: 0, pulled: 0, conflicts: 0 };
      await this.pushAll(store, endpoint, session.sessionToken, report);
      await this.pullAll(store, endpoint, session.sessionToken, report);
      report.conflicts = Math.max(report.conflicts, (await store.listConflicts()).length);
      return report;
    } finally {
      releaseLease?.();
    }
  }

  private async pushAll(store: NoteStore, endpoint: string, token: string, report: SyncReport): Promise<void> {
    let rounds = 0;
    while (true) {
      if (++rounds > MAX_PULL_PAGES) throw new Error("Sync has too many pending note changes; try again later.");
      const available = await store.pendingOperations(MAX_PUSH_OPERATIONS);
      if (available.length === 0) return;
      const batch = selectPushBatch(available);
      if (batch.length === 0) throw new Error("Sync could not select a note change.");

      // Mark before sending. A process kill now leaves a sending row that will
      // be retried with the same opId and immutable payload.
      for (const operation of batch) await store.markOperationSending(operation.opId);
      const immutableBatch: SyncOperation[] = [];
      for (const operation of batch) {
        const stored = await store.getOperation(operation.opId);
        if (!stored) continue; // It was already acknowledged by another run.
        immutableBatch.push(stored);
      }
      if (immutableBatch.length === 0) continue;
      const push = await this.request<PushResponse>(`${endpoint}/v1/sync/push`, token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operations: immutableBatch.map(toWireOperation) }),
      });
      const results = validatePushResponse(push, immutableBatch);
      const byID = new Map(immutableBatch.map((operation) => [operation.opId, operation]));
      for (const result of results) {
        const operation = byID.get(result.opId);
        if (!operation) continue;
        if (result.status === "acked") {
          await store.markOperationAcked(result.opId, result.revision ?? undefined);
          report.pushed += 1;
          continue;
        }
        if (result.status === "conflict") {
          report.conflicts += 1;
          await store.createConflictCopyFromOperation(operation, operation.entityId);
          if (result.serverPayload) {
            const serverAction: SyncAction = typeof result.serverPayload.deletedAt === "string" ? "delete" : "upsert";
            await store.applyServerSnapshot({
              sequence: result.sequence ?? 0,
              entityType: operation.entityType,
              entityId: operation.entityId,
              revision: result.revision ?? 0,
              action: serverAction,
              payload: result.serverPayload,
            }, result.opId);
          }
          // Apply the authoritative snapshot while the rejected operation is
          // still present so equal revisions cannot make it look newer than
          // the server. Any newer local op remains queued and is rebased by
          // the store. With no server payload, leave the row's revision alone
          // so a subsequent pull can still apply the authoritative change.
          await store.markOperationAcked(result.opId, result.revision ?? undefined, Boolean(result.serverPayload));
          continue;
        }
        await store.createConflictCopyFromOperation(operation, operation.entityId);
        await store.markOperationAcked(result.opId, result.revision ?? undefined);
        throw new Error(result.code ? `The server rejected a note change (${result.code}).` : "The server rejected a note change.");
      }
      // PushResponse.cursor is only an informational high-water mark. Pull is
      // the sole owner of the local cursor because it returns every change.
    }
  }

  private async pullAll(store: NoteStore, endpoint: string, token: string, report: SyncReport): Promise<void> {
    let cursorReset = false;
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const cursor = await store.getCursor();
      let pull: PullResponse;
      try {
        pull = await this.request<PullResponse>(`${endpoint}/v1/sync/pull?cursor=${encodeURIComponent(String(cursor))}&limit=${MAX_PULL_CHANGES}`, token, { method: "GET" });
      } catch (error) {
        if (error instanceof SyncHttpError && error.status === 409 && error.code === "cursor_expired" && !cursorReset) {
          cursorReset = true;
          if (store.resetCursor) await store.resetCursor();
          else await store.setCursor(0);
          continue;
        }
        throw error;
      }
      const checked = validatePullResponse(pull, cursor);
      await store.applyRemoteBatch(checked.changes, checked.nextCursor);
      report.pulled += checked.changes.length;
      if (!checked.hasMore) return;
    }
    throw new Error("Sync returned too many pages; try again later.");
  }

  private async request<T>(input: RequestInfo | URL, token: string, init: RequestInit): Promise<T> {
    const response = await fetchWithTimeout(input, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
    const payload = await parseJSON(response);
    if (!response.ok) throw new SyncHttpError(response.status, readError(payload, `Sync failed (${response.status}).`), readCode(payload));
    return payload as unknown as T;
  }
}

function readCode(payload: Record<string, unknown>): string | undefined {
  const error = payload.error;
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  return undefined;
}

function validatePushResponse(payload: PushResponse, operations: SyncOperation[]): PushResult[] {
  if (!payload || !Array.isArray(payload.results) || !Number.isInteger(payload.cursor) || payload.cursor < 0) throw new Error("The server returned an invalid sync response.");
  const expected = new Set(operations.map((operation) => operation.opId));
  const seen = new Set<string>();
  for (const raw of payload.results) {
    if (!raw || typeof raw !== "object") throw new Error("The server returned an invalid sync result.");
    const result = raw as PushResult;
    if (typeof result.opId !== "string" || !expected.has(result.opId) || seen.has(result.opId)) throw new Error("The server returned an unknown or duplicate sync operation.");
    if (result.status !== "acked" && result.status !== "conflict" && result.status !== "rejected") throw new Error("The server returned an invalid sync status.");
    if (result.revision !== undefined && result.revision !== null && (!Number.isInteger(result.revision) || result.revision < 0)) throw new Error("The server returned an invalid revision.");
    if (result.sequence !== undefined && result.sequence !== null && (!Number.isInteger(result.sequence) || result.sequence < 0)) throw new Error("The server returned an invalid sequence.");
    if (result.serverPayload !== undefined && result.serverPayload !== null && (typeof result.serverPayload !== "object" || Array.isArray(result.serverPayload))) throw new Error("The server returned an invalid snapshot.");
    seen.add(result.opId);
  }
  if (seen.size !== expected.size) throw new Error("The server did not return every sync result.");
  return payload.results;
}

function validatePullResponse(payload: PullResponse, cursor: number): PullResponse {
  if (!payload || !Array.isArray(payload.changes) || !Number.isInteger(payload.nextCursor) || payload.nextCursor < cursor || typeof payload.hasMore !== "boolean") {
    throw new Error("The server returned an invalid pull response.");
  }
  let previous = cursor;
  for (const raw of payload.changes) {
    if (!raw || typeof raw !== "object") throw new Error("The server returned an invalid pull change.");
    const change = raw as PullChange;
    if (!Number.isInteger(change.sequence) || change.sequence <= previous || change.sequence > payload.nextCursor || !isEntityType(change.entityType) || !isAction(change.action) || !isUUID(change.entityId) || !Number.isInteger(change.revision) || change.revision < 0 || !change.payload || typeof change.payload !== "object" || Array.isArray(change.payload)) {
      throw new Error("The server returned an invalid pull change.");
    }
    previous = change.sequence;
  }
  if (payload.changes.length > 0 && payload.nextCursor !== previous) throw new Error("The server returned a non-monotonic pull cursor.");
  return payload;
}

function isEntityType(value: unknown): value is SyncEntityType { return value === "page" || value === "notebook"; }
function isAction(value: unknown): value is SyncAction { return value === "upsert" || value === "delete"; }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUUID(value: unknown): value is string { return typeof value === "string" && UUID_RE.test(value); }
