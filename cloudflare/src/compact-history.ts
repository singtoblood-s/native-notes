import { MIN_BYTES, packSnapshot, unpackSnapshot } from "./snapshot-codec";

export interface CompactionCursor {
  sequence: number;
  chunkRowId: number;
}

const KEY_WINDOW = 48;
const MAX_CANDIDATES = 4;
const BYTES_PER_TABLE = 3 * 1024 * 1024;
const utf8 = new TextEncoder();

interface Candidate {
  key: number;
  bytes: number;
  eligible: number;
}

type Savings = { rowsPacked: number; bytesSaved: number };

async function compactWindow(
  keys: Candidate[], after: number,
  compact: (key: number) => Promise<Savings>,
) {
  let last = after, attempted = 0, inputBytes = 0, rowsPacked = 0, bytesSaved = 0;
  for (const row of keys.slice(0, KEY_WINDOW)) {
    if (row.eligible === 1 && row.bytes >= MIN_BYTES && row.bytes <= BYTES_PER_TABLE) {
      if (attempted >= MAX_CANDIDATES || inputBytes + row.bytes > BYTES_PER_TABLE) break;
      attempted++;
      inputBytes += row.bytes;
      const saving = await compact(row.key);
      rowsPacked += saving.rowsPacked;
      bytesSaved += saving.bytesSaved;
    }
    last = row.key;
  }
  return { last, finished: keys.length === 0 || last === keys.at(-1)!.key, rowsPacked, bytesSaved };
}

async function verifiedPacking(raw: string) {
  const packed = await packSnapshot(raw);
  if (packed === raw) return null;
  const rawBytes = utf8.encode(raw).byteLength;
  if (await unpackSnapshot(packed, rawBytes) !== raw) throw new Error("Snapshot compression verification failed");
  // The packed representation is ASCII.
  return { packed, saved: rawBytes - packed.length };
}

async function compactChange(db: D1Database, userId: string, sequence: number): Promise<Savings> {
  const row = await db.prepare(
    "SELECT entity_type, entity_id, revision, payload FROM changes WHERE user_id = ? AND sequence = ? AND typeof(payload) = 'text' AND substr(payload, 1, 1) = '{'",
  ).bind(userId, sequence).first<{ entity_type: string; entity_id: string; revision: number; payload: string }>();
  const value = row && await verifiedPacking(row.payload);
  if (!row || !value) return { rowsPacked: 0, bytesSaved: 0 };
  const results = await db.batch([
    db.prepare("UPDATE changes SET payload = ? WHERE user_id = ? AND sequence = ? AND payload = ?")
      .bind(value.packed, userId, sequence, row.payload),
    db.prepare("UPDATE documents SET payload = ? WHERE user_id = ? AND entity_type = ? AND entity_id = ? AND revision = ? AND payload = ?")
      .bind(value.packed, userId, row.entity_type, row.entity_id, row.revision, row.payload),
  ]);
  const rowsPacked = results.reduce((count, result) => count + result.meta.changes, 0);
  return { rowsPacked, bytesSaved: rowsPacked * value.saved };
}

async function compactChunk(db: D1Database, userId: string, rowId: number): Promise<Savings> {
  const row = await db.prepare(
    "SELECT payload FROM payload_chunks WHERE user_id = ? AND rowid = ? AND typeof(payload) = 'text'",
  ).bind(userId, rowId).first<{ payload: string }>();
  const value = row && await verifiedPacking(row.payload);
  if (!row || !value) return { rowsPacked: 0, bytesSaved: 0 };
  // A legacy plain-text chunk can begin with any characters, including "@gzip:".
  // SQLite's BLOB storage class distinguishes compressed data unambiguously.
  const result = await db.prepare(
    "UPDATE payload_chunks SET payload = CAST(? AS BLOB) WHERE user_id = ? AND rowid = ? AND typeof(payload) = 'text' AND payload = ?",
  ).bind(value.packed, userId, rowId, row.payload).run();
  return { rowsPacked: result.meta.changes, bytesSaved: result.meta.changes * value.saved };
}

/** Losslessly reclaim space in one account. Persist the returned cursor for the next recovery attempt. */
export async function compactHistory(db: D1Database, userId: string, cursor: CompactionCursor = { sequence: 0, chunkRowId: 0 }) {
  const [changeKeys, chunkKeys] = await db.batch<Candidate>([
    db.prepare(`SELECT sequence AS key, length(CAST(payload AS BLOB)) AS bytes,
        (typeof(payload) = 'text' AND substr(payload, 1, 1) = '{') AS eligible
      FROM changes WHERE user_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`)
      .bind(userId, cursor.sequence, KEY_WINDOW + 1),
    // The chunk primary key is (user_id, payload_ref, chunk_index). Resolve the
    // last rowid to an index position; ORDER BY rowid would sort every chunk in
    // the account on every pass. A missing anchor safely restarts this scan.
    db.prepare(`SELECT rowid AS key, length(CAST(payload AS BLOB)) AS bytes, (typeof(payload) = 'text') AS eligible
      FROM payload_chunks WHERE user_id = ? AND (payload_ref, chunk_index) > (
        SELECT coalesce(max(payload_ref), ''), coalesce(max(chunk_index), -1)
        FROM payload_chunks WHERE user_id = ? AND rowid = ?
      ) ORDER BY payload_ref, chunk_index LIMIT ?`)
      .bind(userId, userId, cursor.chunkRowId, KEY_WINDOW + 1),
  ]);
  const changes = await compactWindow(changeKeys!.results, cursor.sequence, key => compactChange(db, userId, key));
  const chunks = await compactWindow(chunkKeys!.results, cursor.chunkRowId, key => compactChunk(db, userId, key));
  return {
    cursor: { sequence: changes.last, chunkRowId: chunks.last },
    finished: changes.finished && chunks.finished,
    rowsPacked: changes.rowsPacked + chunks.rowsPacked,
    bytesSaved: changes.bytesSaved + chunks.bytesSaved,
  };
}
