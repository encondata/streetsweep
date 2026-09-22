package com.example.streetsweep.data.sync

import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
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
private data class Seen(val method: String, val path: String, val auth: String?, val body: String)

/**
 * A throwaway HTTP server on a real socket. The Android unit-test classpath has no
 * com.sun.net.httpserver, and the things that have actually bitten us here are wire-level:
 * whether the token really goes out, and whether a rejection comes back as a usable sentence.
 */
private class FakePortal(private val expectedToken: String) {
    private val socket = ServerSocket(0, 4, java.net.InetAddress.getByName("127.0.0.1"))
    val port: Int get() = socket.localPort
    val seen = mutableListOf<Seen>()
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

    private fun handle(client: java.net.Socket) {
        val reader = BufferedReader(InputStreamReader(client.getInputStream()))
        val request = reader.readLine() ?: return
        val (method, path) = request.split(" ").let { it[0] to it[1] }
        var auth: String? = null
        var length = 0
        while (true) {
            val line = reader.readLine().orEmpty()
            if (line.isEmpty()) break
            val name = line.substringBefore(':').trim().lowercase()
            val value = line.substringAfter(':').trim()
            if (name == "authorization") auth = value
            if (name == "content-length") length = value.toInt()
        }
        val body = CharArray(length).also { if (length > 0) reader.read(it, 0, length) }.concatToString()
        synchronized(seen) { seen += Seen(method, path, auth, body) }

        val (code, text) = when {
            auth != "Bearer $expectedToken" -> 401 to """{"error":"A token is required","needsToken":true}"""
            path == "/api/health" -> 200 to """{"ok":true}"""
            path == "/api/sync" -> 200 to """{"ok":true}"""
            else -> 404 to """{"error":"No such thing here"}"""
        }
        val bytes = text.toByteArray()
        client.getOutputStream().apply {
            write(
                ("HTTP/1.1 $code X\r\nContent-Type: application/json\r\n" +
                    "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray()
            )
            write(bytes)
            flush()
        }
    }

    fun close() = socket.close()
}

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

    @Test
    fun `a rejected token is reported in plain words`() = runTest {
        val failure = runCatching { client(token = "wrong-token").ping() }.exceptionOrNull()
        assertTrue("expected a PortalException, got $failure", failure is PortalException)
        assertEquals("The server rejected the token", failure!!.message)
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
    fun `addresses are normalised the way people type them`() {
        assertEquals("https://streetsweep.hackspacelabs.com", PortalClient.normalise("https://streetsweep.hackspacelabs.com/"))
        assertEquals("http://192.168.1.5:8420", PortalClient.normalise(" 192.168.1.5:8420 "))
        assertEquals(null, PortalClient.normalise(null))
        assertEquals(null, PortalClient.normalise("   "))
    }
}
