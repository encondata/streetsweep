package net.streetsweep.data.server

import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.zip.GZIPInputStream
import kotlin.concurrent.thread

/** One request seen by [FakeServer]. */
private data class Seen(val method: String, val path: String, val auth: String?, val encoding: String?, val bytes: ByteArray)

/**
 * A throwaway HTTP server on a real socket (the unit-test classpath has no httpserver).
 * What has bitten phones before is wire-level: whether the token goes out, whether a
 * refusal comes back as a sentence, and here, whether a gzipped drive arrives intact.
 */
private class FakeServer(private val token: String) {
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
        val reader = BufferedReader(InputStreamReader(client.getInputStream(), Charsets.ISO_8859_1))
        val (method, path) = (reader.readLine() ?: return).split(" ").let { it[0] to it[1] }
        var auth: String? = null
        var encoding: String? = null
        var length = 0
        while (true) {
            val line = reader.readLine().orEmpty()
            if (line.isEmpty()) break
            val name = line.substringBefore(':').trim().lowercase()
            val value = line.substringAfter(':').trim()
            when (name) {
                "authorization" -> auth = value
                "content-length" -> length = value.toInt()
                "content-encoding" -> encoding = value
            }
        }
        // ISO-8859-1 maps each byte to one char, so binary survives the reader intact.
        val raw = CharArray(length)
        var read = 0
        while (read < length) { val n = reader.read(raw, read, length - read); if (n < 0) break; read += n }
        val bytes = ByteArray(length) { raw[it].code.toByte() }
        synchronized(seen) { seen += Seen(method, path, auth, encoding, bytes) }

        val (code, text) = when {
            path == "/api/auth/device" -> 201 to """{"token":"$token","user":{"id":"u1","display_name":"Ann","email":"ann@test.local"}}"""
            auth != "Bearer $token" -> 401 to """{"error":"Your session has ended. Sign in again."}"""
            path.startsWith("/api/sync") -> 200 to """{"cursor":"2026-10-03T20:00:00Z","full":true}"""
            path == "/api/drives" -> 201 to """{"drive":{"status":"received"}}"""
            path.endsWith("/package") -> 409 to """{"error":"Still listing its streets.","code":"not_built"}"""
            else -> 404 to """{"error":"No such thing here"}"""
        }
        val reply = text.toByteArray()
        client.getOutputStream().apply {
            write("HTTP/1.1 $code X\r\nContent-Type: application/json\r\nContent-Length: ${reply.size}\r\nConnection: close\r\n\r\n".toByteArray())
            write(reply)
            flush()
        }
    }

    fun close() = socket.close()
}

class ServerClientTest {
    private lateinit var server: FakeServer

    @Before fun start() { server = FakeServer("tok") }

    @After fun stop() = server.close()

    private fun client(token: String? = "tok") = ServerClient({ "127.0.0.1:${server.port}" }, { token })

    @Test
    fun `signing in returns the token and who it's for`() = runTest {
        val s = client(token = null).signInDevice("ann@test.local", "pw", "Pixel", "1.1")
        assertEquals("tok", s.token)
        assertEquals("u1", s.userId)
        assertNull("sign-in sends no token", server.seen.single().auth)
        val body = JSONObject(String(server.seen.single().bytes))
        assertEquals("android", body.getString("platform"))
        assertEquals("Pixel", body.getString("deviceName"))
    }

    @Test
    fun `the token goes out as a bearer header`() = runTest {
        client().sync(null)
        assertEquals("Bearer tok", server.seen.single().auth)
        assertEquals("/api/sync", server.seen.single().path)
    }

    @Test
    fun `a cursor is sent url-encoded`() = runTest {
        client().sync("2026-10-03T20:00:00.000Z")
        assertEquals("/api/sync?since=2026-10-03T20%3A00%3A00.000Z", server.seen.single().path)
    }

    @Test
    fun `a refused token means signed out, in the server's words`() = runTest {
        val failure = runCatching { client(token = "revoked").sync(null) }.exceptionOrNull()
        assertTrue("expected SignedOutException, got $failure", failure is SignedOutException)
        assertEquals("Your session has ended. Sign in again.", failure!!.message)
    }

    @Test
    fun `no token at all fails before asking`() = runTest {
        val failure = runCatching { client(token = null).sync(null) }.exceptionOrNull()
        assertTrue(failure is SignedOutException)
        assertTrue("nothing should have been sent", server.seen.isEmpty())
    }

    @Test
    fun `a drive goes up gzipped and arrives whole`() = runTest {
        val points = org.json.JSONArray().put(org.json.JSONArray().put(1.0).put(30.0).put(-97.0))
        client().uploadDrive(JSONObject().put("id", "d1").put("points", points))
        val seen = server.seen.single()
        assertEquals("gzip", seen.encoding)
        val unpacked = GZIPInputStream(seen.bytes.inputStream()).bufferedReader().readText()
        assertEquals("d1", JSONObject(unpacked).getString("id"))
    }

    @Test
    fun `a server code comes through with the message`() = runTest {
        val failure = runCatching { client().areaPackage("a1", null) }.exceptionOrNull()
        assertTrue(failure is ServerException)
        assertEquals("not_built", (failure as ServerException).code)
        assertEquals(409, failure.status)
    }

    @Test
    fun `addresses are understood the way people type them`() {
        assertEquals("https://streetsweep.net", ServerClient.normalise("streetsweep.net/"))
        assertEquals("http://10.0.2.2:8430", ServerClient.normalise("10.0.2.2:8430"))
        assertEquals("http://example.org", ServerClient.normalise("http://example.org"))
        assertNull(ServerClient.normalise("  "))
    }
}

class SegmentsTest {
    @Test
    fun `package rows read with their inside length, box rows without`() {
        // Two points 0.001° of latitude apart, as a precision-6 encoded polyline.
        val line = "_w`fx@~bl_xDo}@?"
        val pkg = JSONObject("""{"names":["Avenue F"],"highways":["residential"],"segments":[[11,7,0,0,111.2,55.6,"$line"],[12,7,-1,0,50.0,50.0,"$line"]]}""")
        val segs = Segments.parse(pkg)
        assertEquals(2, segs.size)
        assertEquals("Avenue F", segs[0].name)
        assertNull("no name index means unnamed", segs[1].name)
        assertEquals(55.6, segs[0].insideMeters!!, 1e-9)
        assertEquals(7L, segs[0].wayId)
        assertEquals(2, segs[0].shape.size)

        val box = JSONObject("""{"names":[],"highways":["primary"],"segments":[[13,8,-1,0,20.0,"$line"]]}""")
        val b = Segments.parse(box).single()
        assertNull(b.insideMeters)
        assertEquals("primary", b.highway)
    }
}
