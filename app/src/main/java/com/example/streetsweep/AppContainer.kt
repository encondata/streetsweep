package com.example.streetsweep

import android.content.Context
import com.example.streetsweep.data.CoverageRepository
import com.example.streetsweep.data.RouteState
import com.example.streetsweep.data.TrackRepository
import com.example.streetsweep.data.backup.BackupManager
import com.example.streetsweep.data.db.AppDatabase
import com.example.streetsweep.data.osm.OverpassClient
import com.example.streetsweep.data.osm.RoadMatcher
import com.example.streetsweep.data.osm.ValhallaClient
import com.example.streetsweep.data.prefs.SettingsRepository
import com.example.streetsweep.data.sync.PortalClient
import com.example.streetsweep.data.sync.PortalSync
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationServices
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** Hand-wired dependencies. Small enough that a DI framework would be more ceremony than help. */
class AppContainer(context: Context) {
    private val appContext = context.applicationContext

    /** Scope for work that must outlive the component that started it (e.g. matching after a session ends). */
    val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val database: AppDatabase by lazy { AppDatabase.build(appContext) }
    val trackRepository: TrackRepository by lazy { TrackRepository(database) }
    val coverageRepository: CoverageRepository by lazy {
        CoverageRepository(database).also { repo ->
            // Signed in to a server: its figures are the record, and this phone leaves them be.
            repo.serverBacked = { settings.current().let { !it.portalUrl.isNullOrBlank() && !it.portalToken.isNullOrBlank() } }
        }
    }

    /** The route being followed, shared by the phone screen and the car screen. */
    val route: RouteState by lazy { RouteState() }
    val settings: SettingsRepository by lazy { SettingsRepository(appContext) }
    val valhalla: ValhallaClient by lazy { ValhallaClient { settings.current().valhallaUrl } }
    val overpass: OverpassClient by lazy { OverpassClient { settings.current().overpassUrl } }
    val roadMatcher: RoadMatcher by lazy { RoadMatcher(valhalla, trackRepository, coverageRepository) }
    val backupManager: BackupManager by lazy { BackupManager(appContext, database, trackRepository, coverageRepository) }
    val portalClient: PortalClient by lazy {
        PortalClient({ settings.current().portalUrl }, { settings.current().portalToken })
    }
    val portalSync: PortalSync by lazy {
        PortalSync(portalClient, trackRepository, coverageRepository, settings).also {
            it.afterPush = { com.example.streetsweep.data.sync.AreaStatsPullWorker.enqueue(appContext) }
        }
    }
    val fusedLocationClient: FusedLocationProviderClient by lazy {
        LocationServices.getFusedLocationProviderClient(appContext)
    }
}
