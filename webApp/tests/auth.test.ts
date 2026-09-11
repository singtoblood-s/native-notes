import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSession, LEGACY_API_URL, getEndpoint, resolveStorageAccountKey, setEndpoint, workspaceAccountKey } from "../src/auth";

const response = (id: string, identifier = `${id}@example.test`) => ({
  user: { id, identifier },
  sessionToken: `token-${id}`,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
});

describe("account-bound browser sessions", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setEndpoint("");
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllEnvs();
  });

  it("normalizes HTTPS server paths and rejects remote HTTP", () => {
    expect(setEndpoint("https://sync.example.test/notepad///")).toBe("https://sync.example.test/notepad");
    expect(getEndpoint()).toBe("https://sync.example.test/notepad");
    expect(setEndpoint("http://sync.example.test")).toBe("");
    expect(getEndpoint()).toBe("");
    expect(setEndpoint("http://localhost:8787/notes/")).toBe("http://localhost:8787/notes");
  });

  it("updates the in-memory identity when a different account signs in", () => {
    setEndpoint("https://one.example.test");
    const session = new AuthSession();
    session.set(response("FIRST"));
    expect(session.workspaceKey).toBe("https://one.example.test:first");

    setEndpoint("https://two.example.test/api");
    session.set(response("SECOND"));
    expect(session.workspaceKey).toBe("https://two.example.test/api:second");
    expect(session.workspaceIdentifier).toBe("SECOND@example.test");
    expect(session.boundEndpoint).toBe("https://two.example.test/api");
  });

  it("invalidates a token immediately when the endpoint changes", () => {
    setEndpoint("https://one.example.test");
    const session = new AuthSession();
    session.set(response("FIRST"));
    expect(session.session?.sessionToken).toBe("token-FIRST");

    setEndpoint("https://two.example.test");
    expect(session.session).toBeNull();
    // Keep the old workspace selected in memory until the UI deliberately
    // locks the editor; it must never be sent to the new server.
    expect(session.workspaceKey).toBe("https://one.example.test:first");
  });

  it("retains every endpoint/account namespace after an explicit sign-out", () => {
    setEndpoint("https://one.example.test");
    const session = new AuthSession();
    session.set(response("FIRST"));
    setEndpoint("https://two.example.test");
    session.set(response("SECOND"));

    session.clear();
    expect(session.workspaceKey).toBeNull();
    expect(session.savedWorkspaces.map((item) => `${item.endpoint}:${item.userID}`)).toEqual([
      "https://one.example.test:first",
      "https://two.example.test:second",
    ]);
    expect(localStorage.getItem("notepad.workspaces")).toContain("first");
    expect(localStorage.getItem("notepad.workspaces")).toContain("second");
  });

  it("keeps an expired account workspace offline until explicit sign-out", () => {
    setEndpoint("https://sync.example.test");
    const session = new AuthSession();
    session.set(response("ACCOUNT"));
    sessionStorage.clear();

    const restored = new AuthSession();
    expect(restored.session).toBeNull();
    expect(restored.workspaceKey).toBe("https://sync.example.test:account");
    expect(restored.workspaceIdentifier).toBe("ACCOUNT@example.test");
    expect(restored.boundEndpoint).toBe("https://sync.example.test");

    restored.clear();
    expect(restored.workspaceKey).toBeNull();
    expect(restored.workspaceIdentifier).toBeNull();
    expect(restored.boundEndpoint).toBeNull();
    expect(localStorage.getItem("notepad.workspace")).toBeNull();
  });

  it("migrates a persisted legacy endpoint when the build has a valid canonical HTTPS endpoint", () => {
    vi.stubEnv("VITE_API_URL", "https://d1.example.test/api/");
    vi.stubEnv("VITE_LEGACY_API_URL", LEGACY_API_URL);
    localStorage.setItem("notepad.endpoint", `${LEGACY_API_URL}/`);

    expect(getEndpoint()).toBe("https://d1.example.test/api");
    expect(localStorage.getItem("notepad.endpoint")).toBe("https://d1.example.test/api");
  });

  it("keeps a legacy account workspace offline under the canonical key and drops its old token", () => {
    vi.stubEnv("VITE_API_URL", "https://d1.example.test");
    vi.stubEnv("VITE_LEGACY_API_URL", LEGACY_API_URL);
    const userID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    localStorage.setItem("notepad.endpoint", LEGACY_API_URL);
    localStorage.setItem("notepad.workspaces", JSON.stringify([{ endpoint: LEGACY_API_URL, userID, identifier: "old@example.test" }]));
    localStorage.setItem("notepad.active-workspace", `${LEGACY_API_URL}:${userID}`);
    sessionStorage.setItem("notepad.session", JSON.stringify({ ...response(userID), endpoint: LEGACY_API_URL }));

    const restored = new AuthSession();

    expect(restored.session).toBeNull();
    expect(restored.workspaceKey).toBe(`https://d1.example.test:${userID}`);
    expect(restored.boundEndpoint).toBe("https://d1.example.test");
    expect(sessionStorage.getItem("notepad.session")).toBeNull();
    expect(localStorage.getItem("notepad.endpoint")).toBe("https://d1.example.test");
    expect(localStorage.getItem("notepad.active-workspace")).toBe(`https://d1.example.test:${userID}`);
    expect(restored.savedWorkspaces[0]).toMatchObject({ endpoint: "https://d1.example.test", userID });
  });

  it("maps only the canonical account namespace to the known legacy endpoint", () => {
    vi.stubEnv("VITE_API_URL", "https://d1.example.test");
    vi.stubEnv("VITE_LEGACY_API_URL", LEGACY_API_URL);
    const userID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    expect(resolveStorageAccountKey(workspaceAccountKey("https://d1.example.test", userID))).toBe(`${LEGACY_API_URL}:${userID}`);
    expect(resolveStorageAccountKey(workspaceAccountKey("https://other.example.test", userID))).toBe(`https://other.example.test:${userID}`);
  });

  it("does not alias the legacy namespace without the explicit migration flag", () => {
    vi.stubEnv("VITE_API_URL", "https://d1.example.test");
    vi.stubEnv("VITE_LEGACY_API_URL", "");
    const userID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    localStorage.removeItem("notepad.endpoint");
    expect(getEndpoint()).toBe("https://d1.example.test");
    expect(resolveStorageAccountKey(workspaceAccountKey("https://d1.example.test", userID))).toBe(`https://d1.example.test:${userID}`);
    expect(setEndpoint(LEGACY_API_URL)).toBe(LEGACY_API_URL);
  });

  it("rejects an arbitrary legacy value even when the migration flag is present", () => {
    vi.stubEnv("VITE_API_URL", "https://d1.example.test");
    vi.stubEnv("VITE_LEGACY_API_URL", "https://old.example.test");
    const userID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    expect(resolveStorageAccountKey(workspaceAccountKey("https://d1.example.test", userID))).toBe(`https://d1.example.test:${userID}`);
    expect(setEndpoint(LEGACY_API_URL)).toBe(LEGACY_API_URL);
  });
});
