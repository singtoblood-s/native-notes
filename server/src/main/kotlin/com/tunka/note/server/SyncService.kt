package com.tunka.note.server

import com.tunka.note.shared.INK_FORMAT_VERSION
import com.tunka.note.shared.InkStroke
import com.tunka.note.shared.NotePage
import com.tunka.note.shared.Notebook
import com.tunka.note.shared.PageBackground
import com.tunka.note.shared.PushRequest
import com.tunka.note.shared.PushResponse
import com.tunka.note.shared.PushResult
import com.tunka.note.shared.PushStatus
import com.tunka.note.shared.StrokePoint
import com.tunka.note.shared.SyncAction
import com.tunka.note.shared.SyncChange
import com.tunka.note.shared.SyncEntityType
import com.tunka.note.shared.SyncOperation
import com.tunka.note.shared.PullResponse
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.decodeFromJsonElement
import java.time.Instant
import java.util.UUID

const val MAX_PUSH_OPERATIONS = 100
const val MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
const val MAX_STROKES = 10_000
const val MAX_POINTS = 200_000

data class HttpFailure(val status: Int, val code: String, override val message: String) : RuntimeException(message)

private val wireJson = Json {
    ignoreUnknownKeys = false
    encodeDefaults = true
    explicitNulls = true
}

class SyncService(private val database: ServerDatabase) {
    fun push(userId: String, request: PushRequest): PushResponse {
        if (request.operations.size > MAX_PUSH_OPERATIONS) {
            throw HttpFailure(413, "too_many_operations", "At most $MAX_PUSH_OPERATIONS operations may be sent")
        }
        return database.transaction { connection ->
            val results = request.operations.map { operation ->
                processOperation(connection, userId, operation)
            }
            PushResponse(results, connection.maxUserSequence(userId))
        }
    }

    fun pull(userId: String, cursor: Long, requestedLimit: Int): PullResponse {
        if (cursor < 0) throw HttpFailure(400, "invalid_cursor", "Cursor must be non-negative")
        val limit = requestedLimit.coerceIn(1, MAX_PUSH_OPERATIONS)
        return database.transaction { connection ->
            val maxSequence = connection.maxUserSequence(userId)
            if (cursor > maxSequence) throw HttpFailure(409, "cursor_expired", "A full sync is required")
            val rows = connection.prepareStatement(
                "SELECT sequence, entity_type, entity_id, revision, action, payload FROM changes WHERE user_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
            ).use { statement ->
                statement.setString(1, userId)
                statement.setLong(2, cursor)
                statement.setInt(3, limit + 1)
                statement.executeQuery().use { result ->
                    buildList {
                        while (result.next()) add(
                            SyncChange(
                                sequence = result.getLong("sequence"),
                                entityType = entityType(result.getString("entity_type")),
                                entityId = result.getString("entity_id"),
                                revision = result.getLong("revision"),
                                action = action(result.getString("action")),
                                payload = wireJson.parseToJsonElement(result.getString("payload")),
                            ),
                        )
                    }
                }
            }
            val hasMore = rows.size > limit
            val changes = if (hasMore) rows.take(limit) else rows
            PullResponse(changes, changes.lastOrNull()?.sequence ?: cursor, hasMore)
        }
    }

    private fun processOperation(
        connection: java.sql.Connection,
        userId: String,
        operation: SyncOperation,
    ): PushResult {
        val existing = connection.findStoredOperation(userId, operation.opId)
        val requestHash = wireJson.encodeToString(operation).sha256Base64()
        if (existing != null) {
            if (connection.findStoredOperationHash(userId, operation.opId) != requestHash) {
                return PushResult(operation.opId, PushStatus.REJECTED, code = "idempotency_mismatch")
            }
            return existing.toResult(operation.opId)
        }

        val result = try {
            validateOperation(connection, userId, operation)
            val current = connection.findDocument(userId, operation.entityType.asWire(), operation.entityId)
            if (operation.baseRevision != (current?.revision ?: 0L)) {
                PushResult(
                    opId = operation.opId,
                    status = PushStatus.CONFLICT,
                    revision = current?.revision ?: 0L,
                    serverPayload = current?.payload?.let(wireJson::parseToJsonElement),
                    code = "revision_conflict",
                )
            } else {
                val nextRevision = (current?.revision ?: 0L) + 1L
                val canonical = canonicalPayload(operation, nextRevision)
                val document = StoredDocument(
                    userId = userId,
                    entityType = operation.entityType.asWire(),
                    entityId = operation.entityId,
                    revision = nextRevision,
                    payload = canonical.first,
                    deleted = canonical.second,
                    updatedAt = canonical.third,
                )
                connection.upsertDocument(document)
                val sequence = connection.insertChange(document, operation.action.asWire())
                PushResult(operation.opId, PushStatus.ACKED, nextRevision, sequence)
            }
        } catch (failure: HttpFailure) {
            PushResult(operation.opId, PushStatus.REJECTED, code = failure.code)
        }
        connection.insertStoredOperation(
            userId,
            operation.opId,
            requestHash,
            StoredOperation(
                status = result.status.asWire(),
                revision = result.revision,
                sequence = result.sequence,
                serverPayload = result.serverPayload?.toString(),
                code = result.code,
            ),
        )
        return result
    }

    private fun validateOperation(connection: java.sql.Connection, userId: String, operation: SyncOperation) {
        if (!UUID_PATTERN.matches(operation.opId) || !UUID_PATTERN.matches(operation.entityId)) {
            throw HttpFailure(400, "invalid_id", "Invalid operation or entity ID")
        }
        if (operation.baseRevision < 0) throw HttpFailure(400, "invalid_revision", "Revision must be non-negative")
        val bytes = operation.payload.toString().toByteArray(Charsets.UTF_8).size
        if (bytes > MAX_PAYLOAD_BYTES) throw HttpFailure(413, "payload_too_large", "Note payload is too large")
        when (operation.entityType) {
            SyncEntityType.NOTEBOOK -> {
                val notebook = decode<Notebook>(operation.payload)
                requireId(notebook.id, operation.entityId)
                if (notebook.title.isBlank() || notebook.title.length > 500) throw HttpFailure(400, "invalid_notebook", "Notebook title is invalid")
            }
            SyncEntityType.PAGE -> {
                val page = decode<NotePage>(operation.payload)
                requireId(page.id, operation.entityId)
                if (!UUID_PATTERN.matches(page.notebookId)) throw HttpFailure(400, "invalid_notebook_id", "Invalid notebook ID")
                if (page.title.length > 500 || page.text.length > 1_000_000) throw HttpFailure(400, "page_too_large", "Page text or title is too large")
                if (page.width !in 1.0..10_000.0 || page.height !in 1.0..10_000.0) throw HttpFailure(400, "invalid_page_size", "Page size is invalid")
                if (page.formatVersion != INK_FORMAT_VERSION) throw HttpFailure(400, "unsupported_format", "Unsupported ink format")
                val notebook = connection.findDocument(userId, "notebook", page.notebookId)
                if (notebook == null) throw HttpFailure(400, "notebook_not_found", "Notebook does not exist")
                if (notebook.deleted && operation.action == SyncAction.UPSERT) {
                    throw HttpFailure(409, "notebook_deleted", "Restore the notebook before editing this page")
                }
                if (page.strokes.size > MAX_STROKES) throw HttpFailure(413, "too_many_strokes", "Page has too many strokes")
                var points = 0
                val strokeIds = HashSet<String>(page.strokes.size)
                page.strokes.forEach { stroke ->
                    requireUuid(stroke.id)
                    if (!strokeIds.add(stroke.id) || stroke.width !in 0.1..100.0 || stroke.points.isEmpty()) throw HttpFailure(400, "invalid_stroke", "Stroke is invalid")
                    if (stroke.color !in 0L..0xFFFF_FFFFL) throw HttpFailure(400, "invalid_stroke", "Stroke color is invalid")
                    points += stroke.points.size
                    var previousTime = -1L
                    stroke.points.forEach { point ->
                        if (!point.x.isFinite() || !point.y.isFinite() || point.pressure !in 0.0..1.0 ||
                            point.time < 0 || point.time < previousTime ||
                            point.tiltX?.let { !it.isFinite() || it !in -90.0..90.0 } == true ||
                            point.tiltY?.let { !it.isFinite() || it !in -90.0..90.0 } == true
                        ) {
                            throw HttpFailure(400, "invalid_point", "Stroke point is invalid")
                        }
                        previousTime = point.time
                    }
                }
                if (points > MAX_POINTS) throw HttpFailure(413, "too_many_points", "Page has too many points")
            }
        }
    }

    private fun canonicalPayload(operation: SyncOperation, revision: Long): Triple<String, Boolean, String> {
        val now = Instant.now().toString()
        return when (operation.entityType) {
            SyncEntityType.NOTEBOOK -> {
                val original = decode<Notebook>(operation.payload)
                val value = original.copy(
                    revision = revision,
                    updatedAt = now,
                    deletedAt = if (operation.action == SyncAction.DELETE) original.deletedAt ?: now else original.deletedAt,
                )
                Triple(wireJson.encodeToString(value), operation.action == SyncAction.DELETE || value.deletedAt != null, now)
            }
            SyncEntityType.PAGE -> {
                val original = decode<NotePage>(operation.payload)
                val value = original.copy(
                    revision = revision,
                    updatedAt = now,
                    deletedAt = if (operation.action == SyncAction.DELETE) original.deletedAt ?: now else original.deletedAt,
                )
                Triple(wireJson.encodeToString(value), operation.action == SyncAction.DELETE || value.deletedAt != null, now)
            }
        }
    }

    private inline fun <reified T> decode(payload: JsonElement): T =
        runCatching { wireJson.decodeFromJsonElement<T>(payload) }
            .getOrElse { throw HttpFailure(400, "invalid_payload", "Note payload is invalid") }

    private fun requireId(actual: String, expected: String) {
        if (actual != expected || !UUID_PATTERN.matches(actual)) throw HttpFailure(400, "invalid_id", "Payload ID does not match operation")
    }

    private fun requireUuid(value: String) {
        if (!UUID_PATTERN.matches(value)) throw HttpFailure(400, "invalid_id", "Invalid stroke ID")
    }

    private fun entityType(value: String) = when (value) {
        "notebook" -> SyncEntityType.NOTEBOOK
        "page" -> SyncEntityType.PAGE
        else -> throw IllegalStateException("invalid stored entity type")
    }

    private fun action(value: String) = when (value) {
        "upsert" -> SyncAction.UPSERT
        "delete" -> SyncAction.DELETE
        else -> throw IllegalStateException("invalid stored action")
    }

    private fun StoredOperation.toResult(opId: String) = PushResult(
        opId = opId,
        status = when (status) {
            "acked" -> PushStatus.ACKED
            "conflict" -> PushStatus.CONFLICT
            else -> PushStatus.REJECTED
        },
        revision = revision,
        sequence = sequence,
        serverPayload = serverPayload?.let(wireJson::parseToJsonElement),
        code = code,
    )

    private fun SyncEntityType.asWire() = if (this == SyncEntityType.NOTEBOOK) "notebook" else "page"
    private fun SyncAction.asWire() = if (this == SyncAction.UPSERT) "upsert" else "delete"
    private fun PushStatus.asWire() = when (this) {
        PushStatus.ACKED -> "acked"
        PushStatus.CONFLICT -> "conflict"
        PushStatus.REJECTED -> "rejected"
    }

    companion object {
        private val UUID_PATTERN = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}")
    }
}
