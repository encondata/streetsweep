package com.example.streetsweep

import android.app.Application
import android.content.Context
import com.example.streetsweep.data.backup.BackupWorker
import com.example.streetsweep.data.server.SyncWorker
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
        // v1's jobs (matching on the phone, the old portal) are gone; drop any still scheduled.
        androidx.work.WorkManager.getInstance(this).let { wm ->
            listOf("match-retry-now", "match-retry-daily", "portal-push", "area-stats-pull").forEach(wm::cancelUniqueWork)
        }
        SyncWorker.schedule(this)
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
