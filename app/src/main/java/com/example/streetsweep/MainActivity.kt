package com.example.streetsweep

import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.lifecycleScope
import com.example.streetsweep.ui.theme.StreetSweepTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Long enough for the logo to register as the app opening rather than as a flicker.
 * Reading the settings takes far less than this, so in practice this is what decides
 * how long the splash is up.
 */
private const val SPLASH_MINIMUM_MS = 750L

/** If the first settings read ever stalls, show the app anyway rather than hold the splash. */
private const val SPLASH_GIVE_UP_MS = 4_000L

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)

        // Hold the splash until the saved settings are actually in hand, so the first frame
        // is the real thing instead of defaults that correct themselves a moment later.
        var ready = false
        splash.setKeepOnScreenCondition { !ready }
        val startedAt = SystemClock.uptimeMillis()
        lifecycleScope.launch {
            withTimeoutOrNull(SPLASH_GIVE_UP_MS) { appContainer.settings.current() }
            delay((SPLASH_MINIMUM_MS - (SystemClock.uptimeMillis() - startedAt)).coerceAtLeast(0))
            ready = true
        }
        // Fade rather than cut, and do it the same way on every version.
        splash.setOnExitAnimationListener { screen ->
            screen.view.animate()
                .alpha(0f)
                .setDuration(220L)
                .withEndAction { screen.remove() }
                .start()
        }

        enableEdgeToEdge()
        setContent {
            StreetSweepTheme {
                StreetSweepApp()
            }
        }
    }
}
