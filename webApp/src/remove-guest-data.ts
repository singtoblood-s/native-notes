import { accountNamespace } from "./storage";

/** Retire the old anonymous database without touching any account database. */
export async function removeGuestData(): Promise<void> {
  if (typeof indexedDB === "undefined" && !navigator.storage?.getDirectory) return;
  const namespace = await accountNamespace("guest");
  if (!navigator.locks) throw new Error("This browser cannot safely remove older device notes.");
  await navigator.locks.request(`inknote:${namespace}`, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error("Close other NotePad tabs, then reopen the app to remove older device notes.");
    if (typeof indexedDB !== "undefined") {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("notepad-sqlite-snapshots", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("databases");
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Close other NotePad tabs and try again."));
        request.onsuccess = () => {
          const db = request.result;
          try {
            const transaction = db.transaction("databases", "readwrite");
            transaction.oncomplete = () => { db.close(); resolve(); };
            transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error); };
            transaction.objectStore("databases").delete(namespace);
          } catch (error) { db.close(); reject(error); }
        };
      });
    }
    if (navigator.storage?.getDirectory) {
      let root: FileSystemDirectoryHandle | null = null;
      try {
        // OPFS can be present but unavailable in WebKit private/embedded
        // contexts. IndexedDB cleanup above is authoritative; this optional
        // cache cleanup must not block login when the root cannot be opened.
        root = await navigator.storage.getDirectory();
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") root = null;
      }
      if (root) try {
        const directory = await root.getDirectoryHandle("notepad");
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          try { await directory.removeEntry(`${namespace}.sqlite3${suffix}`); }
          catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error; }
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
      }
    }
    localStorage.removeItem("notepad.selection:guest");
    localStorage.removeItem("notepad.favorites:guest");
  });
}
