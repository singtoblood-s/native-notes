import { AuthResponse, User } from "./models";

const SESSION_KEY = "notepad.session";
const ENDPOINT_KEY = "notepad.endpoint";
const WORKSPACE_KEY = "notepad.workspace";
const WORKSPACES_KEY = "notepad.workspaces";
const ACTIVE_WORKSPACE_KEY = "notepad.active-workspace";
/** The public tunnel used by builds before the D1 worker migration. */
export const LEGACY_API_URL = "https://nascar-essay-what-josh.trycloudflare.com";

interface StoredSession extends AuthResponse {
  endpoint: string;
}

export interface WorkspaceIdentity {
  endpoint: string;
  userID: string;
  identifier: string;
}

function workspaceIdentityKey(identity: Pick<WorkspaceIdentity, "endpoint" | "userID">): string {
  return workspaceAccountKey(identity.endpoint, identity.userID);
}

/**
 * Convert a stored account key to the key used by the local SQLite namespace.
 * The public account key stays canonical so SyncClient's account guard remains
 * effective; only the local hash may use the old endpoint alias.
 */
export function resolveStorageAccountKey(accountKey: string): string {
  const separator = accountKey.lastIndexOf(":");
  if (separator <= 0 || separator === accountKey.length - 1) return accountKey;
  const endpoint = normalizeEndpoint(accountKey.slice(0, separator));
  const canonical = buildApiEndpoint();
  if (!endpoint || !isHttpsEndpoint(canonical) || endpoint !== canonical) return accountKey;
  const legacy = configuredLegacyApiEndpoint();
  return legacy ? `${legacy}:${accountKey.slice(separator + 1)}` : accountKey;
}

function validWorkspaceIdentity(value: unknown): WorkspaceIdentity | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<WorkspaceIdentity>;
  if (typeof candidate.endpoint !== "string" || typeof candidate.userID !== "string" || typeof candidate.identifier !== "string") return null;
  const endpoint = canonicalizeEndpoint(candidate.endpoint);
  if (!endpoint || !candidate.userID.trim() || !candidate.identifier.trim()) return null;
  return { endpoint, userID: candidate.userID.toLowerCase(), identifier: candidate.identifier };
}

function readWorkspaceIdentities(): Map<string, WorkspaceIdentity> {
  const identities = new Map<string, WorkspaceIdentity>();
  let migrated = false;
  try {
    const raw = JSON.parse(localStorage.getItem(WORKSPACES_KEY) ?? "null") as unknown;
    if (Array.isArray(raw)) {
      raw.forEach((value) => {
        const identity = validWorkspaceIdentity(value);
        if (identity) {
          const source = value as Partial<WorkspaceIdentity>;
          if (typeof source.endpoint === "string" && normalizeEndpoint(source.endpoint) !== identity.endpoint) migrated = true;
          identities.set(workspaceIdentityKey(identity), identity);
        }
      });
    }
  } catch {
    // A malformed preference must not prevent the local notebook from opening.
  }
  const legacy = readWorkspaceIdentity();
  if (legacy) identities.set(workspaceIdentityKey(legacy), legacy);
  if (migrated) {
    try { persistWorkspaceIdentities(identities); } catch { /* Keep the in-memory migration if storage is unavailable. */ }
  }
  return identities;
}

function persistWorkspaceIdentities(identities: Map<string, WorkspaceIdentity>): void {
  localStorage.setItem(WORKSPACES_KEY, JSON.stringify([...identities.values()]));
  localStorage.removeItem(WORKSPACE_KEY);
}

export class AuthSession {
  private current: StoredSession | null;
  /**
   * Remember account namespaces for recovery after reauthentication.
   */
  private identity: WorkspaceIdentity | null;
  private readonly identities: Map<string, WorkspaceIdentity>;

  constructor() {
    this.current = readSession();
    this.identities = readWorkspaceIdentities();
    const activeKey = localStorage.getItem(ACTIVE_WORKSPACE_KEY);
    const legacy = !localStorage.getItem(WORKSPACES_KEY) ? readWorkspaceIdentity() : null;
    const activeIdentity = activeKey ? this.identities.get(activeKey) ?? this.identities.get(canonicalWorkspaceKey(activeKey)) ?? null : null;
    this.identity = activeIdentity ?? legacy;
    if (activeIdentity && activeKey !== workspaceIdentityKey(activeIdentity)) localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceIdentityKey(activeIdentity));
    if (this.current && (this.current.endpoint !== getEndpoint() || isExpired(this.current.expiresAt))) {
      this.current = null;
      sessionStorage.removeItem(SESSION_KEY);
    }
    if (this.current) {
      this.identity = this.remember({ endpoint: this.current.endpoint, userID: this.current.user.id, identifier: this.current.user.identifier });
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceIdentityKey(this.identity));
    } else if (legacy) {
      this.identity = this.remember(legacy);
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceIdentityKey(this.identity));
    }
  }

  get session(): AuthResponse | null { return this.activeSession(); }
  get user(): User | null { return this.activeSession()?.user ?? null; }
  get workspaceKey(): string | null {
    const session = this.activeSession();
    return session ? workspaceAccountKey(session.endpoint, session.user.id) : this.identity ? workspaceAccountKey(this.identity.endpoint, this.identity.userID) : null;
  }
  get workspaceIdentifier(): string | null { return this.activeSession()?.user.identifier ?? this.identity?.identifier ?? null; }
  get boundEndpoint(): string | null { return this.activeSession()?.endpoint ?? this.identity?.endpoint ?? null; }
  /** Account namespaces remain available for an explicit recovery/export UI. */
  get savedWorkspaces(): readonly WorkspaceIdentity[] { return [...this.identities.values()]; }

  private activeSession(): StoredSession | null {
    if (!this.current) return null;
    if (this.current.endpoint !== getEndpoint() || isExpired(this.current.expiresAt)) {
      this.current = null;
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return this.current;
  }

  set(response: AuthResponse | null): void {
    this.current = null;
    if (response) {
      const endpoint = getEndpoint();
      const stored: StoredSession = { ...response, endpoint };
      const identity: WorkspaceIdentity = { endpoint, userID: response.user.id.toLowerCase(), identifier: response.user.identifier };
      this.current = stored;
      this.identity = this.remember(identity);
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceIdentityKey(identity));
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(stored));
    } else {
      sessionStorage.removeItem(SESSION_KEY);
      // Preserve account databases and outboxes for the next authenticated login.
      localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
      localStorage.removeItem(WORKSPACE_KEY);
      this.identity = null;
      this.current = null;
    }
  }

  clear(): void { this.set(null); }

  private remember(identity: WorkspaceIdentity): WorkspaceIdentity {
    const normalized = { ...identity, endpoint: canonicalizeEndpoint(identity.endpoint), userID: identity.userID.toLowerCase() };
    if (!normalized.endpoint) return identity;
    this.identities.set(workspaceIdentityKey(normalized), normalized);
    persistWorkspaceIdentities(this.identities);
    return normalized;
  }
}

export function getEndpoint(): string {
  const stored = localStorage.getItem(ENDPOINT_KEY);
  const normalized = normalizeEndpoint(stored ?? (typeof import.meta.env.VITE_API_URL === "string" ? import.meta.env.VITE_API_URL : ""));
  const endpoint = canonicalizeEndpoint(normalized);
  if (stored !== null && endpoint !== normalized) localStorage.setItem(ENDPOINT_KEY, endpoint);
  return endpoint;
}

export function setEndpoint(endpoint: string): string {
  const normalized = canonicalizeEndpoint(endpoint);
  // Keeping an explicit empty override prevents a token from being sent to a
  // build default after the user intentionally clears Settings.
  localStorage.setItem(ENDPOINT_KEY, normalized);
  return normalized;
}

export class AuthClient {
  async register(identifier: string, password: string): Promise<AuthResponse> {
    return this.request("/v1/auth/register", { identifier, password });
  }

  async login(identifier: string, password: string): Promise<AuthResponse> {
    return this.request("/v1/auth/login", { identifier, password });
  }

  async logout(token: string, boundEndpoint = getEndpoint()): Promise<void> {
    const endpoint = getEndpoint();
    if (!endpoint || endpoint !== boundEndpoint) return;
    await fetchWithTimeout(`${endpoint}/v1/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
  }

  private async request(path: string, body: Record<string, string>): Promise<AuthResponse> {
    const endpoint = getEndpoint();
    if (!endpoint) throw new Error("Add your HTTPS server URL in Settings before signing in.");
    const response = await fetchWithTimeout(`${endpoint}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await parseJSON(response);
    if (!response.ok) throw new Error(readError(payload, "Sign-in failed."));
    const rawUser = payload.user;
    if (!payload || typeof payload.sessionToken !== "string" || !rawUser || typeof rawUser !== "object" || typeof (rawUser as { id?: unknown }).id !== "string" || typeof (rawUser as { identifier?: unknown }).identifier !== "string" || typeof payload.expiresAt !== "string" || isExpired(payload.expiresAt)) {
      throw new Error("The server returned an invalid login response.");
    }
    return { user: { id: (rawUser as { id: string }).id.toLowerCase(), identifier: (rawUser as { identifier: string }).identifier }, sessionToken: payload.sessionToken, expiresAt: payload.expiresAt };
  }
}

export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("The request timed out. Your notes are still safe offline.");
    throw new Error("Network unavailable. Your notes are still safe offline.");
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function parseJSON(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function readError(payload: Record<string, unknown>, fallback: string): string {
  const error = payload.error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  return fallback;
}

function readSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.sessionToken !== "string" || !parsed.user || typeof parsed.expiresAt !== "string" || typeof parsed.endpoint !== "string") return null;
    if (typeof parsed.user.id !== "string" || typeof parsed.user.identifier !== "string") return null;
    const endpoint = normalizeEndpoint(parsed.endpoint);
    if (!endpoint) return null;
    return { user: { id: parsed.user.id.toLowerCase(), identifier: parsed.user.identifier }, sessionToken: parsed.sessionToken, expiresAt: parsed.expiresAt, endpoint };
  } catch {
    return null;
  }
}

function readWorkspaceIdentity(): WorkspaceIdentity | null {
  try {
    const value = JSON.parse(localStorage.getItem(WORKSPACE_KEY) ?? "null") as Partial<WorkspaceIdentity> | null;
    if (!value || typeof value.endpoint !== "string" || typeof value.userID !== "string" || typeof value.identifier !== "string") return null;
    const endpoint = value.endpoint.trim() ? canonicalizeEndpoint(value.endpoint) : "";
    if (value.endpoint.trim() && !endpoint) return null;
    return { endpoint, userID: value.userID.toLowerCase(), identifier: value.identifier };
  } catch {
    return null;
  }
}

export function workspaceAccountKey(endpoint: string, userID: string): string {
  return `${canonicalizeEndpoint(endpoint)}:${userID.toLowerCase()}`;
}

function isExpired(value: string): boolean {
  const timestamp = Date.parse(value);
  return !Number.isFinite(timestamp) || timestamp <= Date.now();
}

function canonicalWorkspaceKey(value: string): string {
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) return value;
  return workspaceAccountKey(value.slice(0, separator), value.slice(separator + 1));
}

export function canonicalizeEndpoint(value: string): string {
  const normalized = normalizeEndpoint(value);
  if (!normalized) return "";
  const canonical = buildApiEndpoint();
  return isHttpsEndpoint(canonical) && configuredLegacyApiEndpoint() === normalized ? canonical : normalized;
}

function buildApiEndpoint(): string {
  return typeof import.meta.env.VITE_API_URL === "string" ? normalizeEndpoint(import.meta.env.VITE_API_URL) : "";
}

function configuredLegacyApiEndpoint(): string {
  const configured = typeof import.meta.env.VITE_LEGACY_API_URL === "string" ? import.meta.env.VITE_LEGACY_API_URL : "";
  const normalized = normalizeEndpoint(configured);
  return normalized === normalizeEndpoint(LEGACY_API_URL) ? normalized : "";
}

function isHttpsEndpoint(value: string): boolean {
  try { return new URL(value).protocol === "https:"; }
  catch { return false; }
}

function normalizeEndpoint(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return "";
    if (url.username || url.password) return "";
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}
