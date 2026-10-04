package com.example.streetsweep.tracking

import com.example.streetsweep.AppContainer
import com.example.streetsweep.data.server.DriveDefaults

/**
 * Changing what kind of drive this is, and in which vehicle, from the phone's recording
 * card or the car screen. While recording it changes the drive (until it goes up); either
 * way the type becomes the default for the next drive.
 */
object DriveChoice {
    /** The type in force: the recording drive's, else the default a new drive would get. */
    suspend fun currentType(container: AppContainer): String {
        val id = (TrackingStateHolder.status.value as? TrackingStatus.Recording)?.sessionId
        val session = id?.let { container.trackRepository.getSession(it) }
        return session?.driveTypeKey ?: container.settings.current().lastDriveType ?: DriveDefaults.PERSONAL
    }

    suspend fun setType(container: AppContainer, type: String) {
        val id = (TrackingStateHolder.status.value as? TrackingStatus.Recording)?.sessionId
        val vehicle = id?.let { container.trackRepository.getSession(it)?.vehicleId }
        set(container, type, vehicle)
    }

    suspend fun set(container: AppContainer, type: String, vehicleId: String?) {
        container.settings.setLastDriveType(type)
        val id = (TrackingStateHolder.status.value as? TrackingStatus.Recording)?.sessionId ?: return
        container.trackRepository.setDriveDetails(id, type, vehicleId)
        val label = DriveDefaults.label(container.database, type, vehicleId)
        // The notification picks the new words up at the next fix.
        TrackingStateHolder.updateRecording { it.copy(driveLabel = label) }
    }
}
