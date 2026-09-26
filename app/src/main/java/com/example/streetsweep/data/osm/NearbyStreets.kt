package com.example.streetsweep.data.osm

import android.content.Context
import com.example.streetsweep.appContainer
import com.example.streetsweep.domain.Bounds
import com.example.streetsweep.domain.ChunkGrid
import com.example.streetsweep.domain.LatLngPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Loads streets for areas too big to download whole (a metro): the cells round the car
 * while a drive records, and the cells of the map on screen, from the server, as needed.
 * Only cells some on-demand area covers, and only ones not already held and fresh.
 */
object NearbyStreets {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var lastCell: String? = null
    @Volatile private var lastView: String? = null

    /** A fix while driving. Nothing happens until the car moves into another cell. */
    fun near(context: Context, p: LatLngPoint) {
        val key = ChunkGrid.cellAt(p).key
        if (key == lastCell) return
        lastCell = key
        request(context.applicationContext, ChunkGrid.around(p))
    }

    /** The map settled on a view. Zoomed out further than this, a screen is too many cells. */
    fun inView(context: Context, b: Bounds, zoom: Double) {
        if (zoom < MIN_ZOOM) return
        val cells = ChunkGrid.cellsFor(b)
        if (cells.size > MAX_VIEW_CELLS) return
        val key = cells.joinToString(",") { it.key }
        if (key == lastView) return
        lastView = key
        request(context.applicationContext, cells)
    }

    private fun request(context: Context, cells: List<ChunkGrid.Cell>) = scope.launch {
        val container = context.appContainer
        val s = container.settings.current()
        if (s.portalUrl.isNullOrBlank() || s.portalToken.isNullOrBlank()) return@launch
        val areas = container.coverageRepository.onDemandAreas()
        if (areas.isEmpty()) return@launch
        val wanted = cells.filter { c -> areas.any { it.bounds.intersects(c.bounds) } }.map { it.key }
        if (wanted.isEmpty()) return@launch
        val freshAfter = System.currentTimeMillis() - StreetDownloadWorker.CHUNK_TTL_MS
        val held = container.coverageRepository.freshChunkKeys(wanted, freshAfter).toSet()
        val missing = wanted.filter { it !in held }
        if (missing.isNotEmpty()) StreetDownloadWorker.enqueueCells(context, missing)
    }

    private const val MIN_ZOOM = 13.0
    private const val MAX_VIEW_CELLS = 12
}
