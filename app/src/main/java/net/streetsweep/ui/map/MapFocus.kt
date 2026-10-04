package net.streetsweep.ui.map

import net.streetsweep.domain.Bounds
import kotlinx.coroutines.flow.MutableStateFlow

/** One-shot requests from other screens to the main map. */
object MapFocus {
    val pending = MutableStateFlow<Bounds?>(null)

    fun request(b: Bounds) { pending.value = b }
    fun consume(): Bounds? = pending.value.also { pending.value = null }
}
