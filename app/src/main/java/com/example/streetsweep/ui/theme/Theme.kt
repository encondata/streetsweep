package com.example.streetsweep.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext

private val DarkColorScheme = darkColorScheme(
    primary = BrandGreenDark,
    onPrimary = OnBrandGreenDark,
    primaryContainer = BrandGreenContainerDark,
    onPrimaryContainer = OnBrandGreenContainerDark,
    secondary = BrandNavyDark,
    onSecondary = OnBrandNavyDark,
    secondaryContainer = BrandNavyContainerDark,
    onSecondaryContainer = OnBrandNavyContainerDark,
    tertiary = BrandAmberDark,
    onTertiary = OnBrandAmberDark,
    tertiaryContainer = BrandAmberContainerDark,
    onTertiaryContainer = OnBrandAmberContainerDark,
    background = DarkBackground,
    onBackground = OnDarkBackground,
    surface = DarkSurface,
    onSurface = OnDarkBackground,
    surfaceVariant = DarkSurfaceVariant,
    onSurfaceVariant = OnDarkSurfaceVariant,
    outline = DarkOutline,
    outlineVariant = DarkOutlineVariant,
    surfaceDim = DarkSurfaceDim,
    surfaceBright = DarkSurfaceBright,
    surfaceContainerLowest = DarkContainerLowest,
    surfaceContainerLow = DarkContainerLow,
    surfaceContainer = DarkContainer,
    surfaceContainerHigh = DarkContainerHigh,
    surfaceContainerHighest = DarkContainerHighest,
    inverseSurface = DarkInverseSurface,
    inverseOnSurface = DarkInverseOnSurface,
    inversePrimary = BrandGreen,
)

private val LightColorScheme = lightColorScheme(
    primary = BrandGreen,
    onPrimary = OnBrandGreen,
    primaryContainer = BrandGreenContainer,
    onPrimaryContainer = OnBrandGreenContainer,
    secondary = BrandNavy,
    onSecondary = OnBrandNavy,
    secondaryContainer = BrandNavyContainer,
    onSecondaryContainer = OnBrandNavyContainer,
    tertiary = BrandAmber,
    onTertiary = OnBrandAmber,
    tertiaryContainer = BrandAmberContainer,
    onTertiaryContainer = OnBrandAmberContainer,
    background = LightBackground,
    onBackground = OnLightBackground,
    surface = LightSurface,
    onSurface = OnLightBackground,
    surfaceVariant = LightSurfaceVariant,
    onSurfaceVariant = OnLightSurfaceVariant,
    outline = LightOutline,
    outlineVariant = LightOutlineVariant,
    surfaceDim = LightSurfaceDim,
    surfaceBright = LightSurfaceBright,
    surfaceContainerLowest = LightContainerLowest,
    surfaceContainerLow = LightContainerLow,
    surfaceContainer = LightContainer,
    surfaceContainerHigh = LightContainerHigh,
    surfaceContainerHighest = LightContainerHighest,
    inverseSurface = LightInverseSurface,
    inverseOnSurface = LightInverseOnSurface,
    inversePrimary = BrandGreenDark,
)

@Composable
fun StreetSweepTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    // Wallpaper-derived colour is available on Android 12+, but it throws the brand away:
    // the app would come out lilac on one phone and pink on the next, and the map's
    // green-means-driven reading would no longer match the rest of the screen.
    dynamicColor: Boolean = false,
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColorScheme
        else -> LightColorScheme
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = Typography,
        content = content,
    )
}
