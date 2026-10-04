package net.streetsweep.tracking

import net.streetsweep.domain.LatLngPoint
import net.streetsweep.domain.TriggerSource
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
        /**
         * When the drive was paused, or null while it is running. The session stays open:
         * pausing is for nipping into a shop without turning one drive into two.
         */
        val pausedAt: Long? = null,
        /**
         * Set while no fix at all has reached the app for a while — indoors, or the
         * location provider gone quiet — and cleared by the next one. The screens say so
         * rather than showing the last position as if it were current.
         */
        val gpsQuietSince: Long? = null,
        /** What kind of drive, in which vehicle, as words: "Personal · Ann's car". */
        val driveLabel: String? = null,
    ) : TrackingStatus {
        val isPaused: Boolean get() = pausedAt != null
    }
}

/**
 * Live tracking state shared between [TrackingService], receivers and the UI.
 * Lives in-process: if the service is running, the process is alive and this is accurate.
 */
object TrackingStateHolder {
    private val _status = MutableStateFlow<TrackingStatus>(TrackingStatus.Idle)
    val status: StateFlow<TrackingStatus> = _status.asStateFlow()

    val isRecording: Boolean get() = _status.value is TrackingStatus.Recording

    val isPaused: Boolean get() = (_status.value as? TrackingStatus.Recording)?.isPaused == true

    fun set(status: TrackingStatus) {
        _status.value = status
    }

    fun updateRecording(block: (TrackingStatus.Recording) -> TrackingStatus.Recording) {
        _status.update { current -> if (current is TrackingStatus.Recording) block(current) else current }
    }
}
