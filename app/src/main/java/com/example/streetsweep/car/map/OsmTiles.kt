package com.example.streetsweep.car.map

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import android.util.LruCache
import com.example.streetsweep.data.osm.ValhallaClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Standard 256 px OpenStreetMap raster tiles for the car screen, cached in memory and on disk.
 * Tile usage policy: identify the app, cache aggressively, at most two parallel downloads.
 */
class OsmTiles(
    context: Context,
    private val scope: CoroutineScope,
    private val onTileLoaded: () -> Unit,
) {
    data class Key(val zoom: Int, val x: Int, val y: Int) {
        val fileName get() = "$zoom-$x-$y.png"
    }

    private val diskDir = File(context.cacheDir, "car_tiles").apply { mkdirs() }
    private val memory = object : LruCache<Key, Bitmap>(MEMORY_BUDGET_BYTES) {
        override fun sizeOf(key: Key, value: Bitmap) = value.byteCount
    }
    private val inFlight = HashSet<Key>()
    private val failed = HashMap<Key, Long>()
    private val slots = Semaphore(2)

    /** Returns the cached bitmap, or null and schedules a fetch. */
    @Synchronized
    fun get(key: Key): Bitmap? {
        memory.get(key)?.let { return it }
        if (key in inFlight) return null
        failed[key]?.let { if (System.currentTimeMillis() - it < RETRY_AFTER_MS) return null }
        inFlight += key
        scope.launch(Dispatchers.IO) { fetch(key) }
        return null
    }

    private suspend fun fetch(key: Key) {
        try {
            val file = File(diskDir, key.fileName)
            val bytes = if (file.exists()) file.readBytes() else slots.withPermit { download(key) }?.also { file.writeBytes(it) }
            val bitmap = bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
            if (bitmap == null) {
                file.delete()
                synchronized(this) { failed[key] = System.currentTimeMillis() }
                return
            }
            synchronized(this) { memory.put(key, bitmap) }
            onTileLoaded()
        } catch (e: Exception) {
            Log.w(TAG, "Tile $key failed: ${e.message}")
            synchronized(this) { failed[key] = System.currentTimeMillis() }
        } finally {
            synchronized(this) { inFlight -= key }
        }
    }

    private fun download(key: Key): ByteArray? {
        val conn = URL("$TILE_URL/${key.zoom}/${key.x}/${key.y}.png").openConnection() as HttpURLConnection
        return try {
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            conn.setRequestProperty("User-Agent", ValhallaClient.USER_AGENT)
            if (conn.responseCode !in 200..299) null else conn.inputStream.use { it.readBytes() }
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        private const val TAG = "OsmTiles"
        const val TILE_URL = "https://tile.openstreetmap.org"
        const val TILE_PX = 256
        const val MAX_ZOOM = 19
        private const val MEMORY_BUDGET_BYTES = 32 * 1024 * 1024
        private const val RETRY_AFTER_MS = 30_000L
    }
}
