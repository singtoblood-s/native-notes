import { SQLiteNoteStoreEngine } from "./storage";

interface WorkerRequest {
  id: number;
  method: string;
  args: unknown[];
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string };
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
}

const scope = globalThis as unknown as WorkerScope;
const allowedMethods = new Set([
  "listNotebooks", "getNotebook", "saveNotebook", "listPages", "getPage", "savePage", "importDocument",
  "deletePage", "restorePage", "archiveNotebook", "restoreNotebook", "duplicateNotebook", "movePage",
  "createConflictCopyFromOperation", "pendingOperations", "getOperation", "markOperationSending",
  "markOperationPending", "markOperationAcked", "applyRemote", "applyRemoteBatch", "applyServerSnapshot",
  "archiveEmptyConflictNotebooks", "getCursor", "setCursor", "resetCursor", "listConflicts", "deleteConflict", "exportArchive", "importArchive", "ensureStarterData",
]);
let engine: SQLiteNoteStoreEngine | null = null;
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (event) => {
  const request = event.data;
  queue = queue.then(() => dispatch(request)).catch(() => undefined);
};

async function dispatch(request: WorkerRequest): Promise<void> {
  try {
    if (!request || !Number.isInteger(request.id) || typeof request.method !== "string" || !Array.isArray(request.args)) throw new Error("Invalid notebook worker request");
    if (request.method === "open") {
      if (engine) throw new Error("Notebook worker is already open");
      const accountKey = request.args[0];
      if (typeof accountKey !== "string" || !accountKey) throw new Error("Account key is required");
      engine = await SQLiteNoteStoreEngine.open(accountKey);
      respond(request.id, true, { accountKey: engine.accountKey, persistence: engine.persistence });
      return;
    }
    if (request.method === "close") {
      if (engine) await engine.close();
      engine = null;
      respond(request.id, true, undefined);
      return;
    }
    if (!engine || !allowedMethods.has(request.method)) throw new Error("Invalid notebook worker method");
    const method = (engine as unknown as Record<string, unknown>)[request.method];
    if (typeof method !== "function") throw new Error("Notebook worker method is unavailable");
    const value = await Reflect.apply(method, engine, request.args);
    respond(request.id, true, value);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error("Notebook worker failed");
    respond(request.id, false, undefined, { name: failure.name, message: failure.message });
  }
}

function respond(id: number, ok: boolean, value?: unknown, error?: { name: string; message: string }): void {
  scope.postMessage({ id, ok, value, error });
}
