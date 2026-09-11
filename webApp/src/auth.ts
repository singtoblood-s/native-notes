import { AuthResponse, User } from "./models";

const SESSION_KEY = "notepad.session";
const ENDPOINT_KEY = "notepad.endpoint";
const WORKSPACE_KEY = "notepad.workspace";

interface StoredSession extends AuthResponse {
  endpoint: string;
}

interface WorkspaceIdentity {
  endpoint: string;
  userID: string;
  identifier: string;
}

export class AuthSession {
  private current: StoredSession | null;
  /**
   * The identity survives an expired browser session so its local database can
   * still be opened offline. Explicit sign-out clears it below.
   */
  private identity: WorkspaceIdentity | null;

  constructor() {
    this.current = readSession();
    this.identity = readWorkspaceIdentity();
    if (this.current && (this.current.endpoint !== getEndpoint() || isExpired(this.current.expiresAt))) this.current = null;
  }

  get session(): AuthResponse | null { return this.activeSession(); }
  get user(): User | null { return this.activeSession()?.user ?? null; }
  get workspaceKey(): string {
    const session = this.activeSession();
    return session ? workspaceKey(session.endpoint, session.user.id) : this.identity ? workspaceKey(this.identity.endpoint, this.identity.userID) : "guest";
  }
  get workspaceIdentifier(): string | null { return this.activeSession()?.user.identifier ?? this.identity?.identifier ?? null; }
  get boundEndpoint(): string | null { return this.activeSession()?.endpoint ?? this.identity?.endpoint ?? null; }

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
      this.identity = identity;
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(stored));
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify(identity));
    } else {
      sessionStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(WORKSPACE_KEY);
      this.identity = null;
    }
  }

  clear(): void { this.set(null); }
}

export function getEndpoint(): string {
  const raw = localStorage.getItem(ENDPOINT_KEY) ?? import.meta.env.VITE_API_URL ?? "";
  return normalizeEndpoint(raw);
}

export function setEndpoint(endpoint: string): string {
  const normalized = normalizeEndpoint(endpoint);
  // An explicit blank disables the build-time endpoint for private guest mode.
  // Keeping the empty override also prevents a token from being sent to a
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
    const endpoint = normalizeEndpoint(value.endpoint);
    if (value.endpoint.trim() && !endpoint) return null;
    return { endpoint, userID: value.userID.toLowerCase(), identifier: value.identifier };
  } catch {
    return null;
  }
}

function workspaceKey(endpoint: string, userID: string): string {
  return `${endpoint}:${userID.toLowerCase()}`;
}

function isExpired(value: string): boolean {
  const timestamp = Date.parse(value);
  return !Number.isFinite(timestamp) || timestamp <= Date.now();
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
