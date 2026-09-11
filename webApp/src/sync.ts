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
import { requestWithTimeout, getEndpoint, readError } from "./auth";
import { NoteStore } from "./storage";

const MAX_PUSH_OPERATIONS = 10;
const MAX_PULL_CHANGES = 100;
const MAX_PUSH_BYTES = 3 * 1024 * 1024;
const MAX_OPERATION_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_LARGE_PUSH_BYTES = 34 * 1024 * 1024;
const MAX_PENDING_OPERATIONS = 100;
const MAX_PULL_PAGES = 1000;
const MAX_PUSH_ROUNDS = 10;
const PUSH_BLOCKED_REASON = "A note change exceeds the 32 MiB server limit; it remains queued.";
const textEncoder = new TextEncoder();

export interface SyncReport {
  pushed: number;
  pulled: number;
  conflicts: number;
  blockedReason?: string;
  cleaned?: number;
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
  return selectPushBatchDetails(operations, maxBytes).batch;
}

interface SizedOperation {
  payloadBytes: number;
  requestBytes: number;
}

interface PushBatchSelection {
  batch: SyncOperation[];
  skippedOversized: boolean;
}

function selectPushBatchDetails(operations: SyncOperation[], maxBytes: number): PushBatchSelection {
  const batch: SyncOperation[] = [];
  const entities = new Set<string>();
  let skippedOversized = false;
  const envelopeBytes = encodedPushSize([]);
  let requestBytes = envelopeBytes;
  for (const operation of operations) {
    const item = sizeOperation(operation);
    const entityKey = `${operation.entityType}:${operation.entityId}`;
    // The outbox is ordered globally. Once a second revision of an entity is
    // reached, later entities must wait for the first revision's ACK; otherwise
    // a later notebook tombstone can overtake an earlier page restore, so the
    // server rejects that restore while the notebook is still deleted.
    if (entities.has(entityKey)) break;
    entities.add(entityKey);
    if (isOversized(item)) {
      skippedOversized = true;
      continue;
    }
    const size = requestBytes + item.requestBytes - envelopeBytes + (batch.length ? 1 : 0);
    if (size > maxBytes) {
      if (batch.length === 0 && item.requestBytes > maxBytes) {
        batch.push(operation);
        return { batch, skippedOversized };
      }
      break;
    }
    batch.push(operation);
    requestBytes = size;
    if (batch.length >= MAX_PUSH_OPERATIONS) break;
  }
  return { batch, skippedOversized };
}

function encodedPushSize(operations: SyncOperation[]): number {
  return textEncoder.encode(JSON.stringify({ operations: operations.map(toWireOperation) })).byteLength;
}

function sizeOperation(operation: SyncOperation): SizedOperation {
  const wire = toWireOperation(operation);
  return {
    payloadBytes: textEncoder.encode(JSON.stringify(wire.payload)).byteLength,
    requestBytes: textEncoder.encode(JSON.stringify({ operations: [wire] })).byteLength,
  };
}

function isOversized(operation: SizedOperation): boolean {
  return operation.payloadBytes > MAX_OPERATION_PAYLOAD_BYTES || operation.requestBytes > MAX_LARGE_PUSH_BYTES;
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
  private readonly active = new WeakMap<NoteStore, Promise<SyncReport>>();
  private readonly partialPulls = new WeakMap<NoteStore, { accountKey: string; count: number; conflicts: number; blockedReason?: string }>();

  async sync(store: NoteStore, session: AuthResponse | null): Promise<SyncReport> {
    const existing = this.active.get(store);
    if (existing) return existing;
    const run = this.runSync(store, session);
    this.active.set(store, run);
    try {
      return await run;
    } finally {
      if (this.active.get(store) === run) this.active.delete(store);
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
      try {
        await this.pushAll(store, endpoint, session.sessionToken, report);
        await this.pullAll(store, endpoint, session.sessionToken, report);
        const cleaned = await store.archiveEmptyConflictNotebooks?.() ?? 0;
        if (cleaned) report.cleaned = cleaned;
      } catch (error) {
        this.rememberPartialPull(store, expectedAccountKey, report);
        throw error;
      }
      const partial = this.partialPulls.get(store);
      if (partial?.accountKey === expectedAccountKey) {
        report.pulled += partial.count;
        report.conflicts += partial.conflicts;
        if (partial.blockedReason && !report.blockedReason) report.blockedReason = partial.blockedReason;
        this.partialPulls.delete(store);
      }
      return report;
    } finally {
      releaseLease?.();
    }
  }

  private async pushAll(store: NoteStore, endpoint: string, token: string, report: SyncReport): Promise<void> {
    // Continuous drawing must still give remote updates a turn. The durable
    // remainder is picked up by the coordinator's next scheduled run.
    for (let rounds = 0; rounds < MAX_PUSH_ROUNDS; rounds++) {
      const available = await store.pendingOperations(MAX_PENDING_OPERATIONS);
      if (available.length === 0) return;
      const selection = selectPushBatchDetails(available, MAX_PUSH_BYTES);
      if (selection.skippedOversized) report.blockedReason = PUSH_BLOCKED_REASON;
      const batch = selection.batch;
      if (batch.length === 0) return;

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
      const immutableSizes = immutableBatch.map(sizeOperation);
      const requestLimit = immutableBatch.length === 1 && immutableSizes[0]!.requestBytes > MAX_PUSH_BYTES
        ? MAX_LARGE_PUSH_BYTES
        : MAX_PUSH_BYTES;
      if (immutableSizes.some(isOversized)) {
        report.blockedReason = PUSH_BLOCKED_REASON;
        return;
      }
      const push = await this.pushBatch(endpoint, token, immutableBatch, requestLimit);
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
        // A rejected payload must not breed another identical upload forever.
        // Keep a durable, visible local recovery copy before retiring the receipt.
        await store.createConflictCopyFromOperation(operation, operation.entityId, false);
        await store.markOperationAcked(result.opId, undefined, false);
        report.conflicts += 1;
        report.blockedReason = `A change needs review (${result.code ?? "rejected"}). The local version was kept in Settings → Saved versions; other notes can still sync.`;
      }
      // PushResponse.cursor is only an informational high-water mark. Pull is
      // the sole owner of the local cursor because it returns every change.
    }
  }

  private async pushBatch(endpoint: string, token: string, batch: SyncOperation[], maxBytes: number): Promise<PushResponse> {
    if (batch.length > 1 && encodedPushSize(batch) > maxBytes) return this.splitPushBatch(endpoint, token, batch, maxBytes);
    try {
      return await this.request<PushResponse>(`${endpoint}/v1/sync/push`, token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operations: batch.map(toWireOperation) }),
      });
    } catch (error) {
      // A proxy or D1 query budget may be smaller than the client estimate.
      // Retrying immutable operation IDs is safe even after a lost response.
      if (error instanceof SyncHttpError && error.status === 413 && batch.length > 1) return this.splitPushBatch(endpoint, token, batch, maxBytes);
      throw error;
    }
  }

  private async splitPushBatch(endpoint: string, token: string, batch: SyncOperation[], maxBytes: number): Promise<PushResponse> {
    const middle = Math.ceil(batch.length / 2);
    const left = batch.slice(0, middle);
    const right = batch.slice(middle);
    const first = await this.pushBatch(endpoint, token, left, maxBytes);
    validatePushResponse(first, left);
    const second = await this.pushBatch(endpoint, token, right, maxBytes);
    validatePushResponse(second, right);
    return { results: [...first.results, ...second.results], cursor: Math.max(first.cursor, second.cursor) };
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

  private rememberPartialPull(store: NoteStore, accountKey: string, report: SyncReport): void {
    if (report.pulled === 0 && report.conflicts === 0) return;
    const previous = this.partialPulls.get(store);
    const previousCount = previous?.accountKey === accountKey ? previous.count : 0;
    this.partialPulls.set(store, {
      accountKey, count: previousCount + report.pulled,
      conflicts: (previous?.accountKey === accountKey ? previous.conflicts : 0) + report.conflicts,
      blockedReason: report.blockedReason ?? (previous?.accountKey === accountKey ? previous.blockedReason : undefined),
    });
  }

  private async request<T>(input: RequestInfo | URL, token: string, init: RequestInit): Promise<T> {
    // Large ink pages may take minutes over mobile data. Bound downloads too,
    // so a stalled response body cannot keep the coordinator active forever.
    const bytes = typeof init.body === "string" ? textEncoder.encode(init.body).byteLength : 0;
    const timeoutMs = init.method === "GET" ? 5 * 60_000 : Math.min(5 * 60_000, Math.max(60_000, 30_000 + bytes / (32 * 1024) * 1000));
    return requestWithTimeout(input, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    }, async response => {
      const body = await response.text();
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(body); } catch { /* Preserve HTTP status for non-JSON proxy errors. */ }
      if (!payload || typeof payload !== "object") payload = {};
      if (!response.ok) throw new SyncHttpError(response.status, readError(payload, `Sync failed (${response.status}).`), readCode(payload));
      return payload as unknown as T;
    }, timeoutMs);
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
  if (payload.hasMore && payload.nextCursor <= cursor) throw new Error("The server returned a pull page without progress.");
  return payload;
}

function isEntityType(value: unknown): value is SyncEntityType { return value === "page" || value === "notebook"; }
function isAction(value: unknown): value is SyncAction { return value === "upsert" || value === "delete"; }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUUID(value: unknown): value is string { return typeof value === "string" && UUID_RE.test(value); }
