package net.streetsweep.car

import android.content.Intent
import android.content.pm.ApplicationInfo
import androidx.car.app.CarAppService
import androidx.car.app.Screen
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator

/** Entry point Android Auto binds to. One session per head-unit connection. */
class StreetSweepCarAppService : CarAppService() {

    override fun createHostValidator(): HostValidator =
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            // Personal/sideloaded use: accept any host, including the Desktop Head Unit.
            HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
        } else {
            HostValidator.Builder(applicationContext)
                .addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample)
                .build()
        }

    override fun onCreateSession(): Session = object : Session() {
        private var screen: CoverageMapScreen? = null

        override fun onCreateScreen(intent: Intent): Screen =
            CoverageMapScreen(carContext).also { screen = it }

        /**
         * The car switching between day and night arrives here. Without it the map keeps
         * whichever it started in until something else happens to force a redraw, so the
         * screen stays white for the first stretch of a drive after dusk.
         */
        override fun onCarConfigurationChanged(newConfiguration: android.content.res.Configuration) {
            screen?.redraw()
        }
    }
}
