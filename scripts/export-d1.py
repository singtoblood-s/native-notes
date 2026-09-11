#!/usr/bin/env python3
"""Create a private, data-only SQLite-to-D1 migration bundle.

The source is opened read-only, copied with sqlite3.backup(), and exported
from that snapshot.  The SQL intentionally contains no schema or sessions;
the destination schema must be applied by the Worker migration first.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from typing import Iterator, Sequence


D1_MAX_STATEMENT_BYTES = 100_000
D1_MAX_ROW_BYTES = 2_000_000
ROW_SAFETY_MARGIN_BYTES = 4_096
DEFAULT_STATEMENT_BYTES = 32_000
BACKUP_NAME = "d1-backup.sqlite3"
SQL_NAME = "d1-data.sql"
MANIFEST_NAME = "d1-manifest.json"

# Keep this list in the same order as ServerDatabase.kt's foreign-key graph.
TABLE_COLUMNS: dict[str, tuple[str, ...]] = {
    "users": ("id", "identifier", "salt", "password_hash", "created_at"),
    "documents": (
        "user_id",
        "entity_type",
        "entity_id",
        "revision",
        "payload",
        "deleted",
        "updated_at",
    ),
    "changes": (
        "sequence",
        "user_id",
        "entity_type",
        "entity_id",
        "revision",
        "action",
        "payload",
    ),
    "sync_operations": (
        "user_id",
        "op_id",
        "request_hash",
        "status",
        "revision",
        "sequence",
        "server_payload",
        "code",
    ),
}

TABLE_ORDER = tuple(TABLE_COLUMNS)
ORDER_BY = {
    "users": ("id",),
    "documents": ("user_id", "entity_type", "entity_id"),
    "changes": ("sequence",),
    "sync_operations": ("user_id", "op_id"),
}
KEY_COLUMNS = {
    "users": ("id",),
    "documents": ("user_id", "entity_type", "entity_id"),
    "changes": ("sequence",),
    "sync_operations": ("user_id", "op_id"),
}
CHUNK_COLUMNS = {
    "documents": ("payload",),
    "changes": ("payload",),
    "sync_operations": ("server_payload",),
}
ALL_SCHEMA_COLUMNS = {
    **TABLE_COLUMNS,
    "sessions": ("token_hash", "user_id", "created_at", "expires_at", "revoked_at"),
}

SCHEMA_SQL = """
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE documents (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, entity_type, entity_id)
);
CREATE TABLE changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX changes_user_sequence ON changes(user_id, sequence);
CREATE TABLE sync_operations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  op_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER,
  sequence INTEGER,
  server_payload TEXT,
  code TEXT,
  PRIMARY KEY (user_id, op_id)
);
PRAGMA user_version = 1;
"""


class ExportError(RuntimeError):
    """A safe, user-actionable export failure without row contents."""


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def sql_literal(value: object) -> str:
    """Render one SQLite literal without using a shell or SQL parameters."""

    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise ExportError("non-finite numeric value cannot be exported")
        return repr(value)
    if isinstance(value, bytes):
        return "X'" + value.hex() + "'"
    if isinstance(value, str):
        if "\x00" in value:
            raise ExportError("a text value contains a NUL byte and cannot be exported safely")
        return "'" + value.replace("'", "''") + "'"
    raise ExportError(f"unsupported SQLite value type: {type(value).__name__}")


def statement_bytes(statement: str) -> int:
    return len(statement.encode("utf-8"))


def split_sql_statements(sql: str) -> Iterator[str]:
    """Split our SQL without treating semicolons inside text as terminators."""

    current: list[str] = []
    in_string = False
    index = 0
    while index < len(sql):
        char = sql[index]
        current.append(char)
        if in_string:
            if char == "'":
                if index + 1 < len(sql) and sql[index + 1] == "'":
                    current.append(sql[index + 1])
                    index += 1
                else:
                    in_string = False
        elif char == "'":
            in_string = True
        elif char == ";":
            statement = "".join(current).strip()
            if statement:
                yield statement
            current = []
        index += 1
    if in_string:
        raise ExportError("generated SQL contains an unterminated text literal")
    if "".join(current).strip():
        raise ExportError("generated SQL is missing a final semicolon")


def read_only_connection(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise ExportError(f"database file does not exist: {path}")
    uri = f"file:{path.resolve().as_posix()}?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True)
    except sqlite3.Error as error:
        raise ExportError(f"cannot open database read-only: {error}") from error
    connection.row_factory = sqlite3.Row
    return connection


def validate_schema(connection: sqlite3.Connection) -> int:
    """Reject unknown schema shapes rather than silently dropping columns."""

    for table, expected in ALL_SCHEMA_COLUMNS.items():
        rows = connection.execute(f"PRAGMA table_info({quote_identifier(table)})").fetchall()
        actual = tuple(row[1] for row in rows)
        if actual != expected:
            raise ExportError(
                f"unsupported {table} schema; expected ServerDatabase.kt v1 columns"
            )
    version = int(connection.execute("PRAGMA user_version").fetchone()[0])
    if version > 1:
        raise ExportError(f"database schema version {version} is newer than v1")
    integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise ExportError("SQLite integrity_check failed")
    connection.execute("PRAGMA foreign_keys = ON")
    foreign_key_errors = connection.execute("PRAGMA foreign_key_check").fetchall()
    if foreign_key_errors:
        raise ExportError("SQLite foreign-key check failed")
    return version


def estimated_row_bytes(row: sqlite3.Row) -> int:
    """Conservative stored-byte estimate for D1's 2,000,000-byte row limit."""

    total = 0
    for value in row:
        if isinstance(value, str):
            total += len(value.encode("utf-8"))
        elif isinstance(value, bytes):
            total += len(value)
        elif isinstance(value, (int, float)):
            total += 8
    return total


@dataclass
class ExportStats:
    rows: dict[str, int] = field(default_factory=lambda: {table: 0 for table in TABLE_ORDER})
    statements: int = 0
    chunk_update_statements: int = 0
    chunked_rows: int = 0
    max_statement_bytes: int = 0
    max_estimated_row_bytes: int = 0
    omitted_sessions: int = 0
    changes_max_sequence: int = 0

    def note_statement(self, statement: str, chunk_update: bool = False) -> None:
        size = statement_bytes(statement)
        self.statements += 1
        self.max_statement_bytes = max(self.max_statement_bytes, size)
        if chunk_update:
            self.chunk_update_statements += 1


def insert_statement(
    table: str, columns: Sequence[str], values: Sequence[object]
) -> str:
    names = ", ".join(quote_identifier(column) for column in columns)
    literals = ", ".join(sql_literal(value) for value in values)
    return f"INSERT INTO {quote_identifier(table)} ({names}) VALUES ({literals});"


def append_statement(
    table: str,
    column: str,
    chunk: str,
    row: sqlite3.Row,
) -> str:
    where = " AND ".join(
        f"{quote_identifier(key)} = {sql_literal(row[key])}" for key in KEY_COLUMNS[table]
    )
    return (
        f"UPDATE {quote_identifier(table)} SET {quote_identifier(column)} = "
        f"{quote_identifier(column)} || {sql_literal(chunk)} WHERE {where};"
    )


def split_text_for_update(
    value: str,
    make_statement,
    max_statement_bytes: int,
) -> Iterator[str]:
    """Split by code point while measuring escaped UTF-8 SQL bytes."""

    offset = 0
    while offset < len(value):
        low = offset + 1
        high = len(value)
        best = offset
        while low <= high:
            midpoint = (low + high) // 2
            candidate = make_statement(value[offset:midpoint])
            if statement_bytes(candidate) <= max_statement_bytes:
                best = midpoint
                low = midpoint + 1
            else:
                high = midpoint - 1
        if best == offset:
            raise ExportError("a text chunk cannot fit within the D1 statement budget")
        yield value[offset:best]
        offset = best


def row_statements(
    table: str,
    row: sqlite3.Row,
    max_statement_bytes: int,
) -> Iterator[tuple[str, bool]]:
    columns = TABLE_COLUMNS[table]
    values = [row[column] for column in columns]
    full = insert_statement(table, columns, values)
    if statement_bytes(full) <= max_statement_bytes:
        yield full, False
        return

    long_columns = [
        column
        for column in CHUNK_COLUMNS.get(table, ())
        if isinstance(row[column], str) and row[column]
    ]
    if not long_columns:
        raise ExportError(f"{table} row exceeds the SQL statement budget")

    base_values = ["" if column in long_columns else row[column] for column in columns]
    base = insert_statement(table, columns, base_values)
    if statement_bytes(base) > max_statement_bytes:
        raise ExportError(f"{table} row cannot fit its non-payload fields in the SQL budget")
    yield base, False
    for column in long_columns:
        make_statement = lambda chunk, t=table, c=column, r=row: append_statement(t, c, chunk, r)
        for chunk in split_text_for_update(row[column], make_statement, max_statement_bytes):
            yield make_statement(chunk), True


def iter_data_statements(
    connection: sqlite3.Connection,
    stats: ExportStats,
    max_statement_bytes: int,
) -> Iterator[str]:
    for table in TABLE_ORDER:
        columns = TABLE_COLUMNS[table]
        order = ", ".join(quote_identifier(column) for column in ORDER_BY[table])
        query = (
            f"SELECT {', '.join(quote_identifier(column) for column in columns)} "
            f"FROM {quote_identifier(table)} ORDER BY {order}"
        )
        for row in connection.execute(query):
            stats.rows[table] += 1
            row_size = estimated_row_bytes(row)
            stats.max_estimated_row_bytes = max(stats.max_estimated_row_bytes, row_size)
            if row_size + ROW_SAFETY_MARGIN_BYTES > D1_MAX_ROW_BYTES:
                raise ExportError(
                    f"{table} row {stats.rows[table]} is approximately {row_size} bytes; "
                    f"D1's {D1_MAX_ROW_BYTES}-byte row limit leaves no safe margin"
                )
            saw_chunk = False
            try:
                row_items = list(row)
                for value in row_items:
                    if isinstance(value, str) and "\x00" in value:
                        raise ExportError("a text value contains a NUL byte")
                # sqlite3.Row supports name lookup; keep this check separate so
                # the SQL generator never logs any row or credential value.
                for statement, is_chunk_update in row_statements(
                    table, row, max_statement_bytes
                ):
                    if statement_bytes(statement) > D1_MAX_STATEMENT_BYTES:
                        raise ExportError("generated SQL exceeds D1's 100,000-byte limit")
                    stats.note_statement(statement, is_chunk_update)
                    if is_chunk_update and not saw_chunk:
                        stats.chunked_rows += 1
                        saw_chunk = True
                    yield statement
            except (TypeError, KeyError) as error:
                raise ExportError(f"cannot read {table} row {stats.rows[table]}") from error
            if table == "changes":
                stats.changes_max_sequence = max(stats.changes_max_sequence, int(row["sequence"]))


def count_rows(connection: sqlite3.Connection, table: str) -> int:
    return int(connection.execute(f"SELECT COUNT(*) FROM {quote_identifier(table)}").fetchone()[0])


def snapshot_connection(
    source_path: Path,
    backup_temp: Path | None,
) -> tuple[sqlite3.Connection, sqlite3.Connection, Path | None]:
    """Return (snapshot, source, backup_temp), with source held open briefly."""

    source = read_only_connection(source_path)
    snapshot = None
    try:
        if backup_temp is None:
            snapshot = sqlite3.connect(":memory:")
        else:
            snapshot = sqlite3.connect(backup_temp)
        source.backup(snapshot)
        # A backup of a WAL database can leave the destination in WAL mode.
        # Force a standalone file before publishing it; the -wal/-shm sidecars
        # must never be required to read the migration backup.
        snapshot.commit()
        snapshot.execute("PRAGMA journal_mode = DELETE").fetchone()
        snapshot.commit()
        snapshot.row_factory = sqlite3.Row
        snapshot.execute("PRAGMA foreign_keys = ON")
        return snapshot, source, backup_temp
    except Exception:
        if snapshot is not None:
            snapshot.close()
        source.close()
        raise


def private_output_dir(path: Path, create: bool = True) -> Path:
    repo_root = Path(__file__).resolve().parents[1]
    private_root = (repo_root / ".local").resolve()
    resolved = path.resolve()
    try:
        resolved.relative_to(private_root)
    except ValueError as error:
        raise ExportError("output-dir must stay under the repository .local directory") from error
    if create:
        resolved.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(resolved, 0o700)
        except OSError:
            pass
    return resolved


def temporary_path(directory: Path, suffix: str) -> Path:
    descriptor, name = tempfile.mkstemp(prefix=".d1-", suffix=suffix, dir=directory)
    os.close(descriptor)
    return Path(name)


def remove_sqlite_sidecars(path: Path) -> None:
    for suffix in ("-wal", "-shm"):
        Path(f"{path}{suffix}").unlink(missing_ok=True)


def replace_private(temp_path: Path, final_path: Path, force: bool) -> None:
    if final_path.exists() and not force:
        raise ExportError(f"output exists; use --force to replace it: {final_path}")
    if final_path.name == BACKUP_NAME:
        remove_sqlite_sidecars(final_path)
    os.replace(temp_path, final_path)
    try:
        os.chmod(final_path, 0o600)
    except OSError:
        pass


def manifest(stats: ExportStats, schema_version: int, max_statement_bytes: int) -> dict[str, object]:
    return {
        "format": "inknote-d1-data-v1",
        "schema_version": schema_version,
        "schema_mode": "data_only_apply_existing_schema_first",
        "included_tables": list(TABLE_ORDER),
        "omitted_tables": {
            "sessions": {
                "rows": stats.omitted_sessions,
                "reason": "old endpoint-bound sessions are not migrated; users must log in again",
            }
        },
        "rows": stats.rows,
        "sql_statements": stats.statements,
        "chunk_update_statements": stats.chunk_update_statements,
        "chunked_rows": stats.chunked_rows,
        "statement_budget_bytes": max_statement_bytes,
        "max_statement_bytes": stats.max_statement_bytes,
        "max_estimated_row_bytes": stats.max_estimated_row_bytes,
        "row_safety_margin_bytes": ROW_SAFETY_MARGIN_BYTES,
        "changes_max_sequence": stats.changes_max_sequence,
        "d1_limits": {
            "max_statement_bytes": D1_MAX_STATEMENT_BYTES,
            "max_bound_parameters": 100,
            "max_row_or_string_bytes": D1_MAX_ROW_BYTES,
        },
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def write_manifest(data: dict[str, object], target: Path) -> None:
    temp = temporary_path(target.parent, ".json.tmp")
    try:
        with temp.open("w", encoding="utf-8", newline="\n") as output:
            json.dump(data, output, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        replace_private(temp, target, force=True)
    except Exception:
        temp.unlink(missing_ok=True)
        raise


def validate_option(value: int) -> int:
    if value < 1024 or value > D1_MAX_STATEMENT_BYTES:
        raise argparse.ArgumentTypeError(
            f"must be between 1024 and {D1_MAX_STATEMENT_BYTES} bytes"
        )
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--database",
        type=Path,
        default=Path(".local/notes.db"),
        help="source SQLite database (opened read-only)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(".local/d1-export"),
        help="private output directory under .local",
    )
    parser.add_argument(
        "--max-statement-bytes",
        type=validate_option,
        default=DEFAULT_STATEMENT_BYTES,
        help=f"SQL statement budget (default: {DEFAULT_STATEMENT_BYTES})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="snapshot and validate without writing backup or SQL files",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="replace existing private output files",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run a synthetic parser/chunk/load check without opening --database",
    )
    return parser


def synthetic_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA_SQL)
    user_id = "11111111-1111-4111-8111-111111111111"
    notebook_id = "22222222-2222-4222-8222-222222222222"
    page_id = "33333333-3333-4333-8333-333333333333"
    payload = ("quote';semicolon;\nΔ" * 7_000)
    with connection:
        connection.execute(
            "INSERT INTO users VALUES (?, ?, ?, ?, ?)",
            (user_id, "synthetic@example.invalid", "synthetic-salt", "synthetic-hash", "2026-01-01T00:00:00Z"),
        )
        connection.execute(
            "INSERT INTO sessions VALUES (?, ?, ?, ?, ?)",
            ("synthetic-token-hash", user_id, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", None),
        )
        connection.execute(
            "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)",
            (user_id, "notebook", notebook_id, 4, '{"id":"notebook"}', 0, "2026-01-01T00:00:00Z"),
        )
        connection.execute(
            "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)",
            (user_id, "page", page_id, 9, payload, 0, "2026-01-01T00:00:00Z"),
        )
        connection.execute(
            "INSERT INTO changes(sequence, user_id, entity_type, entity_id, revision, action, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (11, user_id, "notebook", notebook_id, 4, "upsert", '{"id":"notebook"}'),
        )
        connection.execute(
            "INSERT INTO changes(sequence, user_id, entity_type, entity_id, revision, action, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (19, user_id, "page", page_id, 9, "upsert", payload),
        )
        connection.execute(
            "INSERT INTO sync_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, "44444444-4444-4444-8444-444444444444", "request-fingerprint", "acked", 9, 19, payload, None),
        )
    return connection


def row_digest(connection: sqlite3.Connection, table: str) -> bytes:
    import hashlib

    digest = hashlib.sha256()
    columns = TABLE_COLUMNS[table]
    order = ", ".join(quote_identifier(column) for column in ORDER_BY[table])
    query = (
        f"SELECT {', '.join(quote_identifier(column) for column in columns)} "
        f"FROM {quote_identifier(table)} ORDER BY {order}"
    )
    for row in connection.execute(query):
        for value in row:
            encoded = sql_literal(value).encode("utf-8")
            digest.update(len(encoded).to_bytes(8, "big"))
            digest.update(encoded)
    return digest.digest()


def run_self_test(max_statement_bytes: int) -> None:
    source = synthetic_connection()
    schema_version = validate_schema(source)
    source_counts = {table: count_rows(source, table) for table in TABLE_ORDER}
    source_digests = {table: row_digest(source, table) for table in TABLE_ORDER}
    stats = ExportStats(omitted_sessions=count_rows(source, "sessions"))
    statements = list(iter_data_statements(source, stats, max_statement_bytes))
    script = "\n".join(statements) + "\n"
    parsed = list(split_sql_statements(script))
    if parsed != statements:
        raise ExportError("self-test SQL parser changed the generated statements")
    if any(statement_bytes(statement) > max_statement_bytes for statement in parsed):
        raise ExportError("self-test generated an oversized SQL statement")

    target = sqlite3.connect(":memory:")
    target.row_factory = sqlite3.Row
    target.executescript(SCHEMA_SQL)
    target.execute("PRAGMA foreign_keys = ON")
    with target:
        for statement in parsed:
            target.execute(statement)
    target_counts = {table: count_rows(target, table) for table in TABLE_ORDER}
    target_digests = {table: row_digest(target, table) for table in TABLE_ORDER}
    if source_counts != target_counts or source_digests != target_digests:
        raise ExportError("self-test source/target data mismatch")
    if count_rows(target, "sessions") != 0:
        raise ExportError("self-test copied a session")
    if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise ExportError("self-test target integrity check failed")
    if stats.chunk_update_statements == 0 or stats.changes_max_sequence != 19:
        raise ExportError("self-test did not exercise payload chunking and sequences")
    print(
        json.dumps(
            {
                "self_test": "passed",
                "schema_version": schema_version,
                "rows_checked": source_counts,
                "sessions_copied": 0,
                "sql_statements_checked": len(parsed),
                "chunk_update_statements": stats.chunk_update_statements,
                "max_statement_bytes": stats.max_statement_bytes,
            },
            sort_keys=True,
        )
    )


def run_export(args: argparse.Namespace) -> None:
    output_dir = private_output_dir(args.output_dir, create=not args.dry_run)
    final_backup = output_dir / BACKUP_NAME
    final_sql = output_dir / SQL_NAME
    final_manifest = output_dir / MANIFEST_NAME
    source_path = args.database.resolve()
    if source_path in {final_backup.resolve(), final_sql.resolve(), final_manifest.resolve()}:
        raise ExportError("source database and private output files must be different paths")
    if not args.dry_run and not args.force:
        existing = [path for path in (final_backup, final_sql, final_manifest) if path.exists()]
        if existing:
            raise ExportError("output exists; use --force to replace private files")

    backup_temp = None if args.dry_run else temporary_path(output_dir, ".sqlite3.tmp")
    snapshot = None
    source = None
    try:
        snapshot, source, _ = snapshot_connection(args.database, backup_temp)
        schema_version = validate_schema(snapshot)
        stats = ExportStats(omitted_sessions=count_rows(snapshot, "sessions"))
        if args.dry_run:
            for _ in iter_data_statements(snapshot, stats, args.max_statement_bytes):
                pass
            report = manifest(stats, schema_version, args.max_statement_bytes)
            report["dry_run"] = True
            print(json.dumps(report, indent=2, sort_keys=True))
            return

        # Generate SQL from the exact backup snapshot, then publish both files.
        sql_temp = temporary_path(output_dir, ".sql.tmp")
        try:
            with sql_temp.open("w", encoding="utf-8", newline="\n") as output:
                for statement in iter_data_statements(snapshot, stats, args.max_statement_bytes):
                    output.write(statement)
                    output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            snapshot.close()
            snapshot = None
            remove_sqlite_sidecars(backup_temp)
            replace_private(backup_temp, final_backup, args.force)
            backup_temp = None
            replace_private(sql_temp, final_sql, args.force)
            data = manifest(stats, schema_version, args.max_statement_bytes)
            data["backup_file"] = BACKUP_NAME
            data["sql_file"] = SQL_NAME
            write_manifest(data, final_manifest)
            print(
                json.dumps(
                    {
                        "output_dir": str(output_dir),
                        "backup_file": BACKUP_NAME,
                        "sql_file": SQL_NAME,
                        "manifest_file": MANIFEST_NAME,
                        "rows": stats.rows,
                        "sessions_omitted": stats.omitted_sessions,
                        "sql_statements": stats.statements,
                        "chunk_update_statements": stats.chunk_update_statements,
                        "max_statement_bytes": stats.max_statement_bytes,
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
        finally:
            sql_temp.unlink(missing_ok=True)
    finally:
        if snapshot is not None:
            snapshot.close()
        if source is not None:
            source.close()
        if backup_temp is not None:
            backup_temp.unlink(missing_ok=True)


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.self_test:
            run_self_test(args.max_statement_bytes)
        else:
            run_export(args)
        return 0
    except ExportError as error:
        print(f"export-d1: {error}", file=sys.stderr)
        return 2
    except sqlite3.Error:
        # SQLite diagnostics can echo parser context; never put that on stderr
        # because generated SQL contains private notes and credential hashes.
        print("export-d1: SQLite operation failed", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
