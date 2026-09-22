package com.example.streetsweep.tracking

import com.example.streetsweep.domain.LatLngPoint
import com.example.streetsweep.domain.TriggerSource
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

sealed interface TrackingStatus {
    data object Idle : TrackingStatus

    data class Recording(
        val sessionId: Long,
        val trigger: TriggerSource,
        val startedAt: Long,
        val pointCount: Int = 0,
        val distanceMeters: Double = 0.0,
        val skippedTooClose: Int = 0,
        val skippedInaccurate: Int = 0,
        val lastFixAt: Long? = null,
        val lastPoint: LatLngPoint? = null,
        /** Non-null while an automatic trigger has disconnected and the grace timer is running. */
        val stopScheduledAt: Long? = null,
    ) : TrackingStatus
}

/**
 * Live tracking state shared between [TrackingService], receivers and the UI.
 * Lives in-process: if the service is running, the process is alive and this is accurate.
 */
object TrackingStateHolder {
    private val _status = MutableStateFlow<TrackingStatus>(TrackingStatus.Idle)
    val status: StateFlow<TrackingStatus> = _status.asStateFlow()

    val isRecording: Boolean get() = _status.value is TrackingStatus.Recording

    fun set(status: TrackingStatus) {
        _status.value = status
    }

    fun updateRecording(block: (TrackingStatus.Recording) -> TrackingStatus.Recording) {
        _status.update { current -> if (current is TrackingStatus.Recording) block(current) else current }
    }
}
