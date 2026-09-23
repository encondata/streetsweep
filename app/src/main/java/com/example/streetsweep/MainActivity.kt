package com.example.streetsweep

import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.example.streetsweep.ui.SplashLockup
import com.example.streetsweep.ui.theme.StreetSweepTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull

/**
 * How long the logo stays up after the launcher has handed over. Short of this it reads
 * as a flicker rather than as the app opening; much past it and it is in the way.
 */
private const val LOCKUP_MS = 900L

/** If the first settings read ever stalls, show the app anyway rather than hold the logo. */
private const val GIVE_UP_MS = 4_000L

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)

        // The launcher's splash leaves as soon as the first frame is ready, and the logo
        // below only starts its own clock then. Timed from onCreate instead, the whole
        // spell would be spent behind the splash and never actually seen.
        val handedOver = mutableStateOf(false)
        splash.setOnExitAnimationListener { screen ->
            screen.view.animate()
                .alpha(0f)
                .setDuration(280L)
                .withEndAction {
                    screen.remove()
                    handedOver.value = true
                }
                .start()
        }

        enableEdgeToEdge()
        setContent {
            StreetSweepTheme {
                val revealed by handedOver
                var showLogo by remember { mutableStateOf(true) }
                LaunchedEffect(revealed) {
                    if (!revealed) return@LaunchedEffect
                    val from = SystemClock.uptimeMillis()
                    // Real work, not a timer: hold until the saved settings are in hand, so
                    // the first screen is the real thing rather than defaults that correct
                    // themselves a moment later.
                    withTimeoutOrNull(GIVE_UP_MS) { appContainer.settings.current() }
                    delay((LOCKUP_MS - (SystemClock.uptimeMillis() - from)).coerceAtLeast(0))
                    showLogo = false
                }
                Box(Modifier.fillMaxSize()) {
                    StreetSweepApp()
                    SplashLockup(visible = showLogo, revealed = revealed)
                }
            }
        }
    }
}
