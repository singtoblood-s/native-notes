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

/** A raster image placed on a page. `src` is a safe raster data URL. */
export interface PageImage {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
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
  /** Optional for backwards compatibility with pages written before images. */
  images?: PageImage[];
  /** Stable page order; legacy pages omit it and use a deterministic fallback. */
  order?: number;
  formatVersion: number;
  revision: number;
  updatedAt: string;
  deletedAt: string | null;
  /** Marks a recovered copy so it can be shown separately from the original page. */
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
export const PAGE_METADATA_FORMAT_VERSION = 2;
export const DEFAULT_PAGE_WIDTH = 1024;
export const DEFAULT_PAGE_HEIGHT = 1366;
export const MAX_PAGE_IMAGES = 100;
export const MAX_TITLE_LENGTH = 500;
export const MAX_PAGE_TEXT_LENGTH = 1_000_000;
export const MAX_PAGE_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_PAGE_IMAGE_BYTES_TOTAL = 10 * 1024 * 1024;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PAGE_IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/i;

/** Return decoded bytes for an allowed image data URL, or null when unsafe/malformed. */
export function pageImageDataBytes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = PAGE_IMAGE_DATA_URL.exec(value);
  if (!match) return null;
  const encoded = match[2]!;
  if (encoded.length === 0 || encoded.length % 4 !== 0) return null;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const bytes = encoded.length / 4 * 3 - padding;
  return bytes > 0 && Number.isSafeInteger(bytes) ? bytes : null;
}

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

/** Reserve space for the suffix without splitting a Unicode surrogate pair. */
export function copyTitle(title: string): string {
  return `${title.slice(0, MAX_TITLE_LENGTH - 7).replace(/[\uD800-\uDBFF]$/, "")} (copy)`;
}

export function searchText(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
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
    images: [],
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
    images: page.images?.map((image) => ({ ...image })),
  };
}

export function sanitizePageImage(input: Partial<PageImage>): PageImage {
  return {
    id: typeof input.id === "string" && input.id ? input.id.toLowerCase() : id(),
    src: typeof input.src === "string" ? input.src : "",
    x: Number.isFinite(input.x) ? input.x ?? 0 : 0,
    y: Number.isFinite(input.y) ? input.y ?? 0 : 0,
    width: Number.isFinite(input.width) && (input.width ?? 0) > 0 ? input.width! : 1,
    height: Number.isFinite(input.height) && (input.height ?? 0) > 0 ? input.height! : 1,
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
    width: Number.isFinite(stroke.width) ? Math.max(0.1, stroke.width ?? 2.5) : 2.5,
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
    width: Number.isFinite(input.width) ? Math.max(1, input.width ?? DEFAULT_PAGE_WIDTH) : DEFAULT_PAGE_WIDTH,
    height: Number.isFinite(input.height) ? Math.max(1, input.height ?? DEFAULT_PAGE_HEIGHT) : DEFAULT_PAGE_HEIGHT,
    strokes: Array.isArray(input.strokes) ? input.strokes.map((stroke) => sanitizeStroke(stroke)) : [],
    images: Array.isArray(input.images) ? input.images.map((image) => sanitizePageImage(image)) : undefined,
    order: Number.isSafeInteger(input.order) && (input.order ?? 0) >= 0 ? input.order : undefined,
    formatVersion: Number.isInteger(input.formatVersion)
      ? ((Array.isArray(input.images) && input.images.length > 0) || Number.isSafeInteger(input.order) || typeof input.conflictOf === "string" ? PAGE_METADATA_FORMAT_VERSION : input.formatVersion ?? INK_FORMAT_VERSION)
      : ((Array.isArray(input.images) && input.images.length > 0) || Number.isSafeInteger(input.order) || typeof input.conflictOf === "string" ? PAGE_METADATA_FORMAT_VERSION : INK_FORMAT_VERSION),
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

/** Keep conflict metadata on the wire so recovered copies stay consistent across devices. */
export function toWirePage(page: NotePage): NotePage {
  return { ...page, images: page.images?.map((image) => ({ ...image })) };
}

export function toWirePayload(operation: SyncOperation): Record<string, unknown> {
  if (operation.entityType === "page" && operation.action === "upsert") {
    return toWirePage(sanitizePage(operation.payload as Partial<NotePage>)) as unknown as Record<string, unknown>;
  }
  return operation.payload;
}
