import { afterEach, expect, it, vi } from "vitest";
import { removeGuestData } from "../src/remove-guest-data";

vi.mock("../src/storage", () => ({ accountNamespace: vi.fn(async (key: string) => {
  expect(key).toBe("guest");
  return "guest-hash";
}) }));

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it("removes only guest snapshots, files and preferences under the guest lock", async () => {
  const snapshots = new Map([ ["guest-hash", "old notes"], ["account-hash", "account notes"] ]);
  const files = new Set(["guest-hash.sqlite3", "guest-hash.sqlite3-wal", "account-hash.sqlite3"]);
  const removeEntry = vi.fn(async (name: string) => {
    if (!files.delete(name)) throw new DOMException("Missing file", "NotFoundError");
  });
  const close = vi.fn();
  const transaction = { oncomplete: null as null | (() => void), objectStore: () => ({ delete: (key: string) => {
    snapshots.delete(key);
    queueMicrotask(() => transaction.oncomplete?.());
  } }) };
  vi.stubGlobal("indexedDB", { open: vi.fn(() => {
    const request = { onsuccess: null as null | (() => void), result: { transaction: () => transaction, close } };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  }) });
  const requestLock = vi.fn(async (_name, _options, callback) => callback({}));
  vi.stubGlobal("navigator", { locks: { request: requestLock }, storage: { getDirectory: async () => ({ getDirectoryHandle: async (name: string) => {
    expect(name).toBe("notepad");
    return { removeEntry };
  } }) } });
  localStorage.setItem("notepad.selection:guest", "old");
  localStorage.setItem("notepad.favorites:guest", "old");
  localStorage.setItem("notepad.selection:account", "keep");
  await removeGuestData();
  expect(requestLock).toHaveBeenCalledWith("inknote:guest-hash", { mode: "exclusive", ifAvailable: true }, expect.any(Function));
  expect([...snapshots.keys()]).toEqual(["account-hash"]);
  expect([...files]).toEqual(["account-hash.sqlite3"]);
  expect(close).toHaveBeenCalledOnce();
  expect(localStorage.getItem("notepad.selection:guest")).toBeNull();
  expect(localStorage.getItem("notepad.favorites:guest")).toBeNull();
  expect(localStorage.getItem("notepad.selection:account")).toBe("keep");
});

it("does not delete anything while an older tab owns the guest database", async () => {
  const open = vi.fn();
  vi.stubGlobal("indexedDB", { open });
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, _options: unknown, callback: (lock: null) => Promise<void>) => callback(null) } });
  await expect(removeGuestData()).rejects.toThrow("Close other NotePad tabs");
  expect(open).not.toHaveBeenCalled();
});
