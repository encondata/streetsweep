package com.example.streetsweep.data.sync

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

class PortalException(message: String) : IOException(message)

/** What the server hands back when a phone signs in. */
data class DeviceSignIn(
    val token: String,
    val name: String?,
    val email: String?,
    val role: String?,
)

/**
 * Talks to the area builder's API (see `tools/`). Plain HTTP on your own network: there is no
 * authentication, so the base URL is the only thing pointing it at your server.
 */
class PortalClient(
    private val baseUrl: suspend () -> String?,
    private val token: suspend () -> String? = { null },
) {

    suspend fun areasGeoJson(): String = get("/api/areas.geojson")

    suspend fun health(): Boolean = try {
        JSONObject(get("/api/health")).optBoolean("ok")
    } catch (e: Exception) {
        false
    }

    /**
     * Same check as [health], but it lets the failure through so the person is told what
     * actually went wrong rather than a flat "no answer".
     */
    suspend fun ping(): String {
        val ok = JSONObject(get("/api/health")).optBoolean("ok")
        val where = normalise(baseUrl()) ?: throw PortalException("No server address set")
        if (!ok) throw PortalException("$where answered, but not as the area builder")
        return where
    }

    /** Sends one batch. The server takes any subset, so callers can chunk the big parts. */
    suspend fun sync(payload: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val conn = open("/api/sync")
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(payload.toString().toByteArray()) }
            JSONObject(readResponse(conn))
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Signs this phone in and comes back with a token of its own. The browser gets a
     * cookie; a phone gets a token it keeps, because it syncs in the background long
     * after anyone last looked at it. The server refuses an account that may not record.
     */
    suspend fun signInDevice(email: String, password: String, label: String): DeviceSignIn =
        withContext(Dispatchers.IO) {
            val conn = open("/api/auth/device")
            try {
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                val body = JSONObject()
                    .put("email", email.trim())
                    .put("password", password)
                    .put("label", label)
                conn.outputStream.use { it.write(body.toString().toByteArray()) }
                val json = JSONObject(readResponse(conn))
                val token = json.optString("token").takeIf { it.isNotBlank() }
                    ?: throw PortalException("The server did not send a token back")
                val user = json.optJSONObject("user")
                DeviceSignIn(
                    token = token,
                    name = user?.optString("name")?.takeIf { it.isNotBlank() },
                    email = user?.optString("email")?.takeIf { it.isNotBlank() },
                    role = user?.optString("role")?.takeIf { it.isNotBlank() },
                )
            } finally {
                conn.disconnect()
            }
        }

    suspend fun getJson(path: String): String = get(path)

    /** Sends a photo for a marked place. The server keys it by the place's own id. */
    suspend fun putPhoto(poiKey: String, bytes: ByteArray, contentType: String): Unit =
        withContext(Dispatchers.IO) {
            val conn = open("/api/pois/" + java.net.URLEncoder.encode(poiKey, "UTF-8") + "/photo")
            try {
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(bytes.size)
                conn.setRequestProperty("Content-Type", contentType)
                conn.outputStream.use { it.write(bytes) }
                readResponse(conn)
            } finally {
                conn.disconnect()
            }
        }

    private suspend fun get(path: String): String = withContext(Dispatchers.IO) {
        val conn = open(path)
        try {
            conn.requestMethod = "GET"
            readResponse(conn)
        } finally {
            conn.disconnect()
        }
    }

    private suspend fun open(path: String): HttpURLConnection {
        val base = normalise(baseUrl()) ?: throw PortalException("No server address set")
        val conn = URL(base + path).openConnection() as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 60_000
        conn.setRequestProperty("Accept", "application/json")
        token()?.takeIf { it.isNotBlank() }?.let { conn.setRequestProperty("Authorization", "Bearer $it") }
        return conn
    }

    private fun readResponse(conn: HttpURLConnection): String {
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        if (code !in 200..299) {
            // The server explains itself; say what it said. A 401 only means "rejected the
            // token" when a token was sent — on a sign-in it means the password was wrong,
            // and the old blanket wording made that impossible to tell.
            val message = runCatching { JSONObject(text).optString("error") }.getOrNull()
            throw PortalException(
                message?.takeIf { it.isNotBlank() }
                    ?: if (code == 401) "The server rejected the token" else "Server returned HTTP $code",
            )
        }
        return text
    }

    companion object {
        /** Accepts "192.168.1.5:8420" as readily as a full URL, and ignores a trailing slash. */
        fun normalise(raw: String?): String? {
            val trimmed = raw?.trim()?.trimEnd('/').orEmpty()
            if (trimmed.isEmpty()) return null
            return if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) trimmed else "http://$trimmed"
        }
    }
}
