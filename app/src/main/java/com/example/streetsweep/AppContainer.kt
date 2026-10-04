package com.example.streetsweep

import android.content.Context
import com.example.streetsweep.data.CoverageRepository
import com.example.streetsweep.data.RouteState
import com.example.streetsweep.data.TrackRepository
import com.example.streetsweep.data.backup.BackupManager
import com.example.streetsweep.data.db.AppDatabase
import com.example.streetsweep.data.prefs.SettingsRepository
import com.example.streetsweep.data.server.ProvisionalMatcher
import com.example.streetsweep.data.server.ServerClient
import com.example.streetsweep.data.server.SyncRepository
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationServices
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** Hand-wired dependencies. Small enough that a DI framework would be more ceremony than help. */
class AppContainer(context: Context) {
    private val appContext = context.applicationContext
    /** For starting background work from places that have no Context of their own (view models). */
    val context: Context get() = appContext

    /** Scope for work that must outlive the component that started it (e.g. matching after a session ends). */
    val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val database: AppDatabase by lazy { AppDatabase.build(appContext) }
    val trackRepository: TrackRepository by lazy { TrackRepository(database) }
    val coverageRepository: CoverageRepository by lazy { CoverageRepository(database) }

    /** The route being followed, shared by the phone screen and the car screen. */
    val route: RouteState by lazy { RouteState() }
    val settings: SettingsRepository by lazy { SettingsRepository(appContext) }
    val backupManager: BackupManager by lazy { BackupManager(appContext, database, trackRepository, coverageRepository) }

    /** The StreetSweep server (v2): the record for streets, areas, coverage and marks. */
    val server: ServerClient by lazy { ServerClient({ settings.current().serverUrl }, { settings.current().serverToken }) }
    val sync: SyncRepository by lazy { SyncRepository(appContext, database, server, settings, trackRepository, coverageRepository) }
    /** The phone's own quick guess at what a drive covered, until the server's match arrives. */
    val provisional: ProvisionalMatcher by lazy { ProvisionalMatcher(database, trackRepository, coverageRepository) }

    val fusedLocationClient: FusedLocationProviderClient by lazy {
        LocationServices.getFusedLocationProviderClient(appContext)
    }

    // Last in the class, so every property above is set up before it runs. Map tiles come
    // from the server's cache, with this phone's token.
    init {
        applicationScope.launch {
            settings.settings.collect { com.example.streetsweep.ui.map.MapTiles.update(it.serverUrl, it.serverToken) }
        }
    }
}
