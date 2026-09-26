package com.example.streetsweep

import android.app.Application
import android.content.Context
import com.example.streetsweep.data.backup.BackupWorker
import com.example.streetsweep.data.osm.MatchRetryWorker
import com.example.streetsweep.tracking.Notifications
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class StreetSweepApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        Notifications.createChannels(this)
        // Catch up anything a lost signal left unmatched, and keep the backup schedule alive.
        MatchRetryWorker.schedule(this)
        MatchRetryWorker.enqueueNow(this)
        BackupWorker.schedule(this)
        // The upgrade to street coverage fills it in; this catches a database restored from
        // a backup, or anything else that arrived with segments but no coverage.
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            runCatching { container.coverageRepository.ensureWayCoverage() }
            // Areas with no figures kept yet (just upgraded, or new) get them now.
            runCatching { container.coverageRepository.fillMissingStats() }
        }
    }
}

/** Process-wide dependency container, reachable from any Context (activities, services, receivers). */
val Context.appContainer: AppContainer
    get() = (applicationContext as StreetSweepApplication).container
