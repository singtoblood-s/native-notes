package com.tunka.note.server

import com.tunka.note.shared.ApiError
import com.tunka.note.shared.ApiErrorEnvelope
import com.tunka.note.shared.AuthRequest
import com.tunka.note.shared.PullResponse
import com.tunka.note.shared.PushRequest
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.io.readByteArray
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationStopped
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.calllogging.CallLogging
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.cors.routing.CORS
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.request.receiveChannel
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import io.ktor.utils.io.readRemaining
import java.nio.file.Path

private const val MAX_AUTH_BODY = 64 * 1024
private const val MAX_SYNC_BODY = 4 * 1024 * 1024

private val appJson = Json {
    ignoreUnknownKeys = false
    encodeDefaults = true
    explicitNulls = true
}

fun main() {
    val host = System.getenv("HOST")?.takeIf(String::isNotBlank) ?: "127.0.0.1"
    val port = System.getenv("PORT")?.toIntOrNull()?.takeIf { it in 1..65535 } ?: 8080
    val databasePath = System.getenv("NOTES_DB_PATH")?.takeIf(String::isNotBlank) ?: "data/inknote.db"
    embeddedServer(Netty, port = port, host = host) {
        module(ServerDatabase(Path.of(databasePath)))
    }.start(wait = true)
}

fun Application.module(database: ServerDatabase) {
    val auth = AuthService(database)
    val sync = SyncService(database)
    val origins = (System.getenv("ALLOWED_ORIGINS") ?: "https://singtoblood-s.github.io")
        .split(',').map(String::trim).filter(String::isNotBlank).toSet()

    install(CallLogging)
    install(ContentNegotiation) { json(appJson) }
    install(CORS) {
        origins.forEach { origin ->
            runCatching {
                val uri = java.net.URI(origin)
                allowHost(uri.authority, schemes = listOf(uri.scheme))
            }
        }
        allowMethod(HttpMethod.Options)
        allowMethod(HttpMethod.Get)
        allowMethod(HttpMethod.Post)
        allowMethod(HttpMethod.Delete)
        allowHeader(HttpHeaders.Authorization)
        allowHeader(HttpHeaders.ContentType)
        allowNonSimpleContentTypes = true
        maxAgeInSeconds = 3600
    }
    install(StatusPages) {
        exception<HttpFailure> { call, failure ->
            call.respond(failure.statusCode(), ApiErrorEnvelope(ApiError(failure.code, failure.message)))
        }
        exception<AuthFailure> { call, failure ->
            call.respond(HttpStatusCode.fromValue(failure.status), ApiErrorEnvelope(ApiError(failure.code, failure.message)))
        }
        exception<SerializationException> { call, _ ->
            call.respond(HttpStatusCode.BadRequest, ApiErrorEnvelope(ApiError("invalid_json", "Request JSON is invalid")))
        }
        exception<Throwable> { call, _ ->
            call.respond(HttpStatusCode.InternalServerError, ApiErrorEnvelope(ApiError("internal_error", "The server could not complete the request")))
        }
    }
    monitor.subscribe(ApplicationStopped) { database.close() }

    routing {
        get("/health") { call.respondText("ok", ContentType.Text.Plain) }

        post("/v1/auth/register") {
            val request = call.receiveJson<AuthRequest>(MAX_AUTH_BODY)
            call.respond(auth.register(request, call.clientKey()))
        }
        post("/v1/auth/login") {
            val request = call.receiveJson<AuthRequest>(MAX_AUTH_BODY)
            call.respond(auth.login(request, call.clientKey()))
        }
        post("/v1/auth/logout") {
            auth.logout(call.bearerToken())
            call.respondText("", status = HttpStatusCode.NoContent)
        }

        post("/v1/sync/push") {
            val user = auth.authenticate(call.bearerToken())
            val request = call.receiveJson<PushRequest>(MAX_SYNC_BODY)
            call.respond(sync.push(user.id, request))
        }
        get("/v1/sync/pull") {
            val user = auth.authenticate(call.bearerToken())
            val cursor = call.request.queryParameters["cursor"]?.toLongOrNull()
                ?: throw HttpFailure(400, "invalid_cursor", "Cursor is required")
            val limit = call.request.queryParameters["limit"]?.toIntOrNull() ?: 100
            call.respond(sync.pull(user.id, cursor, limit))
        }
    }
}

private fun HttpFailure.statusCode() = HttpStatusCode.fromValue(status)

private suspend inline fun <reified T> io.ktor.server.application.ApplicationCall.receiveJson(maxBytes: Int): T {
    val declared = request.headers[HttpHeaders.ContentLength]?.toLongOrNull()
    if (declared != null && declared > maxBytes) throw HttpFailure(413, "request_too_large", "Request is too large")
    val bytes = receiveChannel().readRemaining(maxBytes.toLong() + 1).readByteArray()
    if (bytes.size > maxBytes) throw HttpFailure(413, "request_too_large", "Request is too large")
    return runCatching { appJson.decodeFromString<T>(bytes.decodeToString()) }
        .getOrElse { throw HttpFailure(400, "invalid_json", "Request JSON is invalid") }
}

private fun io.ktor.server.application.ApplicationCall.bearerToken(): String? =
    request.headers[HttpHeaders.Authorization]
        ?.takeIf { it.startsWith("Bearer ", ignoreCase = true) }
        ?.substring(7)?.trim()

private fun io.ktor.server.application.ApplicationCall.clientKey(): String = request.local.remoteHost
