package com.example.streetsweep.data.prefs

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.example.streetsweep.domain.GuidanceMode
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
    /** What the map points you towards while you drive. */
    val guidanceMode: GuidanceMode = GuidanceMode.NEAREST,
    val inVehicleTriggerEnabled: Boolean = false,
    /** The StreetSweep server (v2). Defaults to the hosted one. */
    val serverUrl: String = DEFAULT_SERVER_URL,
    /** This phone's device token; null = signed out (the app asks you to sign in). */
    val serverToken: String? = null,
    /** Whose account it is, so the app can say so and spot a different person signing in. */
    val serverUserId: String? = null,
    val serverUserName: String? = null,
    val serverUserEmail: String? = null,
    /** Where the last sync got to (the server's cursor); null = sync everything. */
    val syncCursor: String? = null,
    val lastSyncAt: Long = 0,
    /** Whose coverage the map, figures and guidance show: one of your teams. Null = your own. */
    val coverageTeamId: String? = null,
    /** The drive type a new drive gets unless told otherwise: the last one used. */
    val lastDriveType: String? = null,
    /** Bluetooth car address → vehicle id, so a drive started by that car is in that vehicle. */
    val bluetoothVehicles: Map<String, String> = emptyMap(),
) {
    val gpsIntervalMs: Long get() = gpsIntervalSeconds * 1000L

    companion object {
        const val DEFAULT_GPS_INTERVAL_SECONDS = 2
        val GPS_INTERVAL_CHOICES = listOf(1, 2, 5, 15)
        val BACKUP_DAY_CHOICES = listOf(0, 1, 7)
        val IDLE_STOP_CHOICES = listOf(0, 15, 30, 60)
        const val DEFAULT_SERVER_URL = com.example.streetsweep.data.server.ServerClient.DEFAULT_URL
    }

    val signedIn: Boolean get() = !serverToken.isNullOrBlank()

    val hasAnyAutoTrigger: Boolean get() = bluetoothTriggerAddress != null || androidAutoTriggerEnabled
}

private val Context.settingsDataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

class SettingsRepository(context: Context) {
    private val store = context.applicationContext.settingsDataStore

    private object Keys {
        val MODE = stringPreferencesKey("tracking_mode")
        val GUIDANCE = stringPreferencesKey("guidance_mode")
        val BT_ADDRESS = stringPreferencesKey("bt_trigger_address")
        val BT_NAME = stringPreferencesKey("bt_trigger_name")
        val AA_ENABLED = booleanPreferencesKey("android_auto_trigger_enabled")
        val GPS_INTERVAL = intPreferencesKey("gps_interval_seconds")
        val BACKUP_FOLDER = stringPreferencesKey("backup_folder_uri")
        val BACKUP_DAYS = intPreferencesKey("backup_every_days")
        val LAST_BACKUP = androidx.datastore.preferences.core.longPreferencesKey("last_backup_at")
        val IDLE_STOP = intPreferencesKey("auto_stop_idle_minutes")
        val RECENCY = booleanPreferencesKey("colour_by_recency")
        val IN_VEHICLE = booleanPreferencesKey("in_vehicle_trigger")
        // v2's server. v1's portal_* keys are left unread: a v1 token means nothing to v2.
        val SERVER_URL = stringPreferencesKey("server_url")
        val SERVER_TOKEN = stringPreferencesKey("server_token")
        val SERVER_USER_ID = stringPreferencesKey("server_user_id")
        val SERVER_USER_NAME = stringPreferencesKey("server_user_name")
        val SERVER_USER_EMAIL = stringPreferencesKey("server_user_email")
        val SYNC_CURSOR = stringPreferencesKey("sync_cursor")
        val LAST_SYNC = androidx.datastore.preferences.core.longPreferencesKey("last_sync_at")
        val COVERAGE_TEAM = stringPreferencesKey("coverage_team")
        val LAST_DRIVE_TYPE = stringPreferencesKey("last_drive_type")
        val BT_VEHICLES = stringPreferencesKey("bluetooth_vehicles")
    }

    val settings: Flow<TrackingSettings> = store.data.map { p ->
        TrackingSettings(
            mode = p[Keys.MODE]?.let { m -> TrackingMode.entries.firstOrNull { it.name == m } } ?: TrackingMode.MANUAL,
            bluetoothTriggerAddress = p[Keys.BT_ADDRESS],
            bluetoothTriggerName = p[Keys.BT_NAME],
            androidAutoTriggerEnabled = p[Keys.AA_ENABLED] ?: false,
            gpsIntervalSeconds = p[Keys.GPS_INTERVAL]?.takeIf { it in TrackingSettings.GPS_INTERVAL_CHOICES } ?: TrackingSettings.DEFAULT_GPS_INTERVAL_SECONDS,
            backupFolderUri = p[Keys.BACKUP_FOLDER],
            backupEveryDays = p[Keys.BACKUP_DAYS] ?: 0,
            lastBackupAt = p[Keys.LAST_BACKUP] ?: 0L,
            autoStopIdleMinutes = p[Keys.IDLE_STOP] ?: 0,
            colourByRecency = p[Keys.RECENCY] ?: false,
            guidanceMode = p[Keys.GUIDANCE]?.let { g -> GuidanceMode.entries.firstOrNull { it.name == g } }
                ?: GuidanceMode.NEAREST,
            inVehicleTriggerEnabled = p[Keys.IN_VEHICLE] ?: false,
            serverUrl = p[Keys.SERVER_URL]?.takeIf { it.isNotBlank() } ?: TrackingSettings.DEFAULT_SERVER_URL,
            serverToken = p[Keys.SERVER_TOKEN]?.takeIf { it.isNotBlank() },
            serverUserId = p[Keys.SERVER_USER_ID],
            serverUserName = p[Keys.SERVER_USER_NAME]?.takeIf { it.isNotBlank() },
            serverUserEmail = p[Keys.SERVER_USER_EMAIL]?.takeIf { it.isNotBlank() },
            syncCursor = p[Keys.SYNC_CURSOR],
            lastSyncAt = p[Keys.LAST_SYNC] ?: 0L,
            coverageTeamId = p[Keys.COVERAGE_TEAM],
            lastDriveType = p[Keys.LAST_DRIVE_TYPE],
            bluetoothVehicles = p[Keys.BT_VEHICLES]?.let(::decodeMap).orEmpty(),
        )
    }

    suspend fun current(): TrackingSettings = settings.first()

    suspend fun setMode(mode: TrackingMode) = store.edit { it[Keys.MODE] = mode.name }

    suspend fun setGuidanceMode(mode: GuidanceMode) = store.edit { it[Keys.GUIDANCE] = mode.name }

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

    suspend fun setGpsIntervalSeconds(seconds: Int) = store.edit { it[Keys.GPS_INTERVAL] = seconds }

    suspend fun setBackupFolder(uri: String?) = store.edit { p ->
        if (uri == null) p.remove(Keys.BACKUP_FOLDER) else p[Keys.BACKUP_FOLDER] = uri
    }

    suspend fun setBackupEveryDays(days: Int) = store.edit { it[Keys.BACKUP_DAYS] = days }

    suspend fun setLastBackupAt(at: Long) = store.edit { it[Keys.LAST_BACKUP] = at }

    suspend fun setAutoStopIdleMinutes(minutes: Int) = store.edit { it[Keys.IDLE_STOP] = minutes }

    suspend fun setColourByRecency(on: Boolean) = store.edit { it[Keys.RECENCY] = on }

    suspend fun setInVehicleTrigger(on: Boolean) = store.edit { it[Keys.IN_VEHICLE] = on }

    suspend fun setServerUrl(url: String?) = store.edit { p ->
        val clean = url?.trim().orEmpty()
        if (clean.isEmpty()) p.remove(Keys.SERVER_URL) else p[Keys.SERVER_URL] = clean
    }

    /**
     * Signing in. A different person than last time starts the sync afresh and goes back
     * to their own coverage; the same person carries on where they were.
     */
    suspend fun setServerIdentity(token: String, userId: String, name: String?, email: String?) = store.edit { p ->
        if (p[Keys.SERVER_USER_ID] != userId) {
            p.remove(Keys.SYNC_CURSOR)
            p.remove(Keys.COVERAGE_TEAM)
        }
        p[Keys.SERVER_TOKEN] = token.trim()
        p[Keys.SERVER_USER_ID] = userId
        if (name.isNullOrBlank()) p.remove(Keys.SERVER_USER_NAME) else p[Keys.SERVER_USER_NAME] = name
        if (email.isNullOrBlank()) p.remove(Keys.SERVER_USER_EMAIL) else p[Keys.SERVER_USER_EMAIL] = email
    }

    /**
     * Signing out forgets the token. Drives already recorded stay on the phone (and go up
     * after the next sign-in): they are this device's own history.
     */
    suspend fun clearServerToken() = store.edit { it.remove(Keys.SERVER_TOKEN) }

    suspend fun setSyncCursor(cursor: String?, at: Long) = store.edit { p ->
        if (cursor == null) p.remove(Keys.SYNC_CURSOR) else p[Keys.SYNC_CURSOR] = cursor
        p[Keys.LAST_SYNC] = at
    }

    suspend fun setCoverageTeam(teamId: String?) = store.edit { p ->
        if (teamId == null) p.remove(Keys.COVERAGE_TEAM) else p[Keys.COVERAGE_TEAM] = teamId
    }

    suspend fun setLastDriveType(key: String) = store.edit { it[Keys.LAST_DRIVE_TYPE] = key }

    /** Link (or with null, unlink) a Bluetooth car to one of your vehicles. */
    suspend fun setBluetoothVehicle(address: String, vehicleId: String?) = store.edit { p ->
        val map = p[Keys.BT_VEHICLES]?.let(::decodeMap).orEmpty().toMutableMap()
        if (vehicleId == null) map.remove(address) else map[address] = vehicleId
        p[Keys.BT_VEHICLES] = org.json.JSONObject(map as Map<*, *>).toString()
    }
}

private fun decodeMap(json: String): Map<String, String> = runCatching {
    val o = org.json.JSONObject(json)
    o.keys().asSequence().associateWith { o.getString(it) }
}.getOrDefault(emptyMap())
