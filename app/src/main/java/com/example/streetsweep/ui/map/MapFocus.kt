package com.example.streetsweep.ui.map

import com.example.streetsweep.domain.Bounds
import com.example.streetsweep.domain.LatLngPoint
import kotlinx.coroutines.flow.MutableStateFlow

/** Request from another screen to redraw an existing area's outline on the main map. */
data class RedrawRequest(val areaId: Long, val name: String, val vertices: List<LatLngPoint>)

/** One-shot requests from other screens to the main map. */
object MapFocus {
    val pending = MutableStateFlow<Bounds?>(null)
    val redraw = MutableStateFlow<RedrawRequest?>(null)

    fun request(b: Bounds) { pending.value = b }
    fun consume(): Bounds? = pending.value.also { pending.value = null }

    fun requestRedraw(r: RedrawRequest) { redraw.value = r; pending.value = Bounds.of(r.vertices) }
    fun consumeRedraw(): RedrawRequest? = redraw.value.also { redraw.value = null }
}
