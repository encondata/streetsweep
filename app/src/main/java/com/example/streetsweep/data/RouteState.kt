package com.example.streetsweep.data

import com.example.streetsweep.domain.RoutePlan
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The route currently being followed, held for the life of the process.
 *
 * It lives here rather than in a screen so the phone and the car screen point at the same
 * one: plan on the phone before setting off, and the head unit picks it up. It is not
 * written to disk, because a plan goes stale the moment you drive part of it, and working
 * a fresh one out takes well under a second.
 */
class RouteState {
    private val _plan = MutableStateFlow<Planned?>(null)
    val plan: StateFlow<Planned?> = _plan.asStateFlow()

    /** A plan, and the area it was worked out for. */
    data class Planned(val areaId: Long, val areaName: String, val route: RoutePlan)

    fun set(areaId: Long, areaName: String, route: RoutePlan) {
        _plan.value = Planned(areaId, areaName, route)
    }

    fun clear() {
        _plan.value = null
    }

    /** Drops the plan when it was worked out for somewhere you are no longer sweeping. */
    fun clearIfNot(areaId: Long?) {
        if (_plan.value?.areaId != areaId) clear()
    }
}
