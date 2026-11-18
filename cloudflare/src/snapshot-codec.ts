const PREFIX = "@gzip:";
export const MIN_BYTES = 8192;
const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// The fixed-width original byte count lets sync/pull budget its uncompressed
// response without reading or inflating the entire revision history.
export const snapshotSizeSql = `CASE WHEN substr(payload, 1, 6) = '@gzip:' THEN CAST(substr(payload, 7, 8) AS INTEGER) ELSE length(CAST(payload AS BLOB)) END`;

export async function packSnapshot(raw: string): Promise<string> {
  if (raw.length < MIN_BYTES / 4) return raw;
  const bytes = utf8.encode(raw);
  if (bytes.length < MIN_BYTES) return raw;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  const packed = new Uint8Array(await new Response(stream).arrayBuffer());
  if (15 + 4 * Math.ceil(packed.length / 3) >= bytes.length * .9) return raw;
  let binary = "";
  for (let i = 0; i < packed.length; i += 8192) {
    binary += String.fromCharCode(...packed.subarray(i, i + 8192));
  }
  return PREFIX + String(bytes.length).padStart(8, "0") + ":" + btoa(binary);
}

export async function unpackSnapshot(stored: string, maxBytes: number): Promise<string> {
  if (!stored.startsWith(PREFIX)) return stored;
  const header = /^@gzip:(\d{8}):/.exec(stored);
  const size = Number(header?.[1]);
  if (!header || !size || size > maxBytes) throw new Error("Invalid snapshot size");
  const binary = atob(stored.slice(header[0].length));
  const gzip = Uint8Array.from(binary, char => char.charCodeAt(0));
  const reader = new Blob([gzip]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const output = new Uint8Array(size);
  let offset = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > size - offset) {
        await reader.cancel();
        throw new Error("Snapshot exceeds its stored size");
      }
      output.set(value, offset);
      offset += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  if (offset !== size) throw new Error("Incomplete snapshot");
  return decoder.decode(output);
}
