package com.tunka.note.server

import com.tunka.note.shared.AuthRequest
import com.tunka.note.shared.AuthResponse
import com.tunka.note.shared.NoteIds
import com.tunka.note.shared.User
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Duration
import java.time.Instant
import java.util.Base64
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

private const val PBKDF2_ITERATIONS = 600_000
private const val HASH_BITS = 256
private const val SALT_BYTES = 16
private const val SESSION_DAYS = 30L

data class AuthFailure(val status: Int, val code: String, override val message: String) : RuntimeException(message)

private data class PasswordHash(val salt: String, val hash: String)

private data class StoredCredentials(
    val id: String,
    val identifier: String,
    val salt: String,
    val hash: String,
)

private object Passwords {
    const val DUMMY_SALT = "AAAAAAAAAAAAAAAAAAAAAA"
    private val random = SecureRandom()

    fun validate(password: String) {
        if (password.length !in 12..128) throw AuthFailure(400, "invalid_password", "Password must be 12 to 128 characters")
    }

    fun hash(password: String): PasswordHash {
        val saltBytes = ByteArray(SALT_BYTES).also(random::nextBytes)
        return PasswordHash(
            Base64.getUrlEncoder().withoutPadding().encodeToString(saltBytes),
            derive(password, saltBytes),
        )
    }

    fun verify(password: String, salt: String, expected: String): Boolean {
        val saltBytes = runCatching { Base64.getUrlDecoder().decode(salt) }.getOrNull() ?: return false
        val actual = derive(password, saltBytes)
        return MessageDigest.isEqual(
            Base64.getUrlDecoder().decode(actual),
            runCatching { Base64.getUrlDecoder().decode(expected) }.getOrDefault(ByteArray(0)),
        )
    }

    private fun derive(password: String, salt: ByteArray): String {
        val spec = PBEKeySpec(password.toCharArray(), salt, PBKDF2_ITERATIONS, HASH_BITS)
        return try {
            val bytes = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
            Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        } finally {
            spec.clearPassword()
        }
    }
}

private class LoginRateLimiter(
    private val window: Duration = Duration.ofMinutes(1),
    private val maxAttempts: Int = 10,
) {
    private data class Bucket(var startedAt: Long, var count: Int)
    private val buckets = HashMap<String, Bucket>()

    @Synchronized
    fun allow(key: String, now: Long = System.currentTimeMillis()): Boolean {
        val current = buckets[key]
        if (current == null || now - current.startedAt >= window.toMillis()) {
            if (current == null && buckets.size >= MAX_BUCKETS) {
                buckets.entries.minByOrNull { it.value.startedAt }?.key?.let(buckets::remove)
            }
            buckets[key] = Bucket(now, 1)
            buckets.entries.removeIf { now - it.value.startedAt >= window.toMillis() && it.key != key }
            return true
        }
        if (current.count >= maxAttempts) return false
        current.count++
        return true
    }

    private companion object { const val MAX_BUCKETS = 10_000 }
}

class AuthService(private val database: ServerDatabase) {
    private val clientLimiter = LoginRateLimiter(maxAttempts = 20)
    private val identifierLimiter = LoginRateLimiter()
    private val random = SecureRandom()

    fun register(request: AuthRequest, clientKey: String): AuthResponse {
        val identifier = normalizeIdentifier(request.identifier)
        Passwords.validate(request.password)
        if (!clientLimiter.allow("register-client:$clientKey") ||
            !identifierLimiter.allow("register-identifier:$identifier")
        ) throw AuthFailure(429, "rate_limited", "Too many attempts")
        val hash = Passwords.hash(request.password)
        return database.transaction { connection ->
            val id = NoteIds.newId()
            try {
                connection.prepareStatement(
                    "INSERT INTO users(id, identifier, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
                ).use { statement ->
                    statement.setString(1, id)
                    statement.setString(2, identifier)
                    statement.setString(3, hash.salt)
                    statement.setString(4, hash.hash)
                    statement.setString(5, Instant.now().toString())
                    statement.executeUpdate()
                }
            } catch (error: java.sql.SQLException) {
                if (error.message?.contains("UNIQUE", ignoreCase = true) == true) {
                    throw AuthFailure(409, "identifier_unavailable", "This identifier is already registered")
                }
                throw error
            }
            issueSession(connection, id, identifier)
        }
    }

    fun login(request: AuthRequest, clientKey: String): AuthResponse {
        val identifier = normalizeIdentifier(request.identifier)
        if (request.password.length !in 1..128) throw AuthFailure(401, "invalid_credentials", "Invalid credentials")
        if (!clientLimiter.allow("login-client:$clientKey") ||
            !identifierLimiter.allow("login-identifier:$identifier")
        ) throw AuthFailure(429, "rate_limited", "Too many attempts")
        val credentials = database.transaction { connection ->
            connection.prepareStatement(
                "SELECT id, identifier, salt, password_hash FROM users WHERE identifier = ?",
            ).use { statement ->
                statement.setString(1, identifier)
                statement.executeQuery().use { rows ->
                    if (!rows.next()) null else StoredCredentials(
                        id = rows.getString("id"),
                        identifier = rows.getString("identifier"),
                        salt = rows.getString("salt"),
                        hash = rows.getString("password_hash"),
                    )
                }
            }
        }
        // PBKDF2 is intentionally outside the database transaction. A slow
        // password check must not block note reads or writes behind the SQLite
        // writer lock.
        val passwordMatches = if (credentials == null) {
            // Keep unknown-user and wrong-password work approximately equal.
            Passwords.verify(request.password, Passwords.DUMMY_SALT, "")
        } else {
            Passwords.verify(request.password, credentials.salt, credentials.hash)
        }
        if (!passwordMatches || credentials == null) {
            throw AuthFailure(401, "invalid_credentials", "Invalid credentials")
        }
        return database.transaction { connection -> issueSession(connection, credentials.id, credentials.identifier) }
    }

    fun authenticate(token: String?): SessionUser {
        if (token.isNullOrBlank() || token.length > 256) throw AuthFailure(401, "unauthorized", "Authentication required")
        val tokenHash = token.sha256Base64()
        return database.transaction { connection ->
            connection.prepareStatement(
                "SELECT users.id, users.identifier, sessions.expires_at, sessions.revoked_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?",
            ).use { statement ->
                statement.setString(1, tokenHash)
                statement.executeQuery().use { rows ->
                    if (!rows.next() || rows.getString("revoked_at") != null || Instant.parse(rows.getString("expires_at")).isBefore(Instant.now())) {
                        throw AuthFailure(401, "unauthorized", "Authentication required")
                    }
                    SessionUser(rows.getString("id"), rows.getString("identifier"))
                }
            }
        }
    }

    fun logout(token: String?) {
        if (token.isNullOrBlank() || token.length > 256) return
        database.transaction { connection ->
            connection.prepareStatement("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?").use { statement ->
                statement.setString(1, Instant.now().toString())
                statement.setString(2, token.sha256Base64())
                statement.executeUpdate()
            }
        }
    }

    private fun issueSession(connection: java.sql.Connection, userId: String, identifier: String): AuthResponse {
        val raw = ByteArray(32).also(random::nextBytes)
        val token = Base64.getUrlEncoder().withoutPadding().encodeToString(raw)
        val expires = Instant.now().plus(Duration.ofDays(SESSION_DAYS))
        connection.prepareStatement(
            "INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        ).use { statement ->
            statement.setString(1, token.sha256Base64())
            statement.setString(2, userId)
            statement.setString(3, Instant.now().toString())
            statement.setString(4, expires.toString())
            statement.executeUpdate()
        }
        return AuthResponse(User(userId, identifier), token, expires.toString())
    }

    private fun normalizeIdentifier(identifier: String): String {
        val value = identifier.trim().lowercase()
        if (value.length !in 3..254 || value.any { it.isWhitespace() || it.code < 0x21 }) {
            throw AuthFailure(400, "invalid_identifier", "Identifier is invalid")
        }
        return value
    }
}
