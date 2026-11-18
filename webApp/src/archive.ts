import type { Archive } from "./storage";
import { id, isUUID } from "./models";

export type ArchiveImport = Archive | { parts: Archive[]; importID?: string };

export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const MAX_ARCHIVE_NOTEBOOKS = 1_000;
export const MAX_ARCHIVE_PAGES = 10_000;
const MAX_LEGACY_BYTES = 256 * 1024 * 1024;
const HEADER_LIMIT = 64 * 1024;
const MAGIC = "NotePad backup 2\n";
const utf8 = new TextEncoder();

function splitArchive(archive: Archive): Archive[] {
  if (archive?.version !== 1 || !Array.isArray(archive.notebooks) || !Array.isArray(archive.pages) ||
      (archive.versions != null && !Array.isArray(archive.versions))) {
    throw new Error("Unsupported NotePad backup.");
  }
  const emptyPart = (): Archive => ({ version: 1, exportedAt: archive.exportedAt, account: archive.account, notebooks: [], pages: [], versions: [] });
  let part = emptyPart();
  const overhead = utf8.encode(JSON.stringify(part)).byteLength;
  let bytes = overhead;
  const parts: Archive[] = [part];
  function append<K extends "notebooks" | "pages" | "versions">(field: K, entries: NonNullable<Archive[K]>, limit: number): void {
    for (const entry of entries) {
      const entryBytes = utf8.encode(JSON.stringify(entry)).byteLength;
      if (entryBytes + overhead > MAX_ARCHIVE_BYTES) throw new Error("A single backup item exceeds 50 MiB.");
      if (bytes + entryBytes + (part[field]!.length ? 1 : 0) > MAX_ARCHIVE_BYTES || part[field]!.length >= limit) {
        part = emptyPart();
        parts.push(part);
        bytes = overhead;
      }
      const section = part[field]! as Array<NonNullable<Archive[K]>[number]>;
      bytes += entryBytes + (section.length ? 1 : 0);
      section.push(entry);
    }
  }
  append("notebooks", archive.notebooks, MAX_ARCHIVE_NOTEBOOKS);
  append("pages", archive.pages, MAX_ARCHIVE_PAGES);
  append("versions", archive.versions ?? [], MAX_ARCHIVE_PAGES);
  return parts;
}

export function makeBackupFile(archive: Archive, filename: string): File {
  const parts = splitArchive(archive).map(part => new Blob([JSON.stringify(part)]));
  if (parts.length === 1) return new File(parts, `${filename}.notepad.json`, { type: "application/json" });
  // Byte offsets allow a reader to load one bounded JSON part at a time, while
  // keeping export as a single download for browsers that block multiple files.
  const header = `${MAGIC}${JSON.stringify({ id: id(), sizes: parts.map(part => part.size) })}\n`;
  if (header.length > HEADER_LIMIT) throw new Error("This library needs smaller backups. Export its notebooks individually.");
  return new File([header, ...parts], `${filename}.notepad`, { type: "application/octet-stream" });
}

export async function readBackupFile(file: Blob): Promise<ArchiveImport> {
  const prefix = await file.slice(0, MAGIC.length).text();
  if (prefix !== MAGIC) {
    if (file.size > MAX_LEGACY_BYTES) throw new Error("This older JSON backup exceeds 256 MiB. Export the notebooks separately from the original workspace.");
    const archive: Archive = JSON.parse(await file.text());
    const needsParts = file.size > MAX_ARCHIVE_BYTES || (archive?.notebooks?.length ?? 0) > MAX_ARCHIVE_NOTEBOOKS ||
      (archive?.pages?.length ?? 0) > MAX_ARCHIVE_PAGES || (archive?.versions?.length ?? 0) > MAX_ARCHIVE_PAGES;
    return needsParts ? { parts: splitArchive(archive) } : archive;
  }
  const header = await file.slice(0, HEADER_LIMIT).text();
  const end = header.indexOf("\n", MAGIC.length);
  if (end < 0) throw new Error("The backup header is incomplete.");
  const manifest = JSON.parse(header.slice(MAGIC.length, end)) as { id?: unknown; sizes?: unknown } | null;
  const sizes = manifest?.sizes;
  // The header uses ASCII. Reject any file that omits, adds or truncates a part.
  const offset = utf8.encode(header.slice(0, end + 1)).byteLength;
  if (!isUUID(manifest?.id) || !Array.isArray(sizes) || sizes.length < 2 || sizes.some(size => !Number.isSafeInteger(size) || size <= 0 || size > MAX_ARCHIVE_BYTES) ||
      sizes.reduce((total, size) => total + size, offset) !== file.size) {
    throw new Error("This backup is incomplete or damaged. Try another export.");
  }
  const parts: Archive[] = [];
  let cursor = offset;
  for (const size of sizes) {
    parts.push(JSON.parse(await file.slice(cursor, cursor + size).text()));
    cursor += size;
  }
  return { parts, importID: manifest.id };
}
