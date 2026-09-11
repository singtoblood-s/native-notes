package com.tunka.note.server

import java.nio.file.Files
import java.nio.file.Path
import java.sql.Connection
import java.sql.DriverManager
import java.time.Instant
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import kotlin.io.path.absolutePathString

/**
 * A single SQLite writer is enough for the first deployment. The lock is
 * deliberate: it avoids SQLite busy races; use per-account connections only
 * after measured throughput requires it. (ponytail: global lock, shard later.)
 */
class ServerDatabase(databasePath: Path) : AutoCloseable {
    private val lock = Any()
    private val path = databasePath.toAbsolutePath()
    private val jdbcUrl: String

    init {
        Files.createDirectories(path.parent)
        Class.forName("org.sqlite.JDBC")
        jdbcUrl = "jdbc:sqlite:${path.absolutePathString()}"
        DriverManager.getConnection(jdbcUrl).use { connection ->
            configure(connection)
            connection.createStatement().use { statement ->
                statement.executeUpdate(
                    """
                    CREATE TABLE IF NOT EXISTS users (
                      id TEXT PRIMARY KEY,
                      identifier TEXT NOT NULL UNIQUE,
                      salt TEXT NOT NULL,
                      password_hash TEXT NOT NULL,
                      created_at TEXT NOT NULL
                    )
                    """.trimIndent(),
                )
                statement.executeUpdate(
                    """
                    CREATE TABLE IF NOT EXISTS sessions (
                      token_hash TEXT PRIMARY KEY,
                      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                      created_at TEXT NOT NULL,
                      expires_at TEXT NOT NULL,
                      revoked_at TEXT
                    )
                    """.trimIndent(),
                )
                statement.executeUpdate(
                    """
                    CREATE TABLE IF NOT EXISTS documents (
                      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                      entity_type TEXT NOT NULL,
                      entity_id TEXT NOT NULL,
                      revision INTEGER NOT NULL,
                      payload TEXT NOT NULL,
                      deleted INTEGER NOT NULL DEFAULT 0,
                      updated_at TEXT NOT NULL,
                      PRIMARY KEY (user_id, entity_type, entity_id)
                    )
                    """.trimIndent(),
                )
                statement.executeUpdate(
                    """
                    CREATE TABLE IF NOT EXISTS changes (
                      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                      entity_type TEXT NOT NULL,
                      entity_id TEXT NOT NULL,
                      revision INTEGER NOT NULL,
                      action TEXT NOT NULL,
                      payload TEXT NOT NULL
                    )
                    """.trimIndent(),
                )
                statement.executeUpdate("CREATE INDEX IF NOT EXISTS changes_user_sequence ON changes(user_id, sequence)")
                statement.executeUpdate(
                    """
                    CREATE TABLE IF NOT EXISTS sync_operations (
                      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                      op_id TEXT NOT NULL,
                      request_hash TEXT NOT NULL,
                      status TEXT NOT NULL,
                      revision INTEGER,
                      sequence INTEGER,
                      server_payload TEXT,
                      code TEXT,
                      PRIMARY KEY (user_id, op_id)
                    )
                    """.trimIndent(),
                )
                val version = statement.executeQuery("PRAGMA user_version").use { rows ->
                    rows.next()
                    rows.getInt(1)
                }
                if (version > 1) error("Database schema version $version is newer than this server")
                if (version == 0) statement.executeUpdate("PRAGMA user_version = 1")
            }
        }
    }

    fun <T> transaction(block: (Connection) -> T): T = synchronized(lock) {
        DriverManager.getConnection(jdbcUrl).use { connection ->
            configure(connection)
            connection.autoCommit = false
            try {
                val value = block(connection)
                connection.commit()
                value
            } catch (error: Throwable) {
                runCatching { connection.rollback() }
                throw error
            }
        }
    }

    override fun close() = Unit

    private fun configure(connection: Connection) {
        connection.createStatement().use { statement ->
            statement.execute("PRAGMA foreign_keys = ON")
            statement.execute("PRAGMA busy_timeout = 5000")
            // journal_mode is a database setting and must run outside a transaction.
            statement.execute("PRAGMA journal_mode = WAL")
        }
    }
}

data class StoredDocument(
    val userId: String,
    val entityType: String,
    val entityId: String,
    val revision: Long,
    val payload: String,
    val deleted: Boolean,
    val updatedAt: String,
)

data class StoredOperation(
    val status: String,
    val revision: Long?,
    val sequence: Long?,
    val serverPayload: String?,
    val code: String?,
)

data class SessionUser(val id: String, val identifier: String)

internal fun Connection.findDocument(userId: String, entityType: String, entityId: String): StoredDocument? =
    prepareStatement(
        "SELECT user_id, entity_type, entity_id, revision, payload, deleted, updated_at FROM documents WHERE user_id = ? AND entity_type = ? AND entity_id = ?",
    ).use { statement ->
        statement.setString(1, userId)
        statement.setString(2, entityType)
        statement.setString(3, entityId)
        statement.executeQuery().use { rows ->
            if (!rows.next()) return@use null
            StoredDocument(
                userId = rows.getString("user_id"),
                entityType = rows.getString("entity_type"),
                entityId = rows.getString("entity_id"),
                revision = rows.getLong("revision"),
                payload = rows.getString("payload"),
                deleted = rows.getInt("deleted") != 0,
                updatedAt = rows.getString("updated_at"),
            )
        }
    }

internal fun Connection.findStoredOperation(userId: String, opId: String): StoredOperation? =
    prepareStatement(
        "SELECT status, revision, sequence, server_payload, code FROM sync_operations WHERE user_id = ? AND op_id = ?",
    ).use { statement ->
        statement.setString(1, userId)
        statement.setString(2, opId)
        statement.executeQuery().use { rows ->
            if (!rows.next()) return@use null
            StoredOperation(
                status = rows.getString("status"),
                revision = rows.getLong("revision").takeUnless { rows.wasNull() },
                sequence = rows.getLong("sequence").takeUnless { rows.wasNull() },
                serverPayload = rows.getString("server_payload"),
                code = rows.getString("code"),
            )
        }
    }

internal fun Connection.findStoredOperationHash(userId: String, opId: String): String? =
    prepareStatement("SELECT request_hash FROM sync_operations WHERE user_id = ? AND op_id = ?").use { statement ->
        statement.setString(1, userId)
        statement.setString(2, opId)
        statement.executeQuery().use { rows -> if (rows.next()) rows.getString(1) else null }
    }

internal fun Connection.maxUserSequence(userId: String): Long =
    prepareStatement("SELECT COALESCE(MAX(sequence), 0) FROM changes WHERE user_id = ?").use { statement ->
        statement.setString(1, userId)
        statement.executeQuery().use { rows -> rows.next(); rows.getLong(1) }
    }

internal fun Connection.insertStoredOperation(
    userId: String,
    opId: String,
    requestHash: String,
    result: StoredOperation,
) {
    prepareStatement(
        "INSERT INTO sync_operations(user_id, op_id, request_hash, status, revision, sequence, server_payload, code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).use { statement ->
        statement.setString(1, userId)
        statement.setString(2, opId)
        statement.setString(3, requestHash)
        statement.setString(4, result.status)
        if (result.revision == null) statement.setNull(5, java.sql.Types.INTEGER) else statement.setLong(5, result.revision)
        if (result.sequence == null) statement.setNull(6, java.sql.Types.INTEGER) else statement.setLong(6, result.sequence)
        statement.setString(7, result.serverPayload)
        statement.setString(8, result.code)
        statement.executeUpdate()
    }
}

internal fun Connection.upsertDocument(document: StoredDocument) {
    prepareStatement(
        """
        INSERT INTO documents(user_id, entity_type, entity_id, revision, payload, deleted, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, entity_type, entity_id) DO UPDATE SET
          revision = excluded.revision, payload = excluded.payload,
          deleted = excluded.deleted, updated_at = excluded.updated_at
        """.trimIndent(),
    ).use { statement ->
        statement.setString(1, document.userId)
        statement.setString(2, document.entityType)
        statement.setString(3, document.entityId)
        statement.setLong(4, document.revision)
        statement.setString(5, document.payload)
        statement.setInt(6, if (document.deleted) 1 else 0)
        statement.setString(7, document.updatedAt)
        statement.executeUpdate()
    }
}

internal fun Connection.insertChange(document: StoredDocument, action: String): Long =
    prepareStatement(
        "INSERT INTO changes(user_id, entity_type, entity_id, revision, action, payload) VALUES (?, ?, ?, ?, ?, ?)",
        java.sql.Statement.RETURN_GENERATED_KEYS,
    ).use { statement ->
        statement.setString(1, document.userId)
        statement.setString(2, document.entityType)
        statement.setString(3, document.entityId)
        statement.setLong(4, document.revision)
        statement.setString(5, action)
        statement.setString(6, document.payload)
        statement.executeUpdate()
        statement.generatedKeys.use { keys ->
            if (!keys.next()) error("SQLite did not return a change sequence")
            keys.getLong(1)
        }
    }

internal fun String.normalizedIdentifier(): String = trim().lowercase()

internal fun String.sha256Base64(): String = Base64.getUrlEncoder().withoutPadding().encodeToString(
    java.security.MessageDigest.getInstance("SHA-256").digest(toByteArray(Charsets.UTF_8)),
)

internal fun Instant.asWire(): String = toString()
