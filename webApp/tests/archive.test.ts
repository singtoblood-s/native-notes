// @vitest-environment node
import { expect, it } from "vitest";
import { makeBackupFile, MAX_ARCHIVE_NOTEBOOKS, readBackupFile } from "../src/archive";
import { createNotebook } from "../src/models";
import type { Archive } from "../src/storage";

it("packages all parts in one file and rejects interrupted downloads", async () => {
  const archive: Archive = {
    version: 1, exportedAt: new Date().toISOString(), account: "บัญชีทดสอบ",
    notebooks: Array.from({ length: MAX_ARCHIVE_NOTEBOOKS + 1 }, (_, index) => createNotebook(`สมุด ${index + 1}`)),
    pages: [], versions: [],
  };
  const file = makeBackupFile(archive, "notepad-test");
  expect(file.name).toBe("notepad-test.notepad");
  const decoded = await readBackupFile(file);
  if (!("parts" in decoded)) throw new Error("Expected a split backup");
  expect(decoded.importID).toBeTruthy();
  expect(decoded.parts.map(part => part.notebooks.length)).toEqual([MAX_ARCHIVE_NOTEBOOKS, 1]);
  expect(decoded.parts.flatMap(part => part.notebooks)).toEqual(archive.notebooks);
  await expect(readBackupFile(file.slice(0, file.size - 1))).rejects.toThrow("incomplete or damaged");

  archive.notebooks.splice(1);
  const legacy = makeBackupFile(archive, "notepad-test");
  expect(legacy.name).toBe("notepad-test.notepad.json");
  await expect(readBackupFile(legacy)).resolves.toEqual(archive);
});
