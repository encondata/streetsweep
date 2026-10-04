package net.streetsweep.data.server

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream

/** The server said no, in words meant for people ([message] is shown as is). */
open class ServerException(message: String, val status: Int = 0, val code: String? = null) : IOException(message)

/** The token was refused: revoked on the web, or the account changed. Sign in again. */
class SignedOutException(message: String) : ServerException(message, 401)

data class DeviceSignIn(val token: String, val userId: String, val name: String, val email: String)

/** An area's streets, or null when unchanged since [etag]. */
data class StreetPackage(val body: JSONObject?, val etag: String?)

/**
 * The v2 server's API, as the phone uses it (v2/docs/APP-API.md). Plain HttpURLConnection
 * and org.json, like the rest of the app. Every call but sign-in carries the device token.
 */
class ServerClient(
    private val baseUrl: suspend () -> String?,
    private val token: suspend () -> String?,
) {
    suspend fun signInDevice(email: String, password: String, deviceName: String, appVersion: String): DeviceSignIn {
        val body = JSONObject().put("email", email.trim()).put("password", password)
            .put("deviceName", deviceName.take(60)).put("platform", "android").put("appVersion", appVersion.take(40))
        val json = JSONObject(request("POST", "/api/auth/device", body.toString().toByteArray(), auth = false))
        val user = json.getJSONObject("user")
        return DeviceSignIn(json.getString("token"), user.getString("id"), user.optString("display_name"), user.optString("email"))
    }

    suspend fun sync(since: String?): JSONObject =
        JSONObject(request("GET", "/api/sync" + (since?.let { "?since=" + enc(it) } ?: "")))

    suspend fun area(id: String): JSONObject = JSONObject(request("GET", "/api/areas/" + enc(id))).getJSONObject("area")

    /** 409 (not built yet) and 413 (too big) come back as [ServerException] with their code. */
    suspend fun areaPackage(id: String, etag: String?): StreetPackage = withContext(Dispatchers.IO) {
        val conn = open("GET", "/api/areas/" + enc(id) + "/package", auth = true)
        try {
            conn.readTimeout = 180_000
            etag?.let { conn.setRequestProperty("If-None-Match", it) }
            if (conn.responseCode == 304) return@withContext StreetPackage(null, etag)
            StreetPackage(JSONObject(read(conn)), conn.getHeaderField("ETag"))
        } finally {
            conn.disconnect()
        }
    }

    suspend fun segmentsInBox(west: Double, south: Double, east: Double, north: Double): JSONObject =
        JSONObject(request("GET", "/api/segments?bbox=$west,$south,$east,$north"))

    /** Gzipped: a long drive is a few megabytes of JSON. 201 new, 200 already there. */
    suspend fun uploadDrive(body: JSONObject): JSONObject =
        JSONObject(request("POST", "/api/drives", gzip(body.toString().toByteArray()), gzip = true))

    suspend fun deleteDrive(id: String) {
        try {
            request("DELETE", "/api/drives/" + enc(id))
        } catch (e: ServerException) {
            if (e.status != 404) throw e // already gone
        }
    }

    suspend fun putMark(teamId: String, segmentId: Long, kind: String, note: String?) {
        request("PUT", "/api/teams/${enc(teamId)}/marks/$segmentId", JSONObject().put("kind", kind).put("note", note ?: JSONObject.NULL).toString().toByteArray())
    }

    suspend fun deleteMark(teamId: String, segmentId: Long) {
        try {
            request("DELETE", "/api/teams/${enc(teamId)}/marks/$segmentId")
        } catch (e: ServerException) {
            if (e.status != 404) throw e // wasn't marked: the same outcome
        }
    }

    suspend fun createPlace(body: JSONObject): JSONObject =
        JSONObject(request("POST", "/api/places", body.toString().toByteArray())).getJSONObject("place")

    suspend fun updatePlace(id: String, body: JSONObject): JSONObject =
        JSONObject(request("PATCH", "/api/places/" + enc(id), body.toString().toByteArray())).getJSONObject("place")

    suspend fun deletePlace(id: String) {
        try {
            request("DELETE", "/api/places/" + enc(id))
        } catch (e: ServerException) {
            if (e.status != 404) throw e
        }
    }

    suspend fun uploadPlacePhoto(id: String, jpeg: ByteArray, width: Int, height: Int): JSONObject =
        JSONObject(request("POST", "/api/places/${enc(id)}/photos?w=$width&h=$height", jpeg, contentType = "image/jpeg")).getJSONObject("place")

    /** A photo's bytes, for a place someone else shared or one added on the web. */
    suspend fun placePhoto(placeId: String, photoId: String): ByteArray = withContext(Dispatchers.IO) {
        val conn = open("GET", "/api/places/${enc(placeId)}/photos/${enc(photoId)}", auth = true)
        try {
            if (conn.responseCode !in 200..299) read(conn)
            conn.inputStream.use { it.readBytes() }
        } finally {
            conn.disconnect()
        }
    }

    suspend fun stats(): JSONObject = JSONObject(request("GET", "/api/stats"))

    suspend fun checkout(vehicleId: String) {
        request("POST", "/api/vehicles/${enc(vehicleId)}/checkout", "{}".toByteArray())
    }

    suspend fun returnVehicle(vehicleId: String) {
        request("POST", "/api/vehicles/${enc(vehicleId)}/return", "{}".toByteArray())
    }

    // ---- plumbing ----

    private suspend fun request(
        method: String, path: String, body: ByteArray? = null, auth: Boolean = true,
        gzip: Boolean = false, contentType: String = "application/json",
    ): String = withContext(Dispatchers.IO) {
        val conn = open(method, path, auth)
        try {
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", contentType)
                if (gzip) conn.setRequestProperty("Content-Encoding", "gzip")
                conn.setFixedLengthStreamingMode(body.size)
                conn.outputStream.use { it.write(body) }
            }
            read(conn)
        } finally {
            conn.disconnect()
        }
    }

    private suspend fun open(method: String, path: String, auth: Boolean): HttpURLConnection {
        val base = normalise(baseUrl()) ?: throw ServerException("No server address set")
        val conn = URL(base + path).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 15_000
        conn.readTimeout = 60_000
        conn.setRequestProperty("Accept", "application/json")
        if (auth) {
            val t = token()?.takeIf { it.isNotBlank() } ?: throw SignedOutException("Sign in first.")
            conn.setRequestProperty("Authorization", "Bearer $t")
        }
        return conn
    }

    private fun read(conn: HttpURLConnection): String {
        val status = conn.responseCode
        val raw: InputStream? = if (status in 200..299) conn.inputStream else conn.errorStream
        // The server gzips packages whether asked or not; unpack unless the stack already did.
        val stream = if (raw != null && conn.contentEncoding.equals("gzip", ignoreCase = true)) GZIPInputStream(raw) else raw
        val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        if (status in 200..299) return text
        val json = runCatching { JSONObject(text) }.getOrNull()
        val message = json?.optString("error")?.takeIf { it.isNotBlank() } ?: "The server answered $status."
        if (status == 401) throw SignedOutException(message)
        throw ServerException(message, status, json?.optString("code")?.takeIf { it.isNotBlank() })
    }

    private fun gzip(bytes: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(bytes.size / 4 + 64)
        GZIPOutputStream(out).use { it.write(bytes) }
        return out.toByteArray()
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    companion object {
        const val DEFAULT_URL = "https://streetsweep.net"
        const val USER_AGENT = "StreetSweep/1.0 (personal street-coverage app)"

        /** "streetsweep.net" or "10.0.2.2:8430" as readily as a full URL; no trailing slash. */
        fun normalise(raw: String?): String? {
            val t = raw?.trim()?.trimEnd('/').orEmpty()
            if (t.isEmpty()) return null
            if (t.startsWith("http://") || t.startsWith("https://")) return t
            // A bare name with no port is a real server: HTTPS. An address with a port is a
            // development box on your own network: plain HTTP.
            return if (t.contains(':')) "http://$t" else "https://$t"
        }

        fun ids(a: JSONArray?): List<String> = a?.let { arr -> (0 until arr.length()).map { arr.getString(it) } }.orEmpty()
    }
}
