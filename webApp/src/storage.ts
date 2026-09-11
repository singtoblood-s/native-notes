import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import sqliteWasmUrl from "@sqlite.org/sqlite-wasm/sqlite3.wasm?url";
import { resolveStorageAccountKey } from "./auth";
import {
  ConflictCopy,
  INK_FORMAT_VERSION,
  PAGE_METADATA_FORMAT_VERSION,
  MAX_PAGE_IMAGES,
  MAX_PAGE_IMAGE_BYTES,
  MAX_PAGE_IMAGE_BYTES_TOTAL,
  NotePage,
  Notebook,
  PageImage,
  PullChange,
  SaveResult,
  SyncAction,
  SyncEntityType,
  SyncOperation,
  createPage,
  createNotebook,
  id,
  isUUID,
  now,
  pageImageDataBytes,
  requireUUID,
  sanitizePageImage,
  sanitizeNotebook,
  sanitizePage,
  toWirePage,
} from "./models";

type SQLiteRuntime = any;
type SQLiteDatabase = any;

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_NOTEBOOKS = 1_000;
const MAX_ARCHIVE_PAGES = 10_000;
const MAX_NOTEBOOK_TITLE = 500;
const MAX_PAGE_TEXT = 1_000_000;
const MAX_PAGE_TITLE = 500;
const MAX_STROKES = 10_000;
const MAX_POINTS = 200_000;
const CONFLICT_SUFFIX = " · conflict";

function conflictTitle(title: string, maxLength: number): string {
  return `${title.slice(0, Math.max(0, maxLength - CONFLICT_SUFFIX.length))}${CONFLICT_SUFFIX}`;
}

function compareNotebookOrder(left: Notebook, right: Notebook): number {
  return compareStrings(left.createdAt, right.createdAt) || compareStrings(left.id, right.id);
}

function comparePageOrder(left: NotePage, right: NotePage): number {
  if (left.order !== undefined && right.order !== undefined) return left.order - right.order || compareStrings(left.id, right.id);
  // Legacy pages have no order. Keep them before newly-created ordered pages
  // and use a stable natural title fallback.
  if (left.order === undefined && right.order !== undefined) return -1;
  if (left.order !== undefined && right.order === undefined) return 1;
  const leftNumber = /^page\s+(\d+)$/i.exec(left.title)?.[1];
  const rightNumber = /^page\s+(\d+)$/i.exec(right.title)?.[1];
  if (leftNumber && rightNumber) {
    const difference = Number(leftNumber) - Number(rightNumber);
    if (difference) return difference;
  }
  return compareStrings(left.title, right.title) || compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface Archive {
  version: 1;
  exportedAt: string;
  account: string;
  notebooks: Notebook[];
  pages: NotePage[];
}

export type OperationState = "pending" | "sending";

export interface NoteStore {
  readonly accountKey: string;
  readonly persistence: "opfs" | "indexeddb";
  listNotebooks(includeDeleted?: boolean): Promise<Notebook[]>;
  getNotebook(id: string): Promise<Notebook | null>;
  saveNotebook(notebook: Notebook, queue?: boolean): Promise<SaveResult>;
  listPages(notebookId: string, includeDeleted?: boolean): Promise<NotePage[]>;
  getPage(id: string): Promise<NotePage | null>;
  savePage(page: NotePage, queue?: boolean): Promise<SaveResult>;
  deletePage(id: string): Promise<SaveResult>;
  restorePage(id: string): Promise<SaveResult>;
  archiveNotebook(id: string): Promise<SaveResult>;
  restoreNotebook(id: string): Promise<SaveResult>;
  createConflictCopy(page: NotePage, originalPageID: string): Promise<NotePage>;
  createConflictCopyFromOperation(operation: SyncOperation, originalPageID?: string): Promise<void>;
  pendingOperations(limit?: number): Promise<SyncOperation[]>;
  getOperation(opID: string): Promise<SyncOperation | null>;
  markOperationSending(opID: string): Promise<void>;
  markOperationPending(opID: string): Promise<void>;
  markOperationAcked(opID: string, revision?: number, updateEntityRevision?: boolean): Promise<void>;
  applyRemote(change: PullChange): Promise<void>;
  applyRemoteBatch(changes: PullChange[], nextCursor: number): Promise<void>;
  applyServerSnapshot(change: PullChange, operationID?: string): Promise<void>;
  getCursor(): Promise<number>;
  setCursor(cursor: number): Promise<void>;
  resetCursor?(): Promise<void>;
  listConflicts(): Promise<ConflictCopy[]>;
  deleteConflict(conflictID: string): Promise<void>;
  exportArchive(): Promise<Archive>;
  importArchive(archive: Archive): Promise<{ notebooks: number; pages: number }>;
  ensureStarterData(): Promise<{ notebook: Notebook; page: NotePage }>;
  /** Keep the database open while a network sync is applying its ACKs. */
  acquireSyncLease?(): () => void;
  close(): Promise<void>;
}

export class PersistenceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceUnavailableError";
  }
}

export class CorruptSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptSnapshotError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, maxLength = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== "string" || value.length > maxLength) throw new Error(`${label} is invalid`);
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  if (value !== null && typeof value !== "string") throw new Error(`${label} is invalid`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`);
  return value as number;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} is invalid`);
  return value;
}

function validateNotebookSnapshot(value: unknown, expectedID?: string): Notebook {
  const raw = record(value, "Notebook snapshot");
  const notebookID = requireUUID(raw.id, "Notebook ID");
  if (expectedID && notebookID !== requireUUID(expectedID, "Entity ID")) throw new Error("Notebook payload ID does not match entity ID");
  const title = requiredString(raw.title, "Notebook title", MAX_NOTEBOOK_TITLE);
  if (!title.trim()) throw new Error("Notebook title is empty");
  requiredString(raw.createdAt, "Notebook createdAt");
  requiredString(raw.updatedAt, "Notebook updatedAt");
  optionalString(raw.deletedAt, "Notebook deletedAt");
  const revision = nonNegativeInteger(raw.revision, "Notebook revision");
  return sanitizeNotebook({
    id: notebookID,
    title,
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
    deletedAt: raw.deletedAt as string | null,
    revision,
  });
}

function validatePageSnapshot(value: unknown, expectedID?: string, expectedRevision?: number, allowConflictOf = true, timing: "strict" | "local" = "strict"): NotePage {
  const raw = record(value, "Page snapshot");
  const pageID = requireUUID(raw.id, "Page ID");
  if (expectedID && pageID !== requireUUID(expectedID, "Entity ID")) throw new Error("Page payload ID does not match entity ID");
  const notebookID = requireUUID(raw.notebookId, "Page notebook ID");
  const title = requiredString(raw.title, "Page title", MAX_PAGE_TITLE);
  const text = requiredString(raw.text, "Page text", MAX_PAGE_TEXT);
  const background = raw.background;
  if (background !== "blank" && background !== "ruled" && background !== "grid") throw new Error("Page background is invalid");
  const width = finiteNumber(raw.width, "Page width");
  const height = finiteNumber(raw.height, "Page height");
  if (width < 1 || width > 10_000 || height < 1 || height > 10_000) throw new Error("Page dimensions are invalid");
  if (raw.formatVersion !== INK_FORMAT_VERSION && raw.formatVersion !== PAGE_METADATA_FORMAT_VERSION) throw new Error("Unsupported ink format");
  const revision = nonNegativeInteger(raw.revision, "Page revision");
  if (expectedRevision !== undefined && revision !== expectedRevision) throw new Error("Page payload revision does not match change revision");
  if (raw.order !== undefined && raw.order !== null && (!Number.isSafeInteger(raw.order) || (raw.order as number) < 0)) throw new Error("Page order is invalid");
  requiredString(raw.updatedAt, "Page updatedAt");
  optionalString(raw.deletedAt, "Page deletedAt");
  if (raw.conflictOf !== undefined && raw.conflictOf !== null && (!allowConflictOf || !isUUID(raw.conflictOf))) throw new Error("Page conflict ID is invalid");
  if (!Array.isArray(raw.strokes) || raw.strokes.length > MAX_STROKES) throw new Error("Page strokes are invalid");
  const strokeIDs = new Set<string>();
  let pointCount = 0;
  const strokes = raw.strokes.map((value, strokeIndex) => {
    const stroke = record(value, `Stroke ${strokeIndex + 1}`);
    const strokeID = requireUUID(stroke.id, "Stroke ID");
    if (strokeIDs.has(strokeID)) throw new Error("Page contains duplicate stroke IDs");
    strokeIDs.add(strokeID);
    const color = finiteNumber(stroke.color, "Stroke color");
    if (!Number.isInteger(color) || color < 0 || color > 0xFFFF_FFFF) throw new Error("Stroke color is invalid");
    const strokeWidth = finiteNumber(stroke.width, "Stroke width");
    if (strokeWidth < 0.1 || strokeWidth > 100) throw new Error("Stroke width is invalid");
    if (!Array.isArray(stroke.points) || stroke.points.length === 0) throw new Error("Stroke points are invalid");
    pointCount += stroke.points.length;
    if (pointCount > MAX_POINTS) throw new Error("Page contains too many points");
    let previousTime = -1;
    const points = stroke.points.map((value, pointIndex) => {
      const point = record(value, `Stroke point ${pointIndex + 1}`);
      const x = finiteNumber(point.x, "Point x");
      const y = finiteNumber(point.y, "Point y");
      const pressure = finiteNumber(point.pressure, "Point pressure");
      let time = nonNegativeInteger(point.time, "Point time");
      // Repair browser event ordering on local saves without changing ink geometry.
      // Remote snapshots and immutable outbox operations remain strictly validated.
      if (timing === "local") time = Math.max(previousTime, time);
      if (pressure < 0 || pressure > 1 || time < previousTime) throw new Error("Stroke point values are invalid");
      previousTime = time;
      for (const tiltName of ["tiltX", "tiltY"] as const) {
        const tilt = point[tiltName];
        if (tilt !== null && tilt !== undefined && (typeof tilt !== "number" || !Number.isFinite(tilt) || tilt < -90 || tilt > 90)) throw new Error("Stroke tilt is invalid");
      }
      return { x, y, pressure, time, tiltX: point.tiltX === null || point.tiltX === undefined ? null : point.tiltX as number, tiltY: point.tiltY === null || point.tiltY === undefined ? null : point.tiltY as number };
    });
    return { id: strokeID, color: color >>> 0, width: strokeWidth, points };
  });
  const imageIDs = new Set<string>();
  let imageBytes = 0;
  const hasImages = raw.images !== undefined;
  const rawImages = hasImages ? raw.images : [];
  if (!Array.isArray(rawImages) || rawImages.length > MAX_PAGE_IMAGES) throw new Error("Page images are invalid");
  const images: PageImage[] = rawImages.map((value, imageIndex) => {
    const image = record(value, `Page image ${imageIndex + 1}`);
    const imageID = requireUUID(image.id, "Image ID");
    if (imageIDs.has(imageID)) throw new Error("Page contains duplicate image IDs");
    imageIDs.add(imageID);
    const src = requiredString(image.src, "Image source");
    const bytes = pageImageDataBytes(src);
    if (bytes === null || bytes > MAX_PAGE_IMAGE_BYTES) throw new Error("Page image data is invalid");
    imageBytes += bytes;
    if (imageBytes > MAX_PAGE_IMAGE_BYTES_TOTAL) throw new Error("Page images are too large");
    const x = finiteNumber(image.x, "Image x");
    const y = finiteNumber(image.y, "Image y");
    const width = finiteNumber(image.width, "Image width");
    const height = finiteNumber(image.height, "Image height");
    if (width <= 0 || width > 10_000 || height <= 0 || height > 10_000 || x < -100_000 || x > 100_000 || y < -100_000 || y > 100_000) {
      throw new Error("Page image bounds are invalid");
    }
    return sanitizePageImage({ id: imageID, src, x, y, width, height });
  });
  const hasPageMetadata = images.length > 0 || raw.order !== undefined && raw.order !== null || typeof raw.conflictOf === "string";
  if (hasPageMetadata && raw.formatVersion !== PAGE_METADATA_FORMAT_VERSION && timing !== "local") throw new Error("Page images and order require the newer page format");
  const formatVersion = hasPageMetadata ? PAGE_METADATA_FORMAT_VERSION : raw.formatVersion as number;
  return sanitizePage({
    id: pageID,
    notebookId: notebookID,
    title,
    text,
    background,
    width,
    height,
    strokes,
    images: hasImages ? images : undefined,
    order: raw.order === null ? undefined : raw.order as number | undefined,
    formatVersion,
    revision,
    updatedAt: raw.updatedAt as string,
    deletedAt: raw.deletedAt as string | null,
    conflictOf: typeof raw.conflictOf === "string" ? raw.conflictOf : undefined,
  });
}

function validateSnapshotPayload(entityType: SyncEntityType, action: SyncAction, payload: unknown, entityID: string, revision?: number): Record<string, unknown> {
  void action;
  if (entityType === "notebook") return validateNotebookSnapshot(payload, entityID) as unknown as Record<string, unknown>;
  return validatePageSnapshot(payload, entityID, revision, true) as unknown as Record<string, unknown>;
}

function validatePullChange(change: PullChange): PullChange {
  if (!Number.isInteger(change.sequence) || change.sequence < 1 || !isUUID(change.entityId) || !Number.isInteger(change.revision) || change.revision < 0 || (change.entityType !== "page" && change.entityType !== "notebook") || (change.action !== "upsert" && change.action !== "delete")) throw new Error("Server returned an invalid change");
  const entityID = requireUUID(change.entityId, "Entity ID");
  const payload = validateSnapshotPayload(change.entityType, change.action, change.payload, entityID, change.revision);
  return { ...change, entityId: entityID, payload };
}

function validateServerSnapshot(change: PullChange): PullChange {
  if (!Number.isInteger(change.sequence) || change.sequence < 0 || !isUUID(change.entityId) || !Number.isInteger(change.revision) || change.revision < 0 || (change.entityType !== "page" && change.entityType !== "notebook") || (change.action !== "upsert" && change.action !== "delete")) throw new Error("Server returned an invalid snapshot");
  const entityID = requireUUID(change.entityId, "Entity ID");
  const payload = validateSnapshotPayload(change.entityType, change.action, change.payload, entityID, change.revision);
  return { ...change, entityId: entityID, payload };
}

/** IndexedDB is only the durable container for the SQLite image in GitHub Pages mode. */
export class SnapshotStore {
  private static readonly databaseName = "notepad-sqlite-snapshots";
  private static readonly databaseVersion = 1;

  static async read(key: string): Promise<Uint8Array | null> {
    this.requireIndexedDb();
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, this.databaseVersion);
      let database: IDBDatabase | undefined;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("databases")) request.result.createObjectStore("databases");
      };
      request.onerror = () => reject(request.error ?? new PersistenceUnavailableError("IndexedDB could not open"));
      request.onblocked = () => reject(new PersistenceUnavailableError("IndexedDB is blocked by another tab"));
      request.onsuccess = () => {
        database = request.result;
        let transaction: IDBTransaction;
        try {
          transaction = database.transaction("databases", "readonly");
        } catch (error) {
          database.close();
          reject(error);
          return;
        }
        const get = transaction.objectStore("databases").get(key);
        let settled = false;
        const finish = (action: () => void) => {
          if (settled) return;
          settled = true;
          database?.close();
          action();
        };
        get.onerror = () => finish(() => reject(get.error ?? new Error("Snapshot read failed")));
        get.onsuccess = () => {
          const value = get.result;
          if (value === undefined) {
            finish(() => resolve(null));
            return;
          }
          if (value instanceof ArrayBuffer) {
            finish(() => resolve(new Uint8Array(value.slice(0))));
            return;
          }
          if (value instanceof Uint8Array) {
            finish(() => resolve(new Uint8Array(value)));
            return;
          }
          finish(() => reject(new CorruptSnapshotError("Stored SQLite snapshot has an invalid type")));
        };
        transaction.onerror = () => finish(() => reject(transaction.error ?? new Error("Snapshot read transaction failed")));
        transaction.onabort = () => finish(() => reject(transaction.error ?? new Error("Snapshot read transaction aborted")));
      };
    });
  }

  static async write(key: string, bytes: Uint8Array): Promise<void> {
    this.requireIndexedDb();
    if (bytes.byteLength === 0) throw new Error("SQLite snapshot is empty");
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, this.databaseVersion);
      let database: IDBDatabase | undefined;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("databases")) request.result.createObjectStore("databases");
      };
      request.onerror = () => reject(request.error ?? new PersistenceUnavailableError("IndexedDB could not open"));
      request.onblocked = () => reject(new PersistenceUnavailableError("IndexedDB is blocked by another tab"));
      request.onsuccess = () => {
        database = request.result;
        let transaction: IDBTransaction;
        try {
          transaction = database.transaction("databases", "readwrite");
          transaction.objectStore("databases").put(bytes.slice(), key);
        } catch (error) {
          database.close();
          reject(error);
          return;
        }
        let settled = false;
        const finish = (action: () => void) => {
          if (settled) return;
          settled = true;
          database?.close();
          action();
        };
        transaction.oncomplete = () => finish(resolve);
        transaction.onerror = () => finish(() => reject(transaction.error ?? new Error("Snapshot write failed")));
        transaction.onabort = () => finish(() => reject(transaction.error ?? new Error("Snapshot write aborted")));
      };
    });
  }

  private static requireIndexedDb(): void {
    if (typeof indexedDB === "undefined") throw new PersistenceUnavailableError("This browser has no durable IndexedDB storage");
  }
}

interface ExclusiveLock {
  release: () => void;
}

async function acquireExclusiveLock(name: string): Promise<ExclusiveLock> {
  if (typeof navigator === "undefined") throw new PersistenceUnavailableError("Browser storage is unavailable");
  const lockManager = (navigator as Navigator & { locks?: { request: Function } }).locks;
  if (!lockManager) throw new PersistenceUnavailableError("Open this notebook in one tab; this browser has no Web Locks support");
  let releaseHold: (() => void) | undefined;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: unknown) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
  const request = lockManager.request(name, { mode: "exclusive", ifAvailable: true }, (lock: unknown) => {
    if (!lock) {
      rejectReady?.(new PersistenceUnavailableError("This notebook is already open in another tab"));
      return undefined;
    }
    resolveReady?.();
    return hold;
  });
  Promise.resolve(request).catch((error) => rejectReady?.(error));
  await ready;
  return { release: () => releaseHold?.() };
}

/** SHA-256 account namespace. The digest keeps IDs with different punctuation from colliding. */
export async function accountNamespace(accountKey: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new PersistenceUnavailableError("Web Crypto is required for account-isolated storage");
  const encoded = new TextEncoder().encode(`inknote:v1:${resolveStorageAccountKey(accountKey)}`);
  const digest = await subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

/** SQLite WASM store with a durable snapshot fallback for ordinary GitHub Pages hosting. */
/** SQLite engine. It is instantiated by storage.worker.ts in production. */
export class SQLiteNoteStoreEngine implements NoteStore {
  readonly accountKey: string;
  readonly persistence: "opfs" | "indexeddb";
  private readonly sqlite: SQLiteRuntime;
  private readonly db: SQLiteDatabase;
  private readonly snapshotKey: string;
  private readonly lock: ExclusiveLock;
  private closed = false;
  private writeBlocked = false;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private syncLeases = 0;
  private closeWaiters: Array<() => void> = [];

  private constructor(
    sqlite: SQLiteRuntime,
    db: SQLiteDatabase,
    accountKey: string,
    persistence: "opfs" | "indexeddb",
    snapshotKey: string,
    lock: ExclusiveLock,
  ) {
    this.sqlite = sqlite;
    this.db = db;
    this.accountKey = accountKey;
    this.persistence = persistence;
    this.snapshotKey = snapshotKey;
    this.lock = lock;
  }

  static async open(accountKey: string): Promise<SQLiteNoteStoreEngine> {
    const namespace = await accountNamespace(accountKey);
    const lock = await acquireExclusiveLock(`inknote:${namespace}`);
    try {
    const sqlite = await sqlite3InitModule({ locateFile: (path: string) => path.endsWith('.wasm') ? sqliteWasmUrl : path });
      let db: SQLiteDatabase | undefined;
      let persistence: "opfs" | "indexeddb" = "indexeddb";
      let image: Uint8Array | null = null;

      if (globalThis.crossOriginIsolated && typeof sqlite.oo1?.OpfsDb === "function") {
        try {
          db = new sqlite.oo1.OpfsDb(`notepad/${namespace}.sqlite3`);
          persistence = "opfs";
        } catch {
          db = undefined;
        }
      }
      if (!db) {
        image = await SnapshotStore.read(namespace);
        db = new sqlite.oo1.DB(":memory:");
        if (image) deserializeSnapshot(sqlite, db, image);
      }

      const store = new SQLiteNoteStoreEngine(sqlite, db, accountKey, persistence, namespace, lock);
      store.initializeSchema();
      if (store.migrateUnqueuedConflictCopies() && persistence === "indexeddb") await store.persistSnapshot();
      return store;
    } catch (error) {
      lock.release();
      throw error;
    }
  }

  private initializeSchema(): void {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS notebooks (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        deleted_at TEXT,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        notebook_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        deleted_at TEXT,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pages_notebook_idx ON pages(notebook_id, deleted_at);
      CREATE TABLE IF NOT EXISTS outbox (
        op_id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        base_revision INTEGER NOT NULL,
        action TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS conflicts (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        sequence INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO metadata(key, value) VALUES('cursor', '0') ON CONFLICT(key) DO NOTHING;
    `);
    const outboxColumns = this.query<{ name: unknown }>("PRAGMA table_info(outbox)");
    if (!outboxColumns.some((column) => column.name === "state")) this.db.exec("ALTER TABLE outbox ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'");
    this.db.exec("CREATE INDEX IF NOT EXISTS outbox_entity_state_idx ON outbox(entity_type, entity_id, state, created_at)");
  }

  /** Queue pre-upgrade recovered pages once so they converge across devices. */
  private migrateUnqueuedConflictCopies(): boolean {
    let changed = false;
    const rows = this.query<{ id: unknown; json: unknown }>("SELECT id, json FROM pages WHERE revision = 0 AND deleted_at IS NULL");
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.json !== "string") continue;
      let page: NotePage;
      try {
        const decoded = JSON.parse(row.json) as Partial<NotePage>;
        if (!isUUID(decoded.conflictOf)) continue;
        page = validatePageSnapshot(decoded, row.id, undefined, true, "local");
      } catch {
        continue;
      }
      const notebook = this.notebookFromRow(this.row(page.notebookId, "notebooks"));
      if (!notebook) continue;
      if (notebook.revision === 0) {
        const parentQueued = this.query("SELECT 1 FROM outbox WHERE entity_type = 'notebook' AND entity_id = ? LIMIT 1", [notebook.id]).length === 0;
        if (parentQueued) {
          this.queueOperation({ entityType: "notebook", entityId: notebook.id, baseRevision: 0, action: "upsert", payload: notebook as unknown as Record<string, unknown> });
          changed = true;
        }
      }
      const queued = this.query("SELECT 1 FROM outbox WHERE entity_type = 'page' AND entity_id = ? LIMIT 1", [page.id]).length > 0;
      if (queued) continue;
      this.queueOperation({ entityType: "page", entityId: page.id, baseRevision: 0, action: "upsert", payload: toWirePage(page) as unknown as Record<string, unknown> });
      changed = true;
    }
    return changed;
  }

  private query<T extends Record<string, unknown>>(sql: string, bind: unknown[] = []): T[] {
    if (this.closed) throw new Error("Notebook database is closed");
    const rows = this.db.exec({ sql, bind, rowMode: "object", returnValue: "resultRows" });
    return Array.isArray(rows) ? rows as T[] : [];
  }

  private transaction<T>(body: () => T): Promise<T> {
    const run = this.writeQueue.then(() => this.runTransaction(body));
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async runTransaction<T>(body: () => T): Promise<T> {
    this.assertWritable();
    this.db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const result = body();
      this.db.exec("COMMIT");
      committed = true;
      await this.persistSnapshot();
      return result;
    } catch (error) {
      if (!committed) {
        try { this.db.exec("ROLLBACK"); } catch { /* keep original SQLite error */ }
      } else {
        // SQLite committed but the durable image did not. Keep the previous
        // image and block later writes until the user reloads the store.
        this.writeBlocked = true;
      }
      throw error;
    }
  }

  private assertWritable(): void {
    if (this.closed) throw new Error("Notebook database is closed");
    if (this.writeBlocked) throw new PersistenceUnavailableError("Notebook storage is blocked after a failed durable write; reload to recover");
  }

  private async persistSnapshot(): Promise<void> {
    if (this.persistence === "opfs") return;
    const exported = this.sqlite.capi.sqlite3_js_db_export?.(this.db) ?? this.db.export?.();
    if (!exported) throw new Error("SQLite could not export its local image");
    const bytes = exported instanceof Uint8Array ? new Uint8Array(exported) : new Uint8Array(exported);
    await SnapshotStore.write(this.snapshotKey, bytes);
  }

  private row(entityID: string, table: "pages" | "notebooks"): Record<string, unknown> | null {
    return this.query(`SELECT json, revision FROM ${table} WHERE id = ?`, [entityID])[0] ?? null;
  }

  private pageFromRow(row: Record<string, unknown> | null | undefined): NotePage | null {
    if (!row) return null;
    if (typeof row.json !== "string") throw new CorruptSnapshotError("Page row has no JSON payload");
    try { return sanitizePage(JSON.parse(row.json) as Partial<NotePage>); }
    catch (error) { throw new CorruptSnapshotError(`Page snapshot could not be decoded: ${error instanceof Error ? error.message : "invalid JSON"}`); }
  }

  private nextPageOrderDirect(notebookID: string): number {
    const rows = this.query<{ json: unknown }>("SELECT json FROM pages WHERE notebook_id = ?", [notebookID]);
    let count = 0;
    let maximum = -1;
    for (const row of rows) {
      count += 1;
      if (typeof row.json !== "string") continue;
      try {
        const value = JSON.parse(row.json) as { order?: unknown };
        if (Number.isSafeInteger(value.order) && (value.order as number) >= 0) maximum = Math.max(maximum, value.order as number);
      } catch {
        // The normal row decoder reports corrupt snapshots when the row is read.
      }
    }
    return Math.max(count, maximum + 1);
  }

  private notebookFromRow(row: Record<string, unknown> | null | undefined): Notebook | null {
    if (!row) return null;
    if (typeof row.json !== "string") throw new CorruptSnapshotError("Notebook row has no JSON payload");
    try { return sanitizeNotebook(JSON.parse(row.json) as Partial<Notebook>); }
    catch (error) { throw new CorruptSnapshotError(`Notebook snapshot could not be decoded: ${error instanceof Error ? error.message : "invalid JSON"}`); }
  }

  private operationFromRow(row: Record<string, unknown> | null | undefined): SyncOperation | null {
    if (!row) return null;
    if (typeof row.payload !== "string") throw new CorruptSnapshotError("Outbox row has no JSON payload");
    try {
      const payload = record(JSON.parse(row.payload), "Outbox payload");
      if (typeof row.op_id !== "string" || typeof row.entity_type !== "string" || typeof row.entity_id !== "string" || typeof row.action !== "string" || typeof row.created_at !== "string") throw new Error("missing operation fields");
      const opId = requireUUID(row.op_id, "Operation ID");
      const entityId = requireUUID(row.entity_id, "Entity ID");
      if ((row.entity_type !== "page" && row.entity_type !== "notebook") || (row.action !== "upsert" && row.action !== "delete")) throw new Error("invalid operation type");
      const baseRevision = nonNegativeInteger(Number(row.base_revision ?? 0), "Operation base revision");
      if (row.state !== "pending" && row.state !== "sending") throw new Error("invalid operation state");
      const entityType = row.entity_type as SyncEntityType;
      const action = row.action as SyncAction;
      const checkedPayload = validateSnapshotPayload(entityType, action, payload, entityId);
      return { opId, entityType, entityId, baseRevision, action, payload: checkedPayload, createdAt: row.created_at, state: row.state };
    } catch (error) {
      throw new CorruptSnapshotError(`Outbox operation could not be decoded: ${error instanceof Error ? error.message : "invalid JSON"}`);
    }
  }

  /** Coalesce unchanged pending state; preserve ordered state transitions. */
  private queueOperation(operation: Omit<SyncOperation, "opId" | "createdAt" | "state">): string {
    // Use the newest row. Coalescing the oldest create row after a pending
    // delete would erase the parent-before-children ordering needed by the
    // server. Sending rows are immutable and therefore always force a new
    // operation. Local edits keep their captured server revision; ACK handling
    // rebases later pending operations before they are sent.
    const latest = this.query<Record<string, unknown>>(
      `SELECT op_id, action, state FROM outbox
       WHERE entity_type = ? AND entity_id = ? AND state IN ('pending', 'sending')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [operation.entityType, operation.entityId],
    )[0];
    if (latest && latest.state === "pending" && latest.action === operation.action && typeof latest.op_id === "string") {
      this.db.exec({ sql: "UPDATE outbox SET payload = ? WHERE op_id = ? AND state = 'pending'", bind: [JSON.stringify(operation.payload), latest.op_id] });
      return latest.op_id;
    }
    const opId = id();
    this.db.exec({
      sql: `INSERT INTO outbox(op_id, entity_type, entity_id, base_revision, action, payload, created_at, state)
        VALUES(?, ?, ?, ?, ?, ?, ?, 'pending')`,
      bind: [opId, operation.entityType, operation.entityId, operation.baseRevision, operation.action, JSON.stringify(operation.payload), now()],
    });
    return opId;
  }

  private savePageRow(page: NotePage, queue: boolean): SaveResult {
    const normalized = validatePageSnapshot(page, page.id, undefined, true, "local");
    const existing = this.pageFromRow(this.row(normalized.id, "pages"));
    // Local edits do not mint server revisions. Keep the last acknowledged one.
    const baseRevision = existing?.revision ?? normalized.revision;
    // New local pages append after existing pages. Existing/remote order is
    // preserved, including legacy rows that have no order field yet.
    const pageOrder = existing ? existing.order : normalized.order ?? this.nextPageOrderDirect(normalized.notebookId);
    const saved: NotePage = {
      ...normalized,
      order: pageOrder,
      formatVersion: pageOrder !== undefined || (normalized.images?.length ?? 0) > 0 || normalized.conflictOf !== undefined ? PAGE_METADATA_FORMAT_VERSION : normalized.formatVersion,
      revision: baseRevision,
      updatedAt: now(),
    };
    this.db.exec({
      sql: `INSERT INTO pages(id, notebook_id, revision, deleted_at, json) VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET notebook_id=excluded.notebook_id, revision=excluded.revision,
          deleted_at=excluded.deleted_at, json=excluded.json`,
      bind: [saved.id, saved.notebookId, saved.revision, saved.deletedAt, JSON.stringify(saved)],
    });
    if (!queue) return { status: "saved", revision: saved.revision };
    const operationID = this.queueOperation({
      entityType: "page",
      entityId: saved.id,
      baseRevision,
      action: saved.deletedAt === null ? "upsert" : "delete",
      payload: saved.deletedAt === null ? toWirePage(saved) as unknown as Record<string, unknown> : { ...toWirePage(saved), deletedAt: saved.deletedAt },
    });
    return { status: "saved", operationId: operationID, revision: saved.revision };
  }

  private saveNotebookRow(notebook: Notebook, queue: boolean): SaveResult {
    const normalized = validateNotebookSnapshot(notebook, notebook.id);
    const existing = this.notebookFromRow(this.row(normalized.id, "notebooks"));
    const baseRevision = existing?.revision ?? normalized.revision;
    const saved: Notebook = { ...normalized, revision: baseRevision, updatedAt: now() };
    this.db.exec({
      sql: `INSERT INTO notebooks(id, revision, deleted_at, json) VALUES(?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, deleted_at=excluded.deleted_at, json=excluded.json`,
      bind: [saved.id, saved.revision, saved.deletedAt, JSON.stringify(saved)],
    });
    if (!queue) return { status: "saved", revision: saved.revision };
    const operationID = this.queueOperation({
      entityType: "notebook",
      entityId: saved.id,
      baseRevision,
      action: saved.deletedAt === null ? "upsert" : "delete",
      payload: saved.deletedAt === null ? saved as unknown as Record<string, unknown> : { ...saved, deletedAt: saved.deletedAt },
    });
    return { status: "saved", operationId: operationID, revision: saved.revision };
  }

  async listNotebooks(includeDeleted = false): Promise<Notebook[]> {
    const clause = includeDeleted ? "" : " WHERE deleted_at IS NULL";
    return this.query(`SELECT json FROM notebooks${clause} ORDER BY id`).map((row) => this.notebookFromRow(row)).filter((value): value is Notebook => value !== null).sort(compareNotebookOrder);
  }

  async getNotebook(entityID: string): Promise<Notebook | null> { return this.notebookFromRow(this.row(entityID, "notebooks")); }

  async saveNotebook(notebook: Notebook, queue = true): Promise<SaveResult> { return this.transaction(() => this.saveNotebookRow(notebook, queue)); }

  async listPages(notebookID: string, includeDeleted = false): Promise<NotePage[]> {
    const clause = includeDeleted ? "" : " AND deleted_at IS NULL";
    return this.query(`SELECT json FROM pages WHERE notebook_id = ?${clause} ORDER BY id`, [notebookID]).map((row) => this.pageFromRow(row)).filter((value): value is NotePage => value !== null).sort(comparePageOrder);
  }

  async getPage(entityID: string): Promise<NotePage | null> { return this.pageFromRow(this.row(entityID, "pages")); }

  async savePage(page: NotePage, queue = true): Promise<SaveResult> { return this.transaction(() => this.savePageRow(page, queue)); }

  async deletePage(entityID: string): Promise<SaveResult> {
    return this.transaction(() => {
      const current = this.pageFromRow(this.row(entityID, "pages"));
      if (!current) return { status: "failed", message: "Page not found" };
      const deleted: NotePage = { ...current, deletedAt: now(), updatedAt: now() };
      const result = this.savePageRow(deleted, false);
      const operationID = this.queueOperation({
        entityType: "page",
        entityId: entityID,
        baseRevision: current.revision,
        action: "delete",
        // The server receives a complete tombstone snapshot, so it can restore
        // notebook ownership and recover an offline edit safely.
        payload: toWirePage(deleted) as unknown as Record<string, unknown>,
      });
      return { ...result, operationId: operationID };
    });
  }

  async restorePage(entityID: string): Promise<SaveResult> {
    const page = await this.getPage(entityID);
    if (!page) return { status: "failed", message: "Page not found" };
    return this.savePage({ ...page, deletedAt: null });
  }

  async archiveNotebook(entityID: string): Promise<SaveResult> {
    const notebook = await this.getNotebook(entityID);
    if (!notebook) return { status: "failed", message: "Notebook not found" };
    return this.saveNotebook({ ...notebook, deletedAt: now() });
  }

  async restoreNotebook(entityID: string): Promise<SaveResult> {
    const notebook = await this.getNotebook(entityID);
    if (!notebook) return { status: "failed", message: "Notebook not found" };
    return this.saveNotebook({ ...notebook, deletedAt: null });
  }

  async createConflictCopy(page: NotePage, originalPageID: string): Promise<NotePage> {
    const copy = sanitizePage({ ...page, id: id(), title: conflictTitle(page.title, MAX_PAGE_TITLE), revision: 0, conflictOf: originalPageID, deletedAt: null });
    // Recovery copies are durable notebook pages. Queue them so another device
    // sees the same recoverable note after the next sync.
    await this.savePage(copy, true);
    return copy;
  }

  async createConflictCopyFromOperation(operation: SyncOperation, originalPageID = operation.entityId): Promise<void> {
    const operationID = requireUUID(operation.opId, "Operation ID");
    await this.transaction(() => {
      // Conflict recovery runs before the outbox row is acknowledged. The
      // marker makes that recovery idempotent if the app stops between these
      // two durable operations, while preserving any copy the user edited or
      // deleted before the retry.
      if (this.hasConflictRecoveryMarkerDirect(operationID)) return;
      if (operation.entityType === "page") {
        const page = validatePageSnapshot(operation.payload, operation.entityId);
        const notebook = this.notebookFromRow(this.row(page.notebookId, "notebooks"));
        let notebookID = page.notebookId;
        if (!notebook || notebook.deletedAt) {
          const recoveredNotebook = notebook
            ? { ...notebook, id: id(), title: conflictTitle(notebook.title, MAX_NOTEBOOK_TITLE), revision: 0, deletedAt: null, updatedAt: now() }
            : createNotebook("Recovered page");
          // A recovered page may be edited immediately. Persist the parent
          // upload before exposing the page so its later operation cannot reach
          // the server with a notebook ID the server has never seen.
          this.saveNotebookRow(recoveredNotebook, true);
          notebookID = recoveredNotebook.id;
        }
        const copy = sanitizePage({ ...page, id: id(), notebookId: notebookID, title: conflictTitle(page.title, MAX_PAGE_TITLE), revision: 0, conflictOf: originalPageID, deletedAt: null });
        this.savePageRow(copy, false);
        if (typeof this.queueOperation === "function") this.queueOperation({
          entityType: "page",
          entityId: copy.id,
          baseRevision: 0,
          action: "upsert",
          // savePageRow assigns an append order to a newly recovered page;
          // queue the persisted snapshot so every device gets that same order.
          payload: toWirePage(this.pageFromRow(this.row(copy.id, "pages")) ?? copy) as unknown as Record<string, unknown>,
        });
      } else if (operation.entityType === "notebook") {
        const notebook = validateNotebookSnapshot(operation.payload, operation.entityId);
        // The recovered notebook is a valid place for the user to create a new
        // page immediately, so make its server-side parent durable first.
        this.saveNotebookRow({ ...notebook, id: id(), title: conflictTitle(notebook.title, MAX_NOTEBOOK_TITLE), revision: 0, deletedAt: null, updatedAt: now() }, true);
      } else {
        this.insertConflictDirect(operation.entityType, operation.entityId, operation.payload, "rejected local operation", 0);
      }
      this.markConflictRecoveryDirect(operationID);
    });
  }

  async pendingOperations(limit = 50): Promise<SyncOperation[]> {
    const bounded = Math.min(100, Math.max(1, limit));
    return this.query(`SELECT op_id, entity_type, entity_id, base_revision, action, payload, created_at, state
      FROM outbox WHERE state IN ('pending', 'sending') ORDER BY created_at, rowid LIMIT ?`, [bounded]).map((row) => this.operationFromRow(row)).filter((value): value is SyncOperation => value !== null);
  }

  async getOperation(opID: string): Promise<SyncOperation | null> {
    return this.operationFromRow(this.query(`SELECT op_id, entity_type, entity_id, base_revision, action, payload, created_at, state FROM outbox WHERE op_id = ?`, [opID])[0]);
  }

  async markOperationSending(opID: string): Promise<void> {
    await this.transaction(() => {
      const operation = this.getOperationDirect(opID);
      if (!operation) throw new Error("Operation not found");
      this.db.exec({ sql: "UPDATE outbox SET state = 'sending' WHERE op_id = ?", bind: [opID] });
    });
  }

  async markOperationPending(opID: string): Promise<void> {
    await this.transaction(() => this.db.exec({ sql: "UPDATE outbox SET state = 'pending' WHERE op_id = ?", bind: [opID] }));
  }

  async markOperationAcked(opID: string, revision?: number, updateEntityRevision = true): Promise<void> {
    await this.transaction(() => {
      const operation = this.getOperationDirect(opID);
      if (!operation) return;
      this.db.exec({ sql: "DELETE FROM outbox WHERE op_id = ?", bind: [opID] });
      if (revision === undefined) return;
      if (updateEntityRevision) {
        const table = operation.entityType === "page" ? "pages" : "notebooks";
        const row = this.row(operation.entityId, table);
        if (row?.json && typeof row.json === "string") {
          const item = JSON.parse(row.json) as Record<string, unknown>;
          item.revision = Math.max(Number(item.revision ?? 0), revision);
          this.db.exec({ sql: `UPDATE ${table} SET revision = ?, json = ? WHERE id = ?`, bind: [item.revision, JSON.stringify(item), operation.entityId] });
        }
      }
      // A newer pending edit keeps its payload and now compares with the ack.
      this.db.exec({ sql: "UPDATE outbox SET base_revision = ? WHERE entity_type = ? AND entity_id = ? AND state = 'pending'", bind: [revision, operation.entityType, operation.entityId] });
    });
  }

  async applyRemote(change: PullChange): Promise<void> {
    const cursor = await this.getCursor();
    await this.applyRemoteBatch([change], Math.max(cursor, change.sequence));
  }

  async applyRemoteBatch(changes: PullChange[], nextCursor: number): Promise<void> {
    if (!Number.isInteger(nextCursor) || nextCursor < 0) throw new Error("Server cursor is invalid");
    const checkedChanges = changes.map(validatePullChange);
    await this.transaction(() => {
      const currentCursor = this.currentCursorDirect();
      if (!Number.isFinite(nextCursor) || nextCursor < currentCursor) throw new Error("Server cursor moved backwards");
      let appliedCursor = currentCursor;
      for (const change of [...checkedChanges].sort((left, right) => left.sequence - right.sequence)) {
        if (change.sequence <= currentCursor) continue;
        this.applyRemoteDirect(change);
        appliedCursor = Math.max(appliedCursor, change.sequence);
      }
      this.setCursorDirect(Math.max(appliedCursor, nextCursor));
    });
  }

  async applyServerSnapshot(change: PullChange, operationID?: string): Promise<void> {
    const checkedChange = validateServerSnapshot(change);
    await this.transaction(() => {
      const pending = this.pendingForEntityDirect(checkedChange.entityType, checkedChange.entityId).filter((operation) => operation.opId !== operationID);
      if (pending.length > 0) {
        if (operationID && this.hasConflictServerMarkerDirect(operationID)) return;
        this.insertConflictDirect(checkedChange.entityType, checkedChange.entityId, checkedChange.payload, "server snapshot while newer local edit is pending", checkedChange.sequence);
        if (operationID) this.markConflictServerDirect(operationID);
        if (checkedChange.revision > 0) this.db.exec({ sql: "UPDATE outbox SET base_revision = ? WHERE entity_type = ? AND entity_id = ? AND state = 'pending'", bind: [checkedChange.revision, checkedChange.entityType, checkedChange.entityId] });
        return;
      }
      this.applySnapshotDirect(checkedChange);
    });
  }

  async getCursor(): Promise<number> { return this.currentCursorDirect(); }

  async setCursor(cursor: number): Promise<void> {
    await this.transaction(() => {
      const current = this.currentCursorDirect();
      if (!Number.isInteger(cursor) || cursor < current) throw new Error("Server cursor moved backwards");
      this.setCursorDirect(cursor);
    });
  }

  async resetCursor(): Promise<void> {
    await this.transaction(() => this.setCursorDirect(0));
  }

  async listConflicts(): Promise<ConflictCopy[]> {
    return this.query(`SELECT id, entity_type, entity_id, payload, created_at, reason, sequence FROM conflicts ORDER BY created_at, rowid`).map((row) => {
      if (typeof row.id !== "string" || typeof row.entity_type !== "string" || typeof row.entity_id !== "string" || typeof row.payload !== "string" || typeof row.created_at !== "string" || typeof row.reason !== "string") throw new CorruptSnapshotError("Conflict row is malformed");
      try {
        return {
          id: row.id,
          entityType: row.entity_type as SyncEntityType,
          entityId: row.entity_id,
          payload: JSON.parse(row.payload) as Record<string, unknown>,
          createdAt: row.created_at,
          reason: row.reason,
          sequence: Number(row.sequence ?? 0),
        };
      } catch (error) {
        throw new CorruptSnapshotError(`Conflict snapshot could not be decoded: ${error instanceof Error ? error.message : "invalid JSON"}`);
      }
    });
  }

  async deleteConflict(conflictID: string): Promise<void> { await this.transaction(() => this.db.exec({ sql: "DELETE FROM conflicts WHERE id = ?", bind: [conflictID] })); }

  async exportArchive(): Promise<Archive> {
    const notebooks = await this.listNotebooks(true);
    const pages = (await Promise.all(notebooks.map((notebook) => this.listPages(notebook.id, true)))).flat();
    return { version: 1, exportedAt: now(), account: this.accountKey, notebooks, pages };
  }

  async importArchive(archive: Archive): Promise<{ notebooks: number; pages: number }> {
    const rawArchive = record(archive, "Archive");
    if (rawArchive.version !== 1 || !Array.isArray(rawArchive.notebooks) || !Array.isArray(rawArchive.pages)) throw new Error("Unsupported NotePad archive");
    requiredString(rawArchive.account, "Archive account", 2_000);
    requiredString(rawArchive.exportedAt, "Archive exportedAt");
    if (rawArchive.notebooks.length > MAX_ARCHIVE_NOTEBOOKS || rawArchive.pages.length > MAX_ARCHIVE_PAGES) throw new Error("Archive has too many notes");
    let archiveBytes: number;
    try {
      const serialized = JSON.stringify(rawArchive);
      if (typeof serialized !== "string") throw new Error("Archive is not serializable");
      archiveBytes = new TextEncoder().encode(serialized).byteLength;
    } catch (error) {
      throw new Error(`Archive could not be read: ${error instanceof Error ? error.message : "invalid JSON"}`);
    }
    if (archiveBytes > MAX_ARCHIVE_BYTES) throw new Error("Archive is larger than 50 MB");

    const notebooks = rawArchive.notebooks.map((value, index) => {
      try { return validateNotebookSnapshot(value); }
      catch (error) { throw new Error(`Archive notebook ${index + 1} is invalid: ${error instanceof Error ? error.message : "invalid snapshot"}`); }
    });
    const notebookIDs = new Set<string>();
    notebooks.forEach((notebook, index) => {
      if (notebookIDs.has(notebook.id)) throw new Error(`Archive contains duplicate notebook ID at item ${index + 1}`);
      notebookIDs.add(notebook.id);
    });
    const pages = rawArchive.pages.map((value, index) => {
      try { return validatePageSnapshot(value); }
      catch (error) { throw new Error(`Archive page ${index + 1} is invalid: ${error instanceof Error ? error.message : "invalid snapshot"}`); }
    });
    const pageIDs = new Set<string>();
    pages.forEach((page, index) => {
      if (pageIDs.has(page.id)) throw new Error(`Archive contains duplicate page ID at item ${index + 1}`);
      pageIDs.add(page.id);
      if (!notebookIDs.has(page.notebookId)) throw new Error(`Archive page ${index + 1} refers to a missing notebook`);
    });
    return this.transaction(() => {
      const occupied = new Set<string>();
      for (const row of this.query<{ id: unknown }>("SELECT id FROM notebooks UNION SELECT id FROM pages")) if (typeof row.id === "string") occupied.add(row.id);
      const freshID = (): string => {
        let value = id();
        while (occupied.has(value)) value = id();
        occupied.add(value);
        return value;
      };
      const remappedNotebookIDs = new Map<string, string>();
      const inputNotebooks = notebooks.map((notebook) => {
        const newID = freshID();
        remappedNotebookIDs.set(notebook.id, newID);
        return { ...notebook, id: newID, revision: 0, deletedAt: null, updatedAt: now() };
      });
      const inputPages = pages.map((page) => ({
        ...page,
        id: freshID(),
        notebookId: remappedNotebookIDs.get(page.notebookId)!,
        revision: 0,
        deletedAt: null,
        conflictOf: undefined,
        updatedAt: now(),
      }));
      inputNotebooks.forEach((notebook) => this.saveNotebookRow(notebook, true));
      inputPages.forEach((page) => this.savePageRow(page, true));
      return { notebooks: inputNotebooks.length, pages: inputPages.length };
    });
  }

  async ensureStarterData(): Promise<{ notebook: Notebook; page: NotePage }> {
    const notebooks = await this.listNotebooks();
    if (notebooks.length > 0) {
      const notebook = notebooks[0]!;
      const pages = await this.listPages(notebook.id);
      if (pages.length > 0) return { notebook, page: pages[0]! };
      const page = createPage(notebook.id, "First page");
      await this.savePage(page);
      return { notebook, page: (await this.getPage(page.id))! };
    }
    const notebook = createNotebook("My notebook");
    await this.saveNotebook(notebook);
    const page = createPage(notebook.id, "First page");
    await this.savePage(page);
    return { notebook: (await this.getNotebook(notebook.id))!, page: (await this.getPage(page.id))! };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.writeQueue.catch(() => undefined);
    if (this.syncLeases > 0) await new Promise<void>((resolve) => this.closeWaiters.push(resolve));
    this.closed = true;
    this.db.close?.();
    this.lock.release();
  }

  acquireSyncLease(): () => void {
    if (this.closed) throw new Error("Notebook database is closed");
    this.syncLeases += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.syncLeases = Math.max(0, this.syncLeases - 1);
      if (this.syncLeases === 0) {
        const waiters = this.closeWaiters.splice(0);
        waiters.forEach((resolve) => resolve());
      }
    };
  }

  private getOperationDirect(opID: string): SyncOperation | null {
    return this.operationFromRow(this.query(`SELECT op_id, entity_type, entity_id, base_revision, action, payload, created_at, state FROM outbox WHERE op_id = ?`, [opID])[0]);
  }

  private conflictRecoveryKey(operationID: string): string {
    return `conflict-recovery:${operationID}`;
  }

  private conflictServerKey(operationID: string): string {
    return `conflict-server:${operationID}`;
  }

  private hasConflictRecoveryMarkerDirect(operationID: string): boolean {
    return this.query("SELECT value FROM metadata WHERE key = ?", [this.conflictRecoveryKey(operationID)]).length > 0;
  }

  private markConflictRecoveryDirect(operationID: string): void {
    this.db.exec({ sql: "INSERT INTO metadata(key, value) VALUES(?, ?) ON CONFLICT(key) DO NOTHING", bind: [this.conflictRecoveryKey(operationID), "1"] });
  }

  private hasConflictServerMarkerDirect(operationID: string): boolean {
    return this.query("SELECT value FROM metadata WHERE key = ?", [this.conflictServerKey(operationID)]).length > 0;
  }

  private markConflictServerDirect(operationID: string): void {
    this.db.exec({ sql: "INSERT INTO metadata(key, value) VALUES(?, ?) ON CONFLICT(key) DO NOTHING", bind: [this.conflictServerKey(operationID), "1"] });
  }

  private currentCursorDirect(): number {
    const row = this.query<{ value: unknown }>("SELECT value FROM metadata WHERE key = 'cursor'")[0];
    if (!row) return 0;
    const cursor = Number(row.value);
    if (!Number.isInteger(cursor) || cursor < 0) throw new CorruptSnapshotError("Stored sync cursor is invalid");
    return cursor;
  }

  private setCursorDirect(cursor: number): void {
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error("Server cursor is invalid");
    this.db.exec({ sql: `INSERT INTO metadata(key, value) VALUES('cursor', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`, bind: [String(cursor)] });
  }

  private pendingForEntityDirect(entityType: SyncEntityType, entityID: string): SyncOperation[] {
    return this.query(`SELECT op_id, entity_type, entity_id, base_revision, action, payload, created_at, state
      FROM outbox WHERE entity_type = ? AND entity_id = ? AND state IN ('pending', 'sending') ORDER BY created_at, rowid`, [entityType, entityID]).map((row) => this.operationFromRow(row)).filter((value): value is SyncOperation => value !== null);
  }

  private applyRemoteDirect(change: PullChange): void {
    const pending = this.pendingForEntityDirect(change.entityType, change.entityId);
    // Pulls can contain our own acknowledged change while a newer local edit
    // is already queued. It is historical at that point and must not become a
    // conflict copy. Pending base revisions cover a row that has not yet been
    // refreshed with its latest acknowledged revision.
    const table = change.entityType === "page" ? "pages" : "notebooks";
    const row = this.row(change.entityId, table);
    const currentRevision = row ? Number(row.revision) : 0;
    if (!Number.isInteger(currentRevision) || currentRevision < 0) throw new CorruptSnapshotError("Stored entity revision is invalid");
    const acknowledgedRevision = Math.max(
      currentRevision,
      ...pending.map((operation) => operation.baseRevision),
    );
    if (change.revision <= acknowledgedRevision) return;
    if (pending.length > 0) {
      this.insertConflictDirect(change.entityType, change.entityId, change.payload, "remote update while local edit is pending", change.sequence);
      return;
    }
    this.applySnapshotDirect(change);
  }

  private applySnapshotDirect(change: PullChange): void {
    if (change.entityType === "page") {
      const current = this.pageFromRow(this.row(change.entityId, "pages"));
      if (current && current.revision >= change.revision) return;
      if (change.action === "delete") {
        const source = validatePageSnapshot(change.payload, change.entityId, change.revision, true);
        this.upsertPageDirect({ ...source, revision: change.revision, deletedAt: source.deletedAt ?? now(), updatedAt: now() });
      } else {
        this.upsertPageDirect(validatePageSnapshot(change.payload, change.entityId, change.revision, true));
      }
    } else {
      const current = this.notebookFromRow(this.row(change.entityId, "notebooks"));
      if (current && current.revision >= change.revision) return;
      if (change.action === "delete") {
        const source = validateNotebookSnapshot(change.payload, change.entityId);
        this.upsertNotebookDirect({ ...source, revision: change.revision, deletedAt: source.deletedAt ?? now(), updatedAt: now() });
      } else {
        const source = validateNotebookSnapshot(change.payload, change.entityId);
        this.upsertNotebookDirect({ ...source, revision: change.revision });
      }
    }
  }

  private insertConflictDirect(entityType: SyncEntityType, entityID: string, payload: Record<string, unknown>, reason: string, sequence: number): void {
    if (sequence > 0 && this.query<{ id: unknown }>(
      "SELECT id FROM conflicts WHERE entity_type = ? AND entity_id = ? AND sequence = ? LIMIT 1",
      [entityType, entityID, sequence],
    ).length > 0) return;
    this.db.exec({ sql: "INSERT INTO conflicts(id, entity_type, entity_id, payload, created_at, reason, sequence) VALUES(?, ?, ?, ?, ?, ?, ?)", bind: [id(), entityType, entityID, JSON.stringify(payload), now(), reason, sequence] });
    // Keep the conflict recoverable through the normal notebook/page lists and
    // archive export. A newly recovered parent is also queued in this same
    // transaction so a later page edit has a server-side owner.
    if (entityType === "notebook") {
      const notebook = validateNotebookSnapshot(payload, entityID);
      const recoveredNotebook = sanitizeNotebook({ ...notebook, id: id(), title: conflictTitle(notebook.title, MAX_NOTEBOOK_TITLE), revision: 0, deletedAt: null, updatedAt: now() });
      this.upsertNotebookDirect(recoveredNotebook);
      this.queueOperation({
        entityType: "notebook",
        entityId: recoveredNotebook.id,
        baseRevision: 0,
        action: "upsert",
        payload: recoveredNotebook as unknown as Record<string, unknown>,
      });
      return;
    }
    const page = validatePageSnapshot(payload, entityID, undefined, true);
    const notebook = this.notebookFromRow(this.row(page.notebookId, "notebooks"));
    let notebookID = page.notebookId;
    if (!notebook || notebook.deletedAt) {
      const recoveredNotebook = notebook
        ? { ...notebook, id: id(), title: conflictTitle(notebook.title, MAX_NOTEBOOK_TITLE), revision: 0, deletedAt: null, updatedAt: now() }
        : createNotebook("Recovered page");
      const savedNotebook = sanitizeNotebook(recoveredNotebook);
      this.upsertNotebookDirect(savedNotebook);
      // Keep both the recovery parent and page in the normal sync drain so all
      // devices expose the same recoverable copy.
      this.queueOperation({
        entityType: "notebook",
        entityId: savedNotebook.id,
        baseRevision: 0,
        action: "upsert",
        payload: savedNotebook as unknown as Record<string, unknown>,
      });
      notebookID = savedNotebook.id;
    }
    const recoveredPage = sanitizePage({ ...page, id: id(), notebookId: notebookID, title: conflictTitle(page.title, MAX_PAGE_TITLE), revision: 0, deletedAt: null, conflictOf: entityID, updatedAt: now() });
    this.upsertPageDirect(recoveredPage);
    this.queueOperation({
      entityType: "page",
      entityId: recoveredPage.id,
      baseRevision: 0,
      action: "upsert",
      payload: toWirePage(recoveredPage) as unknown as Record<string, unknown>,
    });
  }

  private upsertPageDirect(page: NotePage): void {
    const saved = sanitizePage(page);
    this.db.exec({
      sql: `INSERT INTO pages(id, notebook_id, revision, deleted_at, json) VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET notebook_id=excluded.notebook_id, revision=excluded.revision,
          deleted_at=excluded.deleted_at, json=excluded.json`,
      bind: [saved.id, saved.notebookId, saved.revision, saved.deletedAt, JSON.stringify(saved)],
    });
  }

  private upsertNotebookDirect(notebook: Notebook): void {
    const saved = sanitizeNotebook(notebook);
    this.db.exec({
      sql: `INSERT INTO notebooks(id, revision, deleted_at, json) VALUES(?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, deleted_at=excluded.deleted_at, json=excluded.json`,
      bind: [saved.id, saved.revision, saved.deletedAt, JSON.stringify(saved)],
    });
  }
}

interface WorkerRequest {
  id: number;
  method: string;
  args: unknown[];
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: { name?: string; message?: string };
}

/** Main-thread facade. All SQLite, JSON validation, and snapshot I/O run in the worker. */
export class SQLiteNoteStore implements NoteStore {
  readonly accountKey: string;
  persistence: "opfs" | "indexeddb";
  private readonly worker: Worker;
  private nextRequestID = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  private syncLeases = 0;
  private closeWaiters: Array<() => void> = [];
  private closed = false;
  private closePromise: Promise<void> | null = null;

  private constructor(worker: Worker, accountKey: string, persistence: "opfs" | "indexeddb") {
    this.worker = worker;
    this.accountKey = accountKey;
    this.persistence = persistence;
    worker.addEventListener("message", this.handleMessage);
    worker.addEventListener("error", this.handleWorkerError);
    worker.addEventListener("messageerror", this.handleWorkerMessageError);
  }

  static async open(accountKey: string): Promise<SQLiteNoteStore> {
    const worker = new Worker(new URL("./storage.worker.ts", import.meta.url), { type: "module" });
    const provisional = new SQLiteNoteStore(worker, accountKey, "indexeddb");
    try {
      const descriptor = await provisional.rpc<{ accountKey: string; persistence: "opfs" | "indexeddb" }>("open", [accountKey]);
      if (!descriptor || descriptor.accountKey !== accountKey || (descriptor.persistence !== "opfs" && descriptor.persistence !== "indexeddb")) throw new Error("The notebook worker returned an invalid storage descriptor");
      provisional.persistence = descriptor.persistence;
      return provisional;
    } catch (error) {
      provisional.rejectPending(error);
      worker.terminate();
      throw error;
    }
  }

  private readonly handleMessage = (event: MessageEvent<WorkerResponse>): void => {
    const response = event.data;
    if (!response || typeof response.id !== "number") return;
    const waiter = this.pending.get(response.id);
    if (!waiter) return;
    this.pending.delete(response.id);
    if (response.ok) waiter.resolve(response.value);
    else {
      const error = new Error(response.error?.message ?? "Notebook worker failed");
      error.name = response.error?.name ?? "Error";
      waiter.reject(error);
    }
  };

  private readonly handleWorkerError = (event: ErrorEvent): void => {
    this.rejectPending(new Error(event.message || "Notebook worker stopped"));
  };

  private readonly handleWorkerMessageError = (): void => {
    this.rejectPending(new Error("Notebook worker could not transfer a request"));
  };

  private rejectPending(error: unknown): void {
    const waiters = [...this.pending.values()];
    this.pending.clear();
    waiters.forEach((waiter) => waiter.reject(error));
  }

  private rpc<T>(method: string, args: unknown[] = []): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Notebook database is closed"));
    return new Promise<T>((resolve, reject) => {
      const id = this.nextRequestID++;
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try { this.worker.postMessage({ id, method, args } satisfies WorkerRequest); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  listNotebooks(includeDeleted = false): Promise<Notebook[]> { return this.rpc("listNotebooks", [includeDeleted]); }
  getNotebook(entityID: string): Promise<Notebook | null> { return this.rpc("getNotebook", [entityID]); }
  saveNotebook(notebook: Notebook, queue = true): Promise<SaveResult> { return this.rpc("saveNotebook", [notebook, queue]); }
  listPages(notebookID: string, includeDeleted = false): Promise<NotePage[]> { return this.rpc("listPages", [notebookID, includeDeleted]); }
  getPage(entityID: string): Promise<NotePage | null> { return this.rpc("getPage", [entityID]); }
  savePage(page: NotePage, queue = true): Promise<SaveResult> { return this.rpc("savePage", [page, queue]); }
  deletePage(entityID: string): Promise<SaveResult> { return this.rpc("deletePage", [entityID]); }
  restorePage(entityID: string): Promise<SaveResult> { return this.rpc("restorePage", [entityID]); }
  archiveNotebook(entityID: string): Promise<SaveResult> { return this.rpc("archiveNotebook", [entityID]); }
  restoreNotebook(entityID: string): Promise<SaveResult> { return this.rpc("restoreNotebook", [entityID]); }
  createConflictCopy(page: NotePage, originalPageID: string): Promise<NotePage> { return this.rpc("createConflictCopy", [page, originalPageID]); }
  createConflictCopyFromOperation(operation: SyncOperation, originalPageID?: string): Promise<void> { return this.rpc("createConflictCopyFromOperation", [operation, originalPageID]); }
  pendingOperations(limit = 50): Promise<SyncOperation[]> { return this.rpc("pendingOperations", [limit]); }
  getOperation(opID: string): Promise<SyncOperation | null> { return this.rpc("getOperation", [opID]); }
  markOperationSending(opID: string): Promise<void> { return this.rpc("markOperationSending", [opID]); }
  markOperationPending(opID: string): Promise<void> { return this.rpc("markOperationPending", [opID]); }
  markOperationAcked(opID: string, revision?: number, updateEntityRevision = true): Promise<void> { return this.rpc("markOperationAcked", [opID, revision, updateEntityRevision]); }
  applyRemote(change: PullChange): Promise<void> { return this.rpc("applyRemote", [change]); }
  applyRemoteBatch(changes: PullChange[], nextCursor: number): Promise<void> { return this.rpc("applyRemoteBatch", [changes, nextCursor]); }
  applyServerSnapshot(change: PullChange, operationID?: string): Promise<void> { return this.rpc("applyServerSnapshot", [change, operationID]); }
  getCursor(): Promise<number> { return this.rpc("getCursor"); }
  setCursor(cursor: number): Promise<void> { return this.rpc("setCursor", [cursor]); }
  resetCursor(): Promise<void> { return this.rpc("resetCursor"); }
  listConflicts(): Promise<ConflictCopy[]> { return this.rpc("listConflicts"); }
  deleteConflict(conflictID: string): Promise<void> { return this.rpc("deleteConflict", [conflictID]); }
  exportArchive(): Promise<Archive> { return this.rpc("exportArchive"); }
  importArchive(archive: Archive): Promise<{ notebooks: number; pages: number }> { return this.rpc("importArchive", [archive]); }
  ensureStarterData(): Promise<{ notebook: Notebook; page: NotePage }> { return this.rpc("ensureStarterData"); }

  acquireSyncLease(): () => void {
    if (this.closed) throw new Error("Notebook database is closed");
    this.syncLeases += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.syncLeases = Math.max(0, this.syncLeases - 1);
      if (this.syncLeases === 0) {
        const waiters = this.closeWaiters.splice(0);
        waiters.forEach((resolve) => resolve());
      }
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (this.syncLeases > 0) await new Promise<void>((resolve) => this.closeWaiters.push(resolve));
      if (this.closed) return;
      try { await this.rpc<void>("close"); }
      finally {
        this.closed = true;
        this.rejectPending(new Error("Notebook database is closed"));
        this.worker.removeEventListener("message", this.handleMessage);
        this.worker.removeEventListener("error", this.handleWorkerError);
        this.worker.removeEventListener("messageerror", this.handleWorkerMessageError);
        this.worker.terminate();
      }
    })();
    return this.closePromise;
  }
}

function deserializeSnapshot(sqlite: SQLiteRuntime, db: SQLiteDatabase, image: Uint8Array): void {
  try {
    const pointer = sqlite.wasm.allocFromTypedArray(image);
    const flags = (sqlite.capi.SQLITE_DESERIALIZE_FREEONCLOSE ?? 1) | (sqlite.capi.SQLITE_DESERIALIZE_RESIZEABLE ?? 2);
    const result = sqlite.capi.sqlite3_deserialize(db.pointer, "main", pointer, image.byteLength, image.byteLength, flags);
    if (result !== 0) {
      db.close?.();
      throw new CorruptSnapshotError(`SQLite snapshot could not be decoded (code ${result})`);
    }
  } catch (error) {
    db.close?.();
    if (error instanceof CorruptSnapshotError) throw error;
    throw new CorruptSnapshotError(`SQLite snapshot could not be decoded: ${error instanceof Error ? error.message : "invalid image"}`);
  }
}
