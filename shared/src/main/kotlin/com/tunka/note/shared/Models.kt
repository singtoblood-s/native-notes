package com.tunka.note.shared

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import java.util.UUID

const val INK_FORMAT_VERSION = 1
const val PAGE_METADATA_FORMAT_VERSION = 2

@Serializable
data class Notebook(
    val id: String,
    val title: String,
    val createdAt: String,
    val updatedAt: String,
    val deletedAt: String? = null,
    val revision: Long = 0,
)

@Serializable
enum class PageBackground {
    @SerialName("blank") BLANK,
    @SerialName("ruled") RULED,
    @SerialName("grid") GRID,
}

@Serializable
data class StrokePoint(
    val x: Double,
    val y: Double,
    val pressure: Double = 0.5,
    val time: Long = 0,
    val tiltX: Double? = null,
    val tiltY: Double? = null,
)

@Serializable
data class InkStroke(
    val id: String,
    val color: Long,
    val width: Double,
    val points: List<StrokePoint>,
)

@Serializable
data class PageImage(
    val id: String,
    val src: String,
    val x: Double,
    val y: Double,
    val width: Double,
    val height: Double,
)

@Serializable
data class NotePage(
    val id: String,
    val notebookId: String,
    val title: String,
    val text: String,
    val background: PageBackground = PageBackground.BLANK,
    val width: Double = 1024.0,
    val height: Double = 1366.0,
    val strokes: List<InkStroke> = emptyList(),
    val formatVersion: Int = INK_FORMAT_VERSION,
    val revision: Long = 0,
    val updatedAt: String,
    val deletedAt: String? = null,
    val images: List<PageImage> = emptyList(),
    val order: Long? = null,
    val conflictOf: String? = null,
)

@Serializable
enum class SyncEntityType {
    @SerialName("notebook") NOTEBOOK,
    @SerialName("page") PAGE,
}

@Serializable
enum class SyncAction {
    @SerialName("upsert") UPSERT,
    @SerialName("delete") DELETE,
}

@Serializable
data class SyncOperation(
    val opId: String,
    val entityType: SyncEntityType,
    val entityId: String,
    val baseRevision: Long,
    val action: SyncAction,
    val payload: JsonElement,
    val createdAt: String,
)

@Serializable
data class PushRequest(val operations: List<SyncOperation>)

@Serializable
enum class PushStatus {
    @SerialName("acked") ACKED,
    @SerialName("conflict") CONFLICT,
    @SerialName("rejected") REJECTED,
}

@Serializable
data class PushResult(
    val opId: String,
    val status: PushStatus,
    val revision: Long? = null,
    val sequence: Long? = null,
    val serverPayload: JsonElement? = null,
    val code: String? = null,
)

@Serializable
data class PushResponse(val results: List<PushResult>, val cursor: Long)

@Serializable
data class SyncChange(
    val sequence: Long,
    val entityType: SyncEntityType,
    val entityId: String,
    val revision: Long,
    val action: SyncAction,
    val payload: JsonElement,
)

@Serializable
data class PullResponse(val changes: List<SyncChange>, val nextCursor: Long, val hasMore: Boolean)

@Serializable
data class User(val id: String, val identifier: String)

@Serializable
data class AuthRequest(val identifier: String, val password: String)

@Serializable
data class AuthResponse(val user: User, val sessionToken: String, val expiresAt: String)

@Serializable
data class ApiError(val code: String, val message: String)

@Serializable
data class ApiErrorEnvelope(val error: ApiError)

@Serializable
data class ConflictCopy(
    val id: String,
    val entityType: SyncEntityType,
    val entityId: String,
    val payload: JsonElement,
    val createdAt: String,
    val reason: String,
)

object NoteIds {
    fun newId(): String = UUID.randomUUID().toString()
}
