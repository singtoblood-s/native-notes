import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ opened: vi.fn(), start: vi.fn(), stop: vi.fn(), status: null as null | ((status: unknown) => void) }));
vi.mock("../src/coordinator", () => ({ SyncCoordinator: class {
  constructor(options: { onStatus: (status: unknown) => void }) { state.status = options.onStatus; }
  start() { state.start(); } stop() { state.stop(); } notifyAuthChanged() {} notifyLocalWrite() {}
} }));
vi.mock("../src/storage", () => ({ SQLiteNoteStore: { open: async (accountKey: string) => {
  state.opened(accountKey);
  return { accountKey, listNotebooks: async () => [], listPages: async () => [], close: vi.fn() };
} } }));
vi.mock("../src/canvas", () => ({ PaperCanvas: class { setTool() {} destroy() {} } }));

it("requires authentication before opening data, blocks dismissal, and locks again on logout and rejected sessions", async () => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("notepad.endpoint", "https://sync.example.test");
  localStorage.setItem("notepad.workspace", JSON.stringify({ endpoint: "https://sync.example.test", userID: "old", identifier: "old" }));
  vi.spyOn(window, "setInterval").mockReturnValue(1 as unknown as ReturnType<typeof window.setInterval>);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
  let rejectLogin = true;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("logout")) return new Response(null, { status: 204 });
    if (rejectLogin) return new Response(JSON.stringify({ error: { message: "Invalid credentials" } }), { status: 401 });
    return new Response(JSON.stringify({ user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", identifier: "tester" }, sessionToken: "token", expiresAt: "2099-01-01T00:00:00Z" }));
  });
  vi.stubGlobal("fetch", fetchMock);
  document.body.innerHTML = '<div id="app"></div>';
  const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const submit = () => {
    element<HTMLInputElement>("auth-identifier").value = "tester";
    element<HTMLInputElement>("auth-password").value = "a-long-test-password";
    element("auth-form").dispatchEvent(new Event("submit", { cancelable: true }));
  };
  try {
    await import("../src/main");
    expect(element<HTMLDialogElement>("auth-dialog").open).toBe(true);
    expect(element("library")).toBeNull();
    expect(state.opened).not.toHaveBeenCalled();
    expect(element("cancel-auth")).toBeNull();
    const cancel = new Event("cancel", { cancelable: true });
    element("auth-dialog").dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    submit();
    await vi.waitFor(() => expect(element("auth-error").textContent).toBe("Invalid credentials"));
    expect(state.opened).not.toHaveBeenCalled();
    rejectLogin = false;
    submit();
    await vi.waitFor(() => expect(state.start).toHaveBeenCalled());
    expect(element("library").hidden).toBe(false);
    expect(state.opened).toHaveBeenCalledTimes(1);
    expect(state.opened).toHaveBeenCalledWith("https://sync.example.test:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    element("logout-button").click();
    await vi.waitFor(() => expect(element<HTMLDialogElement>("auth-dialog").open).toBe(true));
    expect(sessionStorage.getItem("notepad.session")).toBeNull();
    expect(state.opened).not.toHaveBeenCalledWith("guest");
    submit();
    await vi.waitFor(() => expect(state.start).toHaveBeenCalledTimes(2));
    state.status!({ state: "needs-login" });
    expect(element<HTMLDialogElement>("auth-dialog").open).toBe(true);
    expect(sessionStorage.getItem("notepad.session")).toBeNull();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    localStorage.clear();
    sessionStorage.clear();
  }
});
