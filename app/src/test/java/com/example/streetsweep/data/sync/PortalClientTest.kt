package com.example.streetsweep.data.sync

import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread

/** One request seen by [FakePortal]. */
private data class Seen(
    val method: String,
    val path: String,
    val auth: String?,
    val body: String,
    val contentType: String? = null,
    val bytes: ByteArray = ByteArray(0),
)

/**
 * A throwaway HTTP server on a real socket. The Android unit-test classpath has no
 * com.sun.net.httpserver, and the things that have actually bitten us here are wire-level:
 * whether the token really goes out, and whether a rejection comes back as a usable sentence.
 */
private class FakePortal(private val expectedToken: String) {
    private val socket = ServerSocket(0, 4, java.net.InetAddress.getByName("127.0.0.1"))
    val port: Int get() = socket.localPort
    val seen = mutableListOf<Seen>()
    /** Refuse with an empty body, the way a proxy in front might. */
    var silentRefusal = false
    private val ready = CountDownLatch(1)

    init {
        thread(isDaemon = true) {
            ready.countDown()
            while (!socket.isClosed) {
                val client = try { socket.accept() } catch (e: Exception) { break }
                client.use { handle(it) }
            }
        }
        ready.await()
    }

    private fun readFully(reader: java.io.Reader, into: CharArray) {
        var read = 0
        while (read < into.size) {
            val n = reader.read(into, read, into.size - read)
            if (n < 0) break
            read += n
        }
    }

    private fun handle(client: java.net.Socket) {
        val reader = BufferedReader(InputStreamReader(client.getInputStream(), Charsets.ISO_8859_1))
        val request = reader.readLine() ?: return
        val (method, path) = request.split(" ").let { it[0] to it[1] }
        var auth: String? = null
        var contentType: String? = null
        var length = 0
        while (true) {
            val line = reader.readLine().orEmpty()
            if (line.isEmpty()) break
            val name = line.substringBefore(':').trim().lowercase()
            val value = line.substringAfter(':').trim()
            if (name == "authorization") auth = value
            if (name == "content-length") length = value.toInt()
            if (name == "content-type") contentType = value
        }
        // ISO-8859-1 maps each byte to one char, so binary survives the reader intact.
        val raw = CharArray(length).also { if (length > 0) readFully(reader, it) }
        val bytes = ByteArray(length) { raw[it].code.toByte() }
        val body = String(bytes, Charsets.UTF_8)
        synchronized(seen) { seen += Seen(method, path, auth, body, contentType, bytes) }

        val (code, text) = when {
            auth != "Bearer $expectedToken" ->
                401 to if (silentRefusal) "" else """{"error":"A token is required","needsToken":true}"""
            path == "/api/health" -> 200 to """{"ok":true}"""
            path == "/api/sync" -> 200 to """{"ok":true}"""
            path.endsWith("/photo") -> 200 to """{"ok":true}"""
            path == "/api/pois" -> 200 to POIS
            else -> 404 to """{"error":"No such thing here"}"""
        }
        val reply = text.toByteArray()
        client.getOutputStream().apply {
            write(
                ("HTTP/1.1 $code X\r\nContent-Type: application/json\r\n" +
                    "Content-Length: ${reply.size}\r\nConnection: close\r\n\r\n").toByteArray()
            )
            write(reply)
            flush()
        }
    }

    fun close() = socket.close()
}

private const val POIS = """{"pois":[{"id":"1:2.0:3.0","lat":2.0,"lng":3.0,"name":"Edited on the web","note":"n","hasPhoto":false,"at":1,"updatedAt":99}]}"""

class PortalClientTest {

    private lateinit var portal: FakePortal

    @Before fun start() { portal = FakePortal("right-token") }

    @After fun stop() = portal.close()

    private fun client(token: String? = "right-token") =
        PortalClient(baseUrl = { "127.0.0.1:${portal.port}" }, token = { token })

    @Test
    fun `a bare host and port is reached over plain http`() = runTest {
        assertEquals("http://127.0.0.1:${portal.port}", client().ping())
    }

    @Test
    fun `the token is sent as a bearer header`() = runTest {
        client().ping()
        assertEquals("Bearer right-token", portal.seen.single().auth)
        assertEquals("/api/health", portal.seen.single().path)
    }

    /**
     * The server explains itself, so say what it said. A 401 only means "rejected the
     * token" when a token was sent; on a sign-in it means the password was wrong, and
     * one blanket sentence made the two impossible to tell apart.
     */
    @Test
    fun `a refusal is reported in the server's own words`() = runTest {
        val failure = runCatching { client(token = "wrong-token").ping() }.exceptionOrNull()
        assertTrue("expected a PortalException, got $failure", failure is PortalException)
        assertEquals("A token is required", failure!!.message)
    }

    /** With nothing to quote, it falls back to wording that at least names the cause. */
    @Test
    fun `a silent refusal still reads as a rejected token`() = runTest {
        portal.silentRefusal = true
        val failure = runCatching { client(token = "wrong-token").ping() }.exceptionOrNull()
        assertEquals("The server rejected the token", failure?.message)
    }

    @Test
    fun `a blank address is refused before any request`() = runTest {
        val failure = runCatching { PortalClient({ "  " }, { null }).ping() }.exceptionOrNull()
        assertEquals("No server address set", failure?.message)
        assertTrue(portal.seen.isEmpty())
    }

    @Test
    fun `sync posts the payload it was given`() = runTest {
        client().sync(JSONObject().put("resetEdges", true).put("areas", JSONArray()))
        val call = portal.seen.single()
        assertEquals("POST", call.method)
        assertEquals("/api/sync", call.path)
        assertTrue(JSONObject(call.body).getBoolean("resetEdges"))
    }

    @Test
    fun `a photo is posted as its own bytes, under the place's key`() = runTest {
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte(), 0, 16, 7, 42, 0xFF.toByte(), 0xD9.toByte())
        client().putPhoto("1790091275362:30.404337:-95.635470", jpeg, "image/jpeg")

        val call = portal.seen.single()
        assertEquals("POST", call.method)
        // The key has colons in it, which have to survive as part of one path segment.
        assertEquals("/api/pois/1790091275362%3A30.404337%3A-95.635470/photo", call.path)
        assertEquals("image/jpeg", call.contentType)
        assertEquals("Bearer right-token", call.auth)
        assertArrayEquals("the photo should arrive byte for byte", jpeg, call.bytes)
    }

    @Test
    fun `a rejected photo upload is reported rather than silently dropped`() = runTest {
        val failure = runCatching {
            client(token = "wrong-token").putPhoto("k", byteArrayOf(1, 2, 3), "image/jpeg")
        }.exceptionOrNull()
        assertTrue("expected a PortalException, got $failure", failure is PortalException)
    }

    @Test
    fun `the places the server holds can be read back`() = runTest {
        val body = client().getJson("/api/pois")
        val rows = JSONObject(body).getJSONArray("pois")
        assertEquals(1, rows.length())
        assertEquals("Edited on the web", rows.getJSONObject(0).getString("name"))
    }

    @Test
    fun `addresses are normalised the way people type them`() {
        assertEquals("https://streetsweep.hackspacelabs.com", PortalClient.normalise("https://streetsweep.hackspacelabs.com/"))
        assertEquals("http://192.168.1.5:8420", PortalClient.normalise(" 192.168.1.5:8420 "))
        assertEquals(null, PortalClient.normalise(null))
        assertEquals(null, PortalClient.normalise("   "))
    }
}
