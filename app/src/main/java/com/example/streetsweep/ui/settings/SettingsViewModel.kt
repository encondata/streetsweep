package com.example.streetsweep.ui.settings

import android.content.Context
import android.content.Intent
import android.net.Uri
import com.example.streetsweep.data.backup.BackupManager
import com.example.streetsweep.data.backup.BackupWorker
import com.example.streetsweep.tracking.auto.VehicleActivityTrigger
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.streetsweep.AppContainer
import com.example.streetsweep.data.prefs.TrackingSettings
import com.example.streetsweep.domain.TrackingMode
import com.example.streetsweep.tracking.auto.BluetoothDevices
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class SettingsViewModel(private val container: AppContainer, private val context: Context) : ViewModel() {
    val settings: StateFlow<TrackingSettings> = container.settings.settings
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), TrackingSettings())

    private val _devices = MutableStateFlow<List<BluetoothDevices.Info>?>(null)
    /** null = not loaded yet. */
    val devices: StateFlow<List<BluetoothDevices.Info>?> = _devices

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy
    /** Set once a restore has landed; the process must restart before Room reopens the file. */
    private val _restartNeeded = MutableStateFlow(false)
    val restartNeeded: StateFlow<Boolean> = _restartNeeded

    fun clearMessage() { _message.value = null }

    fun setMode(mode: TrackingMode) = viewModelScope.launch {
        container.settings.setMode(mode)
        VehicleActivityTrigger.sync(context)
    }

    fun setAndroidAuto(enabled: Boolean) = viewModelScope.launch { container.settings.setAndroidAutoTrigger(enabled) }

    fun setInVehicle(enabled: Boolean) = viewModelScope.launch {
        container.settings.setInVehicleTrigger(enabled)
        VehicleActivityTrigger.sync(context)
    }

    fun setAutoStopIdleMinutes(minutes: Int) = viewModelScope.launch { container.settings.setAutoStopIdleMinutes(minutes) }

    fun setColourByRecency(on: Boolean) = viewModelScope.launch { container.settings.setColourByRecency(on) }

    // ---- backup and export ----

    private inline fun work(crossinline block: suspend () -> String) = viewModelScope.launch {
        if (_busy.value) {
            _message.value = "Still finishing the last one"
            return@launch
        }
        _busy.value = true
        _message.value = try {
            block()
        } catch (e: Exception) {
            "Failed: ${e.message}"
        } finally {
            _busy.value = false
        }
    }

    fun backupTo(uri: Uri) = work {
        val bytes = context.contentResolver.openOutputStream(uri)?.use { out ->
            container.backupManager.writeDatabaseBackup(out)
        } ?: error("Could not open that file")
        "Backed up ${bytes / 1024} KB"
    }

    fun exportGpx(uri: Uri) = work {
        context.contentResolver.openOutputStream(uri)?.use { container.backupManager.writeGpx(it) }
            ?: error("Could not open that file")
        "Drives exported as GPX"
    }

    fun exportGeoJson(uri: Uri) = work {
        context.contentResolver.openOutputStream(uri)?.use { container.backupManager.writeGeoJson(it) }
            ?: error("Could not open that file")
        "Coverage exported as GeoJSON"
    }

    // ---- the StreetSweep server (v2) ----

    val teams: StateFlow<List<com.example.streetsweep.data.db.TeamEntity>> = container.database.serverDao().observeTeams()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    val vehicles: StateFlow<List<com.example.streetsweep.data.db.VehicleEntity>> = container.database.serverDao().observeVehicles()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    /** Drives recorded here that the server doesn't have yet (the v1 history, at first). */
    val pendingUploads: StateFlow<Int> = container.trackRepository.observePendingUploadCount()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0)

    fun setServerUrl(url: String) = viewModelScope.launch { container.settings.setServerUrl(url) }

    /** Puts the address back to the hosted one, undoing a temporary address used for testing. */
    fun useHostedServer() = viewModelScope.launch { container.settings.setServerUrl(null) }

    /**
     * Clearing the token brings the sign-in gate straight back: the app watches the same
     * setting, so there is nothing to navigate to. Drives already recorded stay on the
     * phone, and go up after the next sign-in.
     */
    fun signOut() = viewModelScope.launch { container.settings.clearServerToken() }

    fun syncNow() = work {
        val r = container.sync.sync()
        listOfNotNull(
            if (r.drivesUploaded > 0) "${r.drivesUploaded} ${if (r.drivesUploaded == 1) "drive" else "drives"} sent" else null,
            if (r.drivesWaiting > 0) "${r.drivesWaiting} still to send" else null,
            if (r.marksSent > 0) "${r.marksSent} street marks sent" else null,
            if (r.placesSent > 0) "${r.placesSent} places sent" else null,
            "${r.areas} ${if (r.areas == 1) "area" else "areas"} up to date",
        ).joinToString(" · ")
    }

    /** Whose coverage the map, figures and guidance show. */
    fun showTeam(teamId: String) = work {
        container.sync.selectTeam(teamId)
        "Showing ${teams.value.firstOrNull { it.id == teamId }?.let { if (it.isPersonal) "your own" else it.name + "'s" } ?: "that team's"} coverage"
    }

    /** The car whose Bluetooth starts drives is this vehicle (or, with null, no particular one). */
    fun linkBluetoothVehicle(vehicleId: String?) = viewModelScope.launch {
        settings.value.bluetoothTriggerAddress?.let { container.settings.setBluetoothVehicle(it, vehicleId) }
    }

    fun restoreFrom(uri: Uri) = work {
        val input = context.contentResolver.openInputStream(uri) ?: error("Could not open that file")
        when (val r = input.use { container.backupManager.restoreDatabase(it) }) {
            is BackupManager.RestoreResult.Ok -> {
                _restartNeeded.value = true
                "Restored ${r.drives} drives and ${r.areas} areas"
            }
            is BackupManager.RestoreResult.Rejected -> "Not restored: ${r.reason}"
        }
    }

    fun chooseBackupFolder(uri: Uri) = viewModelScope.launch {
        runCatching {
            context.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        }
        container.settings.setBackupFolder(uri.toString())
        if (container.settings.current().backupEveryDays > 0) BackupWorker.schedule(context)
        _message.value = "Automatic backups will be written here"
    }

    fun setBackupEveryDays(days: Int) = viewModelScope.launch {
        container.settings.setBackupEveryDays(days)
        if (days > 0) BackupWorker.schedule(context) else BackupWorker.cancel(context)
    }

    /** Room still holds the replaced file open, so the process has to go. */
    fun restartApp() {
        val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
        if (intent != null) context.startActivity(intent)
        Runtime.getRuntime().exit(0)
    }

    fun setGpsInterval(seconds: Int) = viewModelScope.launch { container.settings.setGpsIntervalSeconds(seconds) }

    fun selectBluetoothDevice(device: BluetoothDevices.Info?) = viewModelScope.launch {
        container.settings.setBluetoothTrigger(device?.address, device?.name)
    }

    fun loadDevices() = viewModelScope.launch {
        _devices.value = null
        _devices.value = BluetoothDevices.bonded(context)
    }
}
