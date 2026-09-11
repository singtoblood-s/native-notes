import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthSession, getEndpoint, setEndpoint } from "../src/auth";

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
    expect(restored.workspaceKey).toBe("guest");
    expect(restored.workspaceIdentifier).toBeNull();
    expect(restored.boundEndpoint).toBeNull();
    expect(localStorage.getItem("notepad.workspace")).toBeNull();
  });
});
