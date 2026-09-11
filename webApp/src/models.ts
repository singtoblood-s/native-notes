export type PageBackground = "blank" | "ruled" | "grid";

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  time: number;
  tiltX: number | null;
  tiltY: number | null;
}

export interface InkStroke {
  id: string;
  /** Unsigned ARGB. JSON numbers are safe because the value is <= 2^32. */
  color: number;
  width: number;
  points: StrokePoint[];
}

export interface Notebook {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  revision: number;
}

export interface NotePage {
  id: string;
  notebookId: string;
  title: string;
  text: string;
  background: PageBackground;
  width: number;
  height: number;
  strokes: InkStroke[];
  formatVersion: number;
  revision: number;
  updatedAt: string;
  deletedAt: string | null;
  /** Local only; stripped before a sync request. */
  conflictOf?: string;
}

export type SyncEntityType = "notebook" | "page";
export type SyncAction = "upsert" | "delete";

export interface SyncOperation {
  opId: string;
  entityType: SyncEntityType;
  entityId: string;
  baseRevision: number;
  action: SyncAction;
  payload: Record<string, unknown>;
  createdAt: string;
  /** Local durability state. Sent operations keep their opId and payload immutable. */
  state?: "pending" | "sending";
}

export interface ConflictCopy {
  id: string;
  entityType: SyncEntityType;
  entityId: string;
  payload: Record<string, unknown>;
  createdAt: string;
  reason: string;
  sequence?: number;
}

export interface PushResult {
  opId: string;
  status: "acked" | "conflict" | "rejected";
  revision?: number | null;
  sequence?: number | null;
  serverPayload?: Record<string, unknown> | null;
  code?: string | null;
}

export interface PushResponse {
  results: PushResult[];
  cursor: number;
}

export interface PullChange {
  sequence: number;
  entityType: SyncEntityType;
  entityId: string;
  revision: number;
  action: SyncAction;
  payload: Record<string, unknown>;
}

export interface PullResponse {
  changes: PullChange[];
  nextCursor: number;
  hasMore: boolean;
}

export interface User {
  id: string;
  identifier: string;
}

export interface AuthResponse {
  user: User;
  sessionToken: string;
  expiresAt: string;
}

export type SaveStatus = "saved" | "failed";

export interface SaveResult {
  status: SaveStatus;
  operationId?: string;
  message?: string;
  revision?: number;
}

export type SyncState =
  | { kind: "ready" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "offline" }
  | { kind: "needs-login" }
  | { kind: "syncing" }
  | { kind: "conflict"; count: number }
  | { kind: "error"; message: string };

export const INK_FORMAT_VERSION = 1;
export const DEFAULT_PAGE_WIDTH = 1024;
export const DEFAULT_PAGE_HEIGHT = 1366;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUUID(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function requireUUID(value: unknown, label: string): string {
  if (!isUUID(value)) throw new Error(`${label} must be a UUID`);
  return value.toLowerCase();
}

export function id(): string {
  return crypto.randomUUID().toLowerCase();
}

export function now(): string {
  return new Date().toISOString();
}

export function createNotebook(title = "My notebook"): Notebook {
  const timestamp = now();
  return { id: id(), title, createdAt: timestamp, updatedAt: timestamp, deletedAt: null, revision: 0 };
}

export function createPage(notebookId: string, title = "Page 1"): NotePage {
  return {
    id: id(),
    notebookId,
    title,
    text: "",
    background: "blank",
    width: DEFAULT_PAGE_WIDTH,
    height: DEFAULT_PAGE_HEIGHT,
    strokes: [],
    formatVersion: INK_FORMAT_VERSION,
    revision: 0,
    updatedAt: now(),
    deletedAt: null,
  };
}

export function clonePage(page: NotePage): NotePage {
  return {
    ...page,
    strokes: page.strokes.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({ ...point })),
    })),
  };
}

export function sanitizePoint(point: Partial<StrokePoint>): StrokePoint {
  const pressure = Number.isFinite(point.pressure) ? Math.min(1, Math.max(0, point.pressure ?? 0.5)) : 0.5;
  const time = Number.isFinite(point.time) ? Math.max(0, Math.round(point.time ?? 0)) : 0;
  return {
    x: Number.isFinite(point.x) ? point.x ?? 0 : 0,
    y: Number.isFinite(point.y) ? point.y ?? 0 : 0,
    pressure,
    time,
    tiltX: Number.isFinite(point.tiltX) ? point.tiltX ?? null : null,
    tiltY: Number.isFinite(point.tiltY) ? point.tiltY ?? null : null,
  };
}

export function sanitizeStroke(stroke: Partial<InkStroke>): InkStroke {
  const color = Number.isFinite(stroke.color) ? (Math.trunc(stroke.color ?? 0xff1b1b1f) >>> 0) : 0xff1b1b1f;
  return {
    id: typeof stroke.id === "string" && stroke.id ? stroke.id.toLowerCase() : id(),
    color,
    width: Number.isFinite(stroke.width) ? Math.max(0.5, stroke.width ?? 2.5) : 2.5,
    points: Array.isArray(stroke.points) ? stroke.points.map((point) => sanitizePoint(point)) : [],
  };
}

export function sanitizePage(input: Partial<NotePage>): NotePage {
  return {
    id: typeof input.id === "string" && input.id ? input.id.toLowerCase() : id(),
    notebookId: typeof input.notebookId === "string" ? input.notebookId.toLowerCase() : id(),
    title: typeof input.title === "string" ? input.title : "Untitled page",
    text: typeof input.text === "string" ? input.text : "",
    background: input.background === "ruled" || input.background === "grid" ? input.background : "blank",
    width: Number.isFinite(input.width) ? Math.max(320, input.width ?? DEFAULT_PAGE_WIDTH) : DEFAULT_PAGE_WIDTH,
    height: Number.isFinite(input.height) ? Math.max(320, input.height ?? DEFAULT_PAGE_HEIGHT) : DEFAULT_PAGE_HEIGHT,
    strokes: Array.isArray(input.strokes) ? input.strokes.map((stroke) => sanitizeStroke(stroke)) : [],
    formatVersion: Number.isInteger(input.formatVersion) ? input.formatVersion ?? INK_FORMAT_VERSION : INK_FORMAT_VERSION,
    revision: Number.isInteger(input.revision) ? Math.max(0, input.revision ?? 0) : 0,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now(),
    deletedAt: typeof input.deletedAt === "string" ? input.deletedAt : null,
    conflictOf: typeof input.conflictOf === "string" ? input.conflictOf : undefined,
  };
}

export function sanitizeNotebook(input: Partial<Notebook>): Notebook {
  return {
    id: typeof input.id === "string" && input.id ? input.id.toLowerCase() : id(),
    title: typeof input.title === "string" ? input.title : "Untitled notebook",
    createdAt: typeof input.createdAt === "string" ? input.createdAt : now(),
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now(),
    deletedAt: typeof input.deletedAt === "string" ? input.deletedAt : null,
    revision: Number.isInteger(input.revision) ? Math.max(0, input.revision ?? 0) : 0,
  };
}

/** Remove local conflict metadata before sending a page to the server. */
export function toWirePage(page: NotePage): Omit<NotePage, "conflictOf"> {
  const { conflictOf: _conflictOf, ...wire } = page;
  return wire;
}

export function toWirePayload(operation: SyncOperation): Record<string, unknown> {
  if (operation.entityType === "page" && operation.action === "upsert") {
    return toWirePage(sanitizePage(operation.payload as Partial<NotePage>)) as unknown as Record<string, unknown>;
  }
  return operation.payload;
}
