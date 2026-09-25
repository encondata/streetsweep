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

    // ---- the area builder's server ----

    fun setPortalUrl(url: String) = viewModelScope.launch { container.settings.setPortalUrl(url) }

    fun setPortalToken(value: String) = viewModelScope.launch { container.settings.setPortalToken(value) }

    /** Puts the address back to the hosted one, undoing a temporary address used for testing. */
    fun useHostedPortal() = viewModelScope.launch {
        container.settings.setPortalUrl(TrackingSettings.DEFAULT_PORTAL_URL)
    }

    fun setAutoPush(on: Boolean) = viewModelScope.launch { container.settings.setAutoPush(on) }

    fun testPortal() = work { "Reached " + container.portalClient.ping() }

    /**
     * Clearing the token brings the sign-in gate straight back: the app watches the same
     * setting, so there is nothing to navigate to. Drives already recorded stay on the
     * phone — they are this device's history, not the portal's copy of it.
     */
    fun signOutOfPortal() = viewModelScope.launch { container.settings.clearPortalIdentity() }

    /** Someone who chose to go without an account asking for the gate back. */
    fun signInAgain() = viewModelScope.launch { container.settings.setStandalone(false) }

    fun pullAreasFromPortal() = work {
        describe(container.portalSync.pullAreas())
            ?: "Nothing to change — the phone already matches every area on the server"
    }

    fun pushToPortal(full: Boolean) = work {
        val r = container.portalSync.push(full)
        "Sent ${r.edges} street segments, ${r.areas} areas and ${r.drives} drives" +
            (describe(r.pulled)?.let { ". $it" } ?: "")
    }

    /**
     * Queues street downloads for whatever changed and says what happened, or null when
     * nothing did. Used to take the last n areas and assume those were the new ones, which
     * was only true until anything else touched the list.
     */
    private fun describe(p: com.example.streetsweep.data.sync.AreaPull): String? {
        p.needStreets.forEach { com.example.streetsweep.data.osm.StreetDownloadWorker.enqueue(context, it) }
        val bits = buildList {
            if (p.added.isNotEmpty()) add("added ${p.added.size} ${if (p.added.size == 1) "area" else "areas"}")
            if (p.updated.isNotEmpty()) add("reshaped ${p.updated.size} to match the web")
            if (p.keptLocal.isNotEmpty()) {
                add("kept your own outline for ${p.keptLocal.joinToString()} " +
                    "because ${if (p.keptLocal.size == 1) "it was" else "they were"} redrawn on this phone")
            }
        }
        if (bits.isEmpty()) return null
        return bits.joinToString(", ").replaceFirstChar { it.uppercase() } +
            if (p.needStreets.isNotEmpty()) " — downloading their streets" else ""
    }

    fun importAreas(uri: Uri) = work {
        val text = context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
            ?: error("Could not open that file")
        val parsed = com.example.streetsweep.data.osm.AreaGeoJson.parse(text)
        val made = container.coverageRepository.importAreas(parsed)
        made.forEach { com.example.streetsweep.data.osm.StreetDownloadWorker.enqueue(context, it.id) }
        if (made.isEmpty()) "Nothing to import" else "Imported ${made.size} areas — downloading their streets"
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

    fun setSnapToRoads(enabled: Boolean) = viewModelScope.launch { container.settings.setSnapToRoads(enabled) }

    fun setGpsInterval(seconds: Int) = viewModelScope.launch { container.settings.setGpsIntervalSeconds(seconds) }

    fun setValhallaUrl(url: String) = viewModelScope.launch { container.settings.setValhallaUrl(url) }

    fun setOverpassUrl(url: String) = viewModelScope.launch { container.settings.setOverpassUrl(url) }

    fun selectBluetoothDevice(device: BluetoothDevices.Info?) = viewModelScope.launch {
        container.settings.setBluetoothTrigger(device?.address, device?.name)
    }

    fun loadDevices() = viewModelScope.launch {
        _devices.value = null
        _devices.value = BluetoothDevices.bonded(context)
    }
}
