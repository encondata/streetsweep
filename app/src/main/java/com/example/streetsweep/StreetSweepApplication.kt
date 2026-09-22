package com.example.streetsweep

import android.app.Application
import android.content.Context
import com.example.streetsweep.data.backup.BackupWorker
import com.example.streetsweep.data.osm.MatchRetryWorker
import com.example.streetsweep.tracking.Notifications

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
    }
}

/** Process-wide dependency container, reachable from any Context (activities, services, receivers). */
val Context.appContainer: AppContainer
    get() = (applicationContext as StreetSweepApplication).container
