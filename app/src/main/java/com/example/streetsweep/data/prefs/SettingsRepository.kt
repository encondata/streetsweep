package com.example.streetsweep.data.prefs

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.example.streetsweep.domain.TrackingMode
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

data class TrackingSettings(
    val mode: TrackingMode = TrackingMode.MANUAL,
    /** MAC address of the bonded Bluetooth device whose connection means "I'm in the car". */
    val bluetoothTriggerAddress: String? = null,
    val bluetoothTriggerName: String? = null,
    val androidAutoTriggerEnabled: Boolean = false,
    val snapToRoadsEnabled: Boolean = true,
    val valhallaUrl: String = DEFAULT_VALHALLA_URL,
    val overpassUrl: String = DEFAULT_OVERPASS_URL,
    /** How often to ask for a GPS fix while recording. The 50 ft spacing rule still applies. */
    val gpsIntervalSeconds: Int = DEFAULT_GPS_INTERVAL_SECONDS,
    /** Folder chosen for automatic backups, as a persisted document-tree URI. */
    val backupFolderUri: String? = null,
    /** How often to write a backup there: 0 = never, otherwise days. */
    val backupEveryDays: Int = 0,
    val lastBackupAt: Long = 0,
    /** Stop recording after this many idle minutes; 0 = never. */
    val autoStopIdleMinutes: Int = 0,
    val colourByRecency: Boolean = false,
    val inVehicleTriggerEnabled: Boolean = false,
    /** Address of the area builder's server. Defaults to the hosted one. */
    val portalUrl: String? = DEFAULT_PORTAL_URL,
    val portalToken: String? = null,
    val autoPushEnabled: Boolean = false,
    val lastPortalPushAt: Long = 0,
) {
    val gpsIntervalMs: Long get() = gpsIntervalSeconds * 1000L

    companion object {
        const val DEFAULT_GPS_INTERVAL_SECONDS = 15
        val GPS_INTERVAL_CHOICES = listOf(5, 10, 15, 30)
        val BACKUP_DAY_CHOICES = listOf(0, 1, 7)
        val IDLE_STOP_CHOICES = listOf(0, 15, 30, 60)
        const val DEFAULT_VALHALLA_URL = "https://valhalla1.openstreetmap.de"
        const val DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter"
        const val DEFAULT_PORTAL_URL = "https://streetsweep.hackspacelabs.com"
    }

    val hasAnyAutoTrigger: Boolean get() = bluetoothTriggerAddress != null || androidAutoTriggerEnabled
}

private val Context.settingsDataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

class SettingsRepository(context: Context) {
    private val store = context.applicationContext.settingsDataStore

    private object Keys {
        val MODE = stringPreferencesKey("tracking_mode")
        val BT_ADDRESS = stringPreferencesKey("bt_trigger_address")
        val BT_NAME = stringPreferencesKey("bt_trigger_name")
        val AA_ENABLED = booleanPreferencesKey("android_auto_trigger_enabled")
        val SNAP_ENABLED = booleanPreferencesKey("snap_to_roads_enabled")
        val VALHALLA_URL = stringPreferencesKey("valhalla_url")
        val OVERPASS_URL = stringPreferencesKey("overpass_url")
        val GPS_INTERVAL = intPreferencesKey("gps_interval_seconds")
        val BACKUP_FOLDER = stringPreferencesKey("backup_folder_uri")
        val BACKUP_DAYS = intPreferencesKey("backup_every_days")
        val LAST_BACKUP = androidx.datastore.preferences.core.longPreferencesKey("last_backup_at")
        val IDLE_STOP = intPreferencesKey("auto_stop_idle_minutes")
        val RECENCY = booleanPreferencesKey("colour_by_recency")
        val IN_VEHICLE = booleanPreferencesKey("in_vehicle_trigger")
        val PORTAL_URL = stringPreferencesKey("portal_url")
        val PORTAL_TOKEN = stringPreferencesKey("portal_token")
        val AUTO_PUSH = booleanPreferencesKey("portal_auto_push")
        val LAST_PUSH = androidx.datastore.preferences.core.longPreferencesKey("portal_last_push_at")
    }

    val settings: Flow<TrackingSettings> = store.data.map { p ->
        TrackingSettings(
            mode = p[Keys.MODE]?.let { m -> TrackingMode.entries.firstOrNull { it.name == m } } ?: TrackingMode.MANUAL,
            bluetoothTriggerAddress = p[Keys.BT_ADDRESS],
            bluetoothTriggerName = p[Keys.BT_NAME],
            androidAutoTriggerEnabled = p[Keys.AA_ENABLED] ?: false,
            snapToRoadsEnabled = p[Keys.SNAP_ENABLED] ?: true,
            valhallaUrl = p[Keys.VALHALLA_URL]?.takeIf { it.isNotBlank() } ?: TrackingSettings.DEFAULT_VALHALLA_URL,
            overpassUrl = p[Keys.OVERPASS_URL]?.takeIf { it.isNotBlank() } ?: TrackingSettings.DEFAULT_OVERPASS_URL,
            gpsIntervalSeconds = p[Keys.GPS_INTERVAL]?.takeIf { it in TrackingSettings.GPS_INTERVAL_CHOICES } ?: TrackingSettings.DEFAULT_GPS_INTERVAL_SECONDS,
            backupFolderUri = p[Keys.BACKUP_FOLDER],
            backupEveryDays = p[Keys.BACKUP_DAYS] ?: 0,
            lastBackupAt = p[Keys.LAST_BACKUP] ?: 0L,
            autoStopIdleMinutes = p[Keys.IDLE_STOP] ?: 0,
            colourByRecency = p[Keys.RECENCY] ?: false,
            inVehicleTriggerEnabled = p[Keys.IN_VEHICLE] ?: false,
            portalUrl = p[Keys.PORTAL_URL]?.takeIf { it.isNotBlank() } ?: TrackingSettings.DEFAULT_PORTAL_URL,
            portalToken = p[Keys.PORTAL_TOKEN]?.takeIf { it.isNotBlank() },
            autoPushEnabled = p[Keys.AUTO_PUSH] ?: false,
            lastPortalPushAt = p[Keys.LAST_PUSH] ?: 0L,
        )
    }

    suspend fun current(): TrackingSettings = settings.first()

    suspend fun setMode(mode: TrackingMode) = store.edit { it[Keys.MODE] = mode.name }

    suspend fun setBluetoothTrigger(address: String?, name: String?) = store.edit { p ->
        if (address == null) {
            p.remove(Keys.BT_ADDRESS)
            p.remove(Keys.BT_NAME)
        } else {
            p[Keys.BT_ADDRESS] = address
            if (name != null) p[Keys.BT_NAME] = name else p.remove(Keys.BT_NAME)
        }
    }

    suspend fun setAndroidAutoTrigger(enabled: Boolean) = store.edit { it[Keys.AA_ENABLED] = enabled }

    suspend fun setSnapToRoads(enabled: Boolean) = store.edit { it[Keys.SNAP_ENABLED] = enabled }

    suspend fun setValhallaUrl(url: String) = store.edit { it[Keys.VALHALLA_URL] = url.trim() }

    suspend fun setOverpassUrl(url: String) = store.edit { it[Keys.OVERPASS_URL] = url.trim() }

    suspend fun setGpsIntervalSeconds(seconds: Int) = store.edit { it[Keys.GPS_INTERVAL] = seconds }

    suspend fun setBackupFolder(uri: String?) = store.edit { p ->
        if (uri == null) p.remove(Keys.BACKUP_FOLDER) else p[Keys.BACKUP_FOLDER] = uri
    }

    suspend fun setBackupEveryDays(days: Int) = store.edit { it[Keys.BACKUP_DAYS] = days }

    suspend fun setLastBackupAt(at: Long) = store.edit { it[Keys.LAST_BACKUP] = at }

    suspend fun setAutoStopIdleMinutes(minutes: Int) = store.edit { it[Keys.IDLE_STOP] = minutes }

    suspend fun setColourByRecency(on: Boolean) = store.edit { it[Keys.RECENCY] = on }

    suspend fun setInVehicleTrigger(on: Boolean) = store.edit { it[Keys.IN_VEHICLE] = on }

    suspend fun setPortalUrl(url: String?) = store.edit { p ->
        val clean = url?.trim().orEmpty()
        if (clean.isEmpty()) p.remove(Keys.PORTAL_URL) else p[Keys.PORTAL_URL] = clean
    }

    suspend fun setPortalToken(value: String?) = store.edit { p ->
        val clean = value?.trim().orEmpty()
        if (clean.isEmpty()) p.remove(Keys.PORTAL_TOKEN) else p[Keys.PORTAL_TOKEN] = clean
    }

    suspend fun setAutoPush(on: Boolean) = store.edit { it[Keys.AUTO_PUSH] = on }

    suspend fun setLastPortalPushAt(at: Long) = store.edit { it[Keys.LAST_PUSH] = at }
}
