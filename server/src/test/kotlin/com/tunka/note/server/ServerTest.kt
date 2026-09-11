package com.tunka.note.server

import com.tunka.note.shared.AuthRequest
import com.tunka.note.shared.AuthResponse
import com.tunka.note.shared.InkStroke
import com.tunka.note.shared.NotePage
import com.tunka.note.shared.Notebook
import com.tunka.note.shared.PushRequest
import com.tunka.note.shared.PushStatus
import com.tunka.note.shared.SyncAction
import com.tunka.note.shared.SyncEntityType
import com.tunka.note.shared.SyncOperation
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import io.ktor.client.request.header
import io.ktor.client.request.options
import io.ktor.client.request.post
import io.ktor.client.request.get
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.encodeToJsonElement
import kotlin.io.path.createTempDirectory
import kotlin.io.path.deleteIfExists
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.assertFailsWith

class ServerTest {
    private val json = Json { encodeDefaults = true; explicitNulls = true }

    @Test
    fun authSessionSurvivesReopenAndLogoutRevokesIt() {
        val directory = createTempDirectory("inknote-auth")
        val path = directory.resolve("notes.db")
        try {
            val response = ServerDatabase(path).use { database ->
                val auth = AuthService(database)
                auth.register(AuthRequest("Person@Example.com", "a-strong-password"), "test-client")
            }
            ServerDatabase(path).use { database ->
                val auth = AuthService(database)
                assertEquals(response.user.identifier, auth.authenticate(response.sessionToken).identifier)
                auth.logout(response.sessionToken)
                assertFailsWith<AuthFailure> { auth.authenticate(response.sessionToken) }
            }
        } finally {
            path.deleteIfExists()
            directory.deleteIfExists()
        }
    }

    @Test
    fun pushRetryIsDeduplicatedAndStaleEditIsPreservedAsConflict() {
        val directory = createTempDirectory("inknote-sync")
        val path = directory.resolve("notes.db")
        try {
            ServerDatabase(path).use { database ->
                val auth = AuthService(database)
                val user = auth.register(AuthRequest("sync@example.com", "another-strong-password"), "test-client")
                val sync = SyncService(database)
                val notebookId = "00000000-0000-4000-8000-000000000001"
                val opId = "00000000-0000-4000-8000-000000000002"
                val snapshot = Notebook(notebookId, "First", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
                val operation = SyncOperation(
                    opId, SyncEntityType.NOTEBOOK, notebookId, 0,
                    SyncAction.UPSERT, json.encodeToJsonElement(snapshot), snapshot.updatedAt,
                )
                val first = sync.push(user.user.id, PushRequest(listOf(operation)))
                val retry = sync.push(user.user.id, PushRequest(listOf(operation)))
                assertEquals(PushStatus.ACKED, first.results.single().status)
                assertEquals(first.results.single(), retry.results.single())

                val stale = operation.copy(
                    opId = "00000000-0000-4000-8000-000000000003",
                    payload = json.encodeToJsonElement(snapshot.copy(title = "Offline edit")),
                )
                val conflict = sync.push(user.user.id, PushRequest(listOf(stale))).results.single()
                assertEquals(PushStatus.CONFLICT, conflict.status)
                assertEquals("First", conflict.serverPayload?.let { json.decodeFromJsonElement<Notebook>(it) }?.title)

                val changedSameOp = operation.copy(payload = json.encodeToJsonElement(snapshot.copy(title = "tampered")))
                val mismatch = sync.push(user.user.id, PushRequest(listOf(changedSameOp))).results.single()
                assertEquals(PushStatus.REJECTED, mismatch.status)
                assertEquals("idempotency_mismatch", mismatch.code)
                assertEquals(1, sync.pull(user.user.id, 0, 100).changes.size)
            }
        } finally {
            path.deleteIfExists()
            directory.deleteIfExists()
        }
    }

    @Test
    fun accountsCannotReadEachOthersChanges() {
        val directory = createTempDirectory("inknote-isolation")
        val path = directory.resolve("notes.db")
        try {
            ServerDatabase(path).use { database ->
                val auth = AuthService(database)
                val one = auth.register(AuthRequest("one@example.com", "one-strong-password"), "client-one")
                val two = auth.register(AuthRequest("two@example.com", "two-strong-password"), "client-two")
                val sync = SyncService(database)
                val notebookId = "00000000-0000-4000-8000-000000000010"
                val snapshot = Notebook(notebookId, "Private", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
                sync.push(
                    one.user.id,
                    PushRequest(
                        listOf(SyncOperation(
                            "00000000-0000-4000-8000-000000000011", SyncEntityType.NOTEBOOK, notebookId, 0,
                            SyncAction.UPSERT, json.encodeToJsonElement(snapshot), snapshot.updatedAt,
                        )),
                    ),
                )
                val other = sync.pull(two.user.id, 0, 100)
                assertTrue(other.changes.isEmpty())
                assertNotNull(auth.authenticate(two.sessionToken))
            }
        } finally {
            path.deleteIfExists()
            directory.deleteIfExists()
        }
    }

    @Test
    fun pageDeleteIsATombstoneAndDeletedNotebookBlocksPageEdits() {
        val directory = createTempDirectory("inknote-tombstone")
        val path = directory.resolve("notes.db")
        try {
            ServerDatabase(path).use { database ->
                val auth = AuthService(database)
                val user = auth.register(AuthRequest("tombstone@example.com", "tombstone-strong"), "client")
                val sync = SyncService(database)
                val notebookId = "00000000-0000-4000-8000-000000000020"
                val pageId = "00000000-0000-4000-8000-000000000021"
                val stamp = "2026-01-01T00:00:00Z"
                val notebook = Notebook(notebookId, "Notebook", stamp, stamp)
                sync.push(user.user.id, PushRequest(listOf(operation("00000000-0000-4000-8000-000000000022", SyncEntityType.NOTEBOOK, notebookId, 0, notebook))))
                val page = NotePage(pageId, notebookId, "Page", "", updatedAt = stamp)
                val created = sync.push(user.user.id, PushRequest(listOf(operation("00000000-0000-4000-8000-000000000023", SyncEntityType.PAGE, pageId, 0, page))))
                assertEquals(1, created.results.single().revision)
                val deleted = sync.push(user.user.id, PushRequest(listOf(operation("00000000-0000-4000-8000-000000000024", SyncEntityType.PAGE, pageId, 1, page, SyncAction.DELETE))))
                assertEquals(PushStatus.ACKED, deleted.results.single().status)
                val tombstone = deleted.results.single().let { sync.pull(user.user.id, 1, 100).changes.last().payload }
                assertNotNull(tombstone.jsonObject["deletedAt"])
                val restored = sync.push(user.user.id, PushRequest(listOf(operation("00000000-0000-4000-8000-000000000025", SyncEntityType.PAGE, pageId, 2, page))))
                assertEquals(PushStatus.ACKED, restored.results.single().status)
                sync.push(user.user.id, PushRequest(listOf(operation("00000000-0000-4000-8000-000000000026", SyncEntityType.NOTEBOOK, notebookId, 1, notebook, SyncAction.DELETE))))
                val blocked = sync.push(user.user.id, PushRequest(listOf(operation("00000000-0000-4000-8000-000000000027", SyncEntityType.PAGE, pageId, 3, page))))
                assertEquals(PushStatus.REJECTED, blocked.results.single().status)
                assertEquals("notebook_deleted", blocked.results.single().code)
            }
        } finally {
            path.deleteIfExists()
            directory.deleteIfExists()
        }
    }

    @Test
    fun httpRoutesReturnCorsAndBoundedErrorEnvelope() {
        val directory = createTempDirectory("inknote-http")
        val path = directory.resolve("notes.db")
        try {
            testApplication {
                application { module(ServerDatabase(path)) }
                val register = client.post("/v1/auth/register") {
                    header(HttpHeaders.Origin, "https://singtoblood-s.github.io")
                    contentType(ContentType.Application.Json)
                    setBody("{\"identifier\":\"http@example.com\",\"password\":\"http-strong-pass\"}")
                }
                assertEquals(HttpStatusCode.OK, register.status)
                assertEquals("https://singtoblood-s.github.io", register.headers["Access-Control-Allow-Origin"])
                val session = json.decodeFromString<AuthResponse>(register.bodyAsText())
                val invalid = client.post("/v1/auth/register") {
                    contentType(ContentType.Application.Json)
                    setBody("{\"identifier\":\"bad@example.com\",\"password\":\"short\"}")
                }
                assertEquals(HttpStatusCode.BadRequest, invalid.status)
                assertTrue(invalid.bodyAsText().contains("invalid_password"))
                val oversized = "{\"operations\":[]}" + " ".repeat(4 * 1024 * 1024)
                val bounded = client.post("/v1/sync/push") {
                    header(HttpHeaders.Authorization, "Bearer ${session.sessionToken}")
                    contentType(ContentType.Application.Json)
                    setBody(oversized)
                }
                assertEquals(HttpStatusCode.PayloadTooLarge, bounded.status)
                assertTrue(bounded.bodyAsText().contains("request_too_large"))
                val preflight = client.options("/v1/auth/login") {
                    header(HttpHeaders.Origin, "https://singtoblood-s.github.io")
                    header(HttpHeaders.AccessControlRequestMethod, "POST")
                    header(HttpHeaders.AccessControlRequestHeaders, "content-type")
                }
                assertTrue(preflight.status.value in 200..299)
                assertEquals("https://singtoblood-s.github.io", preflight.headers["Access-Control-Allow-Origin"])
            }
        } finally {
            path.deleteIfExists()
            directory.deleteIfExists()
        }
    }

    private inline fun <reified T> operation(
        opId: String,
        type: SyncEntityType,
        entityId: String,
        baseRevision: Long,
        value: T,
        action: SyncAction = SyncAction.UPSERT,
    ): SyncOperation = SyncOperation(
        opId, type, entityId, baseRevision, action, json.encodeToJsonElement(value), "2026-01-01T00:00:00Z",
    )
}
