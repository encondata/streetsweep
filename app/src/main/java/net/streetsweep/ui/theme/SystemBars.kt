package net.streetsweep.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

/**
 * Which status-bar icons to draw: dark on the app's light screens (the map is pale, and
 * white icons vanish against it), light over a dark picture such as the sign-in photo.
 * Put back to the theme's choice when the screen that asked goes away.
 */
@Composable
fun StatusBarIcons(darkIcons: Boolean) {
    val view = LocalView.current
    val systemDark = isSystemInDarkTheme()
    if (view.isInEditMode) return
    DisposableEffect(darkIcons, systemDark) {
        val window = (view.context as? Activity)?.window
        val bars = window?.let { WindowCompat.getInsetsController(it, view) }
        bars?.isAppearanceLightStatusBars = darkIcons
        onDispose { bars?.isAppearanceLightStatusBars = !systemDark }
    }
}
